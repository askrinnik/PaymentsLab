using MongoDB.Driver;
using Payments.Api.Domain;

namespace Payments.Api.Mongo;

/// <summary>
/// Creates the indexes at startup. createIndexes does nothing for an index that already exists with the same options,
/// so this is safe on every start.
/// </summary>
public sealed class MongoIndexInitializer(IMongoCollection<Payment> payments, ILogger<MongoIndexInitializer> logger)
    : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var keys = Builders<Payment>.IndexKeys;
        var indexes = new[]
        {
            // Idempotency: one payment per key. A retry fails with duplicate key error 11000.
            new CreateIndexModel<Payment>(
                keys.Ascending(p => p.IdempotencyKey),
                new CreateIndexOptions { Name = "ux_idempotencyKey", Unique = true }),
            // Merchant history: equality on merchantId, sort by createdAt (ESR rule).
            new CreateIndexModel<Payment>(
                keys.Ascending(p => p.MerchantId).Descending(p => p.CreatedAt),
                new CreateIndexOptions { Name = "ix_merchantId_createdAt" }),
        };

        var names = await payments.Indexes.CreateManyAsync(indexes, cancellationToken);
        logger.LogInformation("MongoDB indexes ensured: {Indexes}", string.Join(", ", names));
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
