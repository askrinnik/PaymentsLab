using MassTransit;
using Microsoft.EntityFrameworkCore;
using Payments.Api.Domain;
using Payments.Api.Messaging;
using Payments.Api.Payments;

namespace Payments.Api.EfCore;

/// <summary>
/// The same operations as <see cref="PaymentService"/>, written with the MongoDB EF Core provider.
/// Endpoints under /ef use it. Compare the two classes method by method: where EF Core needs a workaround, the
/// comment says so.
/// </summary>
public sealed class EfPaymentService(
    PaymentsDbContext db, IBus bus, TimeProvider clock, ILogger<EfPaymentService> logger) : IPaymentService
{
    /// <summary>
    /// Same idea as the driver: insert first, the unique index decides. The difference is only how the error arrives:
    /// SaveChanges throws the bulk write error of the driver (MongoBulkWriteException), not a single write error.
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
            CreatedAt = PaymentRules.UtcNow(clock),
            Version = 0,
        };

        db.Payments.Add(payment);
        try
        {
            await db.SaveChangesAsync(ct);
            return new CreateResult(CreateOutcome.Created, payment);
        }
        // Not DbUpdateException as with SQL Server: the provider lets the driver's MongoBulkWriteException through.
        // IsDuplicateKey also looks into inner exceptions, so a wrapped error would be recognized too.
        // Note: EF Core still logs this handled error as "fail: Microsoft.EntityFrameworkCore.Update"; the driver
        // version logs nothing for an expected retry.
        catch (Exception e) when (PaymentRules.IsDuplicateKey(e))
        {
            db.ChangeTracker.Clear(); // forget the payment that was not inserted
            var stored = await db.Payments.AsNoTracking().FirstAsync(p => p.IdempotencyKey == idempotencyKey, ct);
            var outcome = PaymentRules.IsSameRequest(stored, request) ? CreateOutcome.Replayed : CreateOutcome.KeyReused;
            return new CreateResult(outcome, stored);
        }
    }

    public Task<Payment?> GetAsync(Guid id, CancellationToken ct) =>
        db.Payments.AsNoTracking().FirstOrDefaultAsync(p => p.Id == id, ct);

    /// <summary>
    /// EF Core cannot send "$set + $push + $inc where version = v" as one command. It works like EF Core with
    /// SQL Server: read the entity, change it in memory, SaveChanges. Differences from the driver version:
    ///   - two round trips (read, then update) instead of one FindOneAndUpdate;
    ///   - the status rule is checked in C# on the data that was read; the concurrency token (version) protects
    ///     against a change between the read and the update;
    ///   - NO transactional outbox: SaveChanges uses its own session, and MassTransit's MongoDB outbox needs the
    ///     session of its own MongoDbContext; MassTransit's EF Core outbox supports relational databases only.
    ///     So the event is published AFTER SaveChanges. If the process stops between the two, the payment is
    ///     captured but PaymentCaptured is never published.
    /// </summary>
    public async Task<CaptureResult> CaptureAsync(Guid id, int expectedVersion, string provider, CancellationToken ct)
    {
        var payment = await db.Payments.FirstOrDefaultAsync(p => p.Id == id, ct);
        if (payment is null) return new CaptureResult(CaptureOutcome.NotFound, null);
        if (payment.Version != expectedVersion) return new CaptureResult(CaptureOutcome.VersionMismatch, payment);
        if (!PaymentRules.CapturableStatuses.Contains(payment.Status))
            return new CaptureResult(CaptureOutcome.InvalidStatus, payment);

        var capturedAt = PaymentRules.UtcNow(clock);
        payment.Status = PaymentStatus.Captured;
        payment.Attempts.Add(new Attempt(capturedAt, provider, AttemptResult.Ok));
        payment.Version++;

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            // Another request changed the payment after our read: the filter "version = expectedVersion" matched
            // nothing. Read the current state for the 412 response.
            db.ChangeTracker.Clear();
            var current = await GetAsync(id, ct);
            return current is null
                ? new CaptureResult(CaptureOutcome.NotFound, null)
                : new CaptureResult(CaptureOutcome.VersionMismatch, current);
        }

        // Published directly to the bus, not through the outbox (see the summary).
        await bus.Publish(
            new PaymentCaptured(payment.Id, payment.MerchantId, payment.Amount, payment.Currency, capturedAt), ct);

        return new CaptureResult(CaptureOutcome.Captured, payment);
    }

    /// <summary>The same LINQ as the driver version; the provider translates it into find + sort + limit.</summary>
    public Task<List<Payment>> GetMerchantHistoryAsync(
        string merchantId, DateTime? from, DateTime? to, int limit, CancellationToken ct)
    {
        var query = db.Payments.AsNoTracking().Where(p => p.MerchantId == merchantId);
        if (from is { } fromValue) query = query.Where(p => p.CreatedAt >= fromValue);
        if (to is { } toValue) query = query.Where(p => p.CreatedAt < toValue);
        return query.OrderByDescending(p => p.CreatedAt).Take(limit).ToListAsync(ct);
    }

    /// <summary>
    /// The provider does not translate GroupBy (and no Select projections), so there is no aggregation pipeline.
    /// Workaround: load every captured payment of the merchant (whole documents) and group in memory.
    /// The result is the same; the cost grows with the number of payments. The driver version sends one $group to
    /// the server and receives one small document per currency.
    /// </summary>
    public async Task<List<CurrencyTotal>> GetMerchantTotalsAsync(string merchantId, CancellationToken ct)
    {
        var captured = await db.Payments.AsNoTracking()
            .Where(p => p.MerchantId == merchantId && p.Status == PaymentStatus.Captured)
            .ToListAsync(ct);

        logger.LogInformation(
            "EF Core totals for {MerchantId}: loaded {Count} documents to group them in memory", merchantId, captured.Count);

        return captured
            .GroupBy(p => p.Currency)
            .Select(g => new CurrencyTotal(g.Key, g.Sum(p => p.Amount), g.Count()))
            .OrderByDescending(t => t.Total)
            .ToList();
    }
}
