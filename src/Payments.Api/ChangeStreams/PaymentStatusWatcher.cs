using MongoDB.Bson;
using MongoDB.Driver;
using Payments.Api.Domain;
using Payments.Api.Mongo;

namespace Payments.Api.ChangeStreams;

/// <summary>
/// Follows the change stream of the <c>payments</c> collection and records every status change.
///
/// A change stream is MongoDB's change data capture (SQL Server: CDC or Change Tracking). The server reads its
/// replication log (the oplog), so it works only on a replica set - one reason MongoDB runs as rs0 here.
/// It sees every write, whoever made it: the driver endpoints, the /ef endpoints, mongosh, Compass.
/// Compare with the outbox (step 4): the outbox sends the events the code decided to publish; a change stream
/// reports what really changed in the data.
///
///   payments ──write──► oplog ──change stream──► this watcher ─┬─► log line
///                                                              ├─► paymentStatusHistory (projection)
///                                                              └─► changeStreamCheckpoints (resume token)
///
/// After each event the watcher stores the event's resume token. After a restart it continues right after that
/// event (ResumeAfter), so changes made while it was stopped are not lost. An event can be processed twice (crash
/// after the projection write, before the token write), so the projection write is idempotent.
/// </summary>
public sealed class PaymentStatusWatcher(IMongoDatabase database, ILogger<PaymentStatusWatcher> logger, string name)
    : BackgroundService
{
    public const string DefaultName = "payment-status-watcher";
    public const string HistoryCollection = "paymentStatusHistory";
    public const string CheckpointCollection = "changeStreamCheckpoints";
    private const int ChangeStreamHistoryLost = 286; // the oplog no longer contains the event of the resume token

    private readonly IMongoCollection<Payment> _payments = database.GetCollection<Payment>(MongoSetup.PaymentsCollection);
    private readonly IMongoCollection<PaymentStatusChange> _history = database.GetCollection<PaymentStatusChange>(HistoryCollection);
    private readonly IMongoCollection<BsonDocument> _checkpoints = database.GetCollection<BsonDocument>(CheckpointCollection);
    private readonly TaskCompletionSource _watching = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>Completes when the change stream is open: writes made after this moment will be seen.</summary>
    public Task Watching => _watching.Task;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await WatchAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (MongoCommandException e) when (e.Code == ChangeStreamHistoryLost)
            {
                // The watcher was stopped for so long that the oplog was overwritten. Events in between are lost;
                // a real system would rebuild the projection from the collection. Here: start again from now.
                logger.LogWarning("Resume token is too old, starting the change stream from now");
                await _checkpoints.DeleteOneAsync(new BsonDocument("_id", name), stoppingToken);
            }
            catch (Exception e)
            {
                // Network error, primary election and so on: wait and open the stream again from the last token.
                logger.LogError(e, "Change stream failed, reopening in 5 seconds");
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }
    }

    private async Task WatchAsync(CancellationToken ct)
    {
        var checkpoint = await _checkpoints.Find(new BsonDocument("_id", name)).FirstOrDefaultAsync(ct);
        var options = new ChangeStreamOptions { ResumeAfter = checkpoint?["resumeToken"].AsBsonDocument };

        // The server filters the events: only inserts, and updates that changed the field "status".
        var pipeline = new EmptyPipelineDefinition<ChangeStreamDocument<Payment>>().Match(new BsonDocument("$or", new BsonArray
        {
            new BsonDocument("operationType", "insert"),
            new BsonDocument
            {
                { "operationType", "update" },
                { "updateDescription.updatedFields.status", new BsonDocument("$exists", true) },
            },
        }));

        using var cursor = await _payments.WatchAsync(pipeline, options, ct);
        logger.LogInformation("Watching payments for status changes ({Start})", checkpoint is null ? "from now" : "resumed");
        _watching.TrySetResult();

        // MoveNextAsync waits on the server for new events (a tailable cursor); an empty batch is normal.
        while (await cursor.MoveNextAsync(ct))
        {
            foreach (var change in cursor.Current)
            {
                await RecordAsync(change, ct);
                await SaveResumeTokenAsync(change.ResumeToken, ct);
            }
        }
    }

    private async Task RecordAsync(ChangeStreamDocument<Payment> change, CancellationToken ct)
    {
        var paymentId = change.DocumentKey["_id"].AsBsonBinaryData.ToGuid();
        var (status, version) = change.OperationType == ChangeStreamOperationType.Insert
            ? (change.FullDocument.Status.ToString(), change.FullDocument.Version)
            : (change.UpdateDescription.UpdatedFields["status"].AsString,
               change.UpdateDescription.UpdatedFields.GetValue("version", -1).AsInt32);

        logger.LogInformation(
            "Change stream: payment {PaymentId} is {Status} (version {Version}, {Operation})",
            paymentId, status, version, change.OperationType);

        var record = new PaymentStatusChange
        {
            Id = $"{name}:{paymentId}:{version}",
            Watcher = name,
            PaymentId = paymentId,
            Status = status,
            Version = version,
            Operation = change.OperationType.ToString().ToLowerInvariant(),
            ChangedAt = change.WallTime,
        };
        await _history.ReplaceOneAsync(h => h.Id == record.Id, record, new ReplaceOptions { IsUpsert = true }, ct);
    }

    private Task SaveResumeTokenAsync(BsonDocument resumeToken, CancellationToken ct) =>
        _checkpoints.UpdateOneAsync(
            new BsonDocument("_id", name),
            new BsonDocument("$set", new BsonDocument { { "resumeToken", resumeToken }, { "savedAt", DateTime.UtcNow } }),
            new UpdateOptions { IsUpsert = true },
            ct);
}

public static class PaymentStatusWatcherSetup
{
    public static IServiceCollection AddPaymentStatusWatcher(this IServiceCollection services) =>
        services.AddHostedService(sp => new PaymentStatusWatcher(
            sp.GetRequiredService<IMongoDatabase>(),
            sp.GetRequiredService<ILogger<PaymentStatusWatcher>>(),
            PaymentStatusWatcher.DefaultName));
}
