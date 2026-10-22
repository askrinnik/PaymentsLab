using MassTransit;
using MassTransit.MongoDbIntegration;
using MongoDB.Driver;
using MongoDB.Driver.Linq;
using Payments.Api.Domain;
using Payments.Api.Messaging;

namespace Payments.Api.Payments;

public enum CreateOutcome
{
    Created, // a new payment: 201
    Replayed, // the same key and the same request again: 200 with the stored payment
    KeyReused, // the same key with a different request: 422
}

public sealed record CreateResult(CreateOutcome Outcome, Payment Payment);

public enum CaptureOutcome
{
    Captured,
    NotFound,
    VersionMismatch, // someone changed the payment since the client read it: 412
    InvalidStatus, // the payment cannot be captured in its current status: 409
}

public sealed record CaptureResult(CaptureOutcome Outcome, Payment? Payment);

/// <summary>
/// All MongoDB access for payments. Endpoints translate the results into HTTP responses.
/// Scoped: MongoDbContext and IPublishEndpoint (the outbox) are scoped to one HTTP request.
/// </summary>
public sealed class PaymentService(
    IMongoCollection<Payment> payments, MongoDbContext mongoContext, IPublishEndpoint publishEndpoint, TimeProvider clock)
{
    private static readonly PaymentStatus[] CapturableStatuses = [PaymentStatus.Pending, PaymentStatus.Authorized];

    /// <summary>
    /// Insert first; on duplicate key error 11000 return the stored payment. The unique index decides, not a
    /// "find, then insert" check in code, which two concurrent requests could both pass.
    /// </summary>
    public async Task<CreateResult> CreateAsync(string idempotencyKey, CreatePaymentRequest request, CancellationToken ct)
    {
        var payment = new Payment
        {
            Id = Guid.NewGuid(),
            MerchantId = request.MerchantId,
            CustomerId = request.CustomerId,
            IdempotencyKey = idempotencyKey,
            Amount = request.Amount,
            Currency = request.Currency,
            Status = PaymentStatus.Pending,
            CreatedAt = UtcNow(),
            Version = 0,
        };

        try
        {
            await payments.InsertOneAsync(payment, cancellationToken: ct);
            return new CreateResult(CreateOutcome.Created, payment);
        }
        catch (MongoWriteException e) when (e.WriteError.Category == ServerErrorCategory.DuplicateKey)
        {
            var stored = await payments.Find(p => p.IdempotencyKey == idempotencyKey).FirstAsync(ct);
            var outcome = IsSameRequest(stored, request) ? CreateOutcome.Replayed : CreateOutcome.KeyReused;
            return new CreateResult(outcome, stored);
        }
    }

    public async Task<Payment?> GetAsync(Guid id, CancellationToken ct) =>
        await payments.Find(p => p.Id == id).FirstOrDefaultAsync(ct);

    /// <summary>
    /// Captures the payment and publishes <see cref="PaymentCaptured"/> in ONE MongoDB transaction:
    ///   1. FindOneAndUpdate: status, new attempt and version. The filter contains the version the client read
    ///      (optimistic concurrency) and the statuses that allow a capture.
    ///   2. Publish: with the bus outbox this is an insert into the outbox collection, with the same session.
    /// Either both writes are committed or none. Without the transaction a crash between them would lose the event
    /// (or, in the other order, publish an event for a capture that never happened).
    /// </summary>
    public async Task<CaptureResult> CaptureAsync(Guid id, int expectedVersion, string provider, CancellationToken ct)
    {
        var filter = Builders<Payment>.Filter;
        var update = Builders<Payment>.Update;
        var capturedAt = UtcNow();

        var captured = await InTransactionAsync(async session =>
        {
            var payment = await payments.FindOneAndUpdateAsync(
                session,
                filter.Eq(p => p.Id, id)
                    & filter.Eq(p => p.Version, expectedVersion)
                    & filter.In(p => p.Status, CapturableStatuses),
                update
                    .Set(p => p.Status, PaymentStatus.Captured)
                    .Push(p => p.Attempts, new Attempt(capturedAt, provider, AttemptResult.Ok))
                    .Inc(p => p.Version, 1),
                new FindOneAndUpdateOptions<Payment> { ReturnDocument = ReturnDocument.After },
                ct);

            if (payment is not null)
            {
                // Not sent to RabbitMQ here: the bus outbox inserts it into the outbox collection with this session.
                await publishEndpoint.Publish(
                    new PaymentCaptured(payment.Id, payment.MerchantId, payment.Amount, payment.Currency, capturedAt), ct);
            }

            return payment;
        }, ct);

        if (captured is not null) return new CaptureResult(CaptureOutcome.Captured, captured);

        // Nothing matched. Read the payment once more to tell the client why.
        var current = await GetAsync(id, ct);
        if (current is null) return new CaptureResult(CaptureOutcome.NotFound, null);
        if (current.Version != expectedVersion) return new CaptureResult(CaptureOutcome.VersionMismatch, current);
        return new CaptureResult(CaptureOutcome.InvalidStatus, current);
    }

    /// <summary>Newest payments of a merchant. Served by the index { merchantId: 1, createdAt: -1 }.</summary>
    public Task<List<Payment>> GetMerchantHistoryAsync(
        string merchantId, DateTime? from, DateTime? to, int limit, CancellationToken ct)
    {
        // The LINQ provider translates this into find({ merchantId, createdAt: { $gte, $lt } }).sort(...).limit(...).
        var query = payments.AsQueryable().Where(p => p.MerchantId == merchantId);
        if (from is not null) query = query.Where(p => p.CreatedAt >= from);
        if (to is not null) query = query.Where(p => p.CreatedAt < to);
        return query.OrderByDescending(p => p.CreatedAt).Take(limit).ToListAsync(ct);
    }

    /// <summary>Captured amount per currency: $match -> $group -> $sort.</summary>
    public Task<List<CurrencyTotal>> GetMerchantTotalsAsync(string merchantId, CancellationToken ct) =>
        payments.Aggregate()
            .Match(p => p.MerchantId == merchantId && p.Status == PaymentStatus.Captured)
            .Group(p => p.Currency, g => new CurrencyTotal(g.Key, g.Sum(p => p.Amount), g.Count()))
            .SortByDescending(t => t.Total)
            .ToListAsync(ct);

    private const int MaxTransactionAttempts = 10;

    /// <summary>
    /// Runs <paramref name="work"/> in a MongoDB transaction and commits it. SQL Server: BEGIN TRAN ... COMMIT with a
    /// retry loop for deadlocks.
    ///
    /// The driver has session.WithTransactionAsync for this, but the MassTransit outbox cannot use it: the outbox needs
    /// the transaction to be started by MassTransit's MongoDbContext.BeginTransaction, which also sets the
    /// TransactionId the outbox stores with each message. So this method does what WithTransactionAsync does:
    /// on an error labelled TransientTransactionError (for example a write conflict with a concurrent capture of the
    /// same payment) it aborts and runs the whole transaction again, after a short random delay.
    /// </summary>
    private async Task<T> InTransactionAsync<T>(Func<IClientSessionHandle, Task<T>> work, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            await mongoContext.BeginTransaction(ct);
            try
            {
                var result = await work(mongoContext.Session ?? throw new InvalidOperationException("No MongoDB session."));
                await mongoContext.CommitTransaction(ct);
                return result;
            }
            catch (MongoException e) when (e.HasErrorLabel("TransientTransactionError") && attempt < MaxTransactionAttempts)
            {
                await mongoContext.AbortTransaction(ct);
                await Task.Delay(Random.Shared.Next(5, 20 * attempt), ct); // let the other transaction finish
            }
            catch
            {
                await mongoContext.AbortTransaction(ct);
                throw;
            }
        }
    }

    private static bool IsSameRequest(Payment stored, CreatePaymentRequest request) =>
        stored.MerchantId == request.MerchantId
        && stored.CustomerId == request.CustomerId
        && stored.Amount == request.Amount // decimal equality: 10.5 == 10.50
        && stored.Currency == request.Currency;

    // MongoDB stores dates with millisecond precision. Truncate here, so the 201 response shows the same
    // createdAt as every later read.
    private DateTime UtcNow()
    {
        var now = clock.GetUtcNow().UtcDateTime;
        return new DateTime(now.Ticks - now.Ticks % TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);
    }
}
