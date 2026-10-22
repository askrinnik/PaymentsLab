using Payments.Api.Domain;

namespace Payments.Api.Payments;

/// <summary>Business rules shared by both data access implementations.</summary>
public static class PaymentRules
{
    public static readonly PaymentStatus[] CapturableStatuses = [PaymentStatus.Pending, PaymentStatus.Authorized];

    /// <summary>A retry with the same idempotency key must carry the same request.</summary>
    public static bool IsSameRequest(Payment stored, CreatePaymentRequest request) =>
        stored.MerchantId == request.MerchantId
        && stored.CustomerId == request.CustomerId
        && stored.Amount == request.Amount // decimal equality: 10.5 == 10.50
        && stored.Currency == request.Currency;

    /// <summary>
    /// MongoDB stores dates with millisecond precision. Truncate here, so the 201 response shows the same
    /// createdAt as every later read.
    /// </summary>
    public static DateTime UtcNow(TimeProvider clock)
    {
        var now = clock.GetUtcNow().UtcDateTime;
        return new DateTime(now.Ticks - now.Ticks % TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);
    }

    /// <summary>
    /// Error 11000. The driver reports it as MongoWriteException (single write) or MongoBulkWriteException
    /// (bulk write; SaveChanges of the EF Core provider throws this one). Inner exceptions are checked too.
    /// </summary>
    public static bool IsDuplicateKey(Exception? e)
    {
        for (; e is not null; e = e.InnerException)
        {
            switch (e)
            {
                case MongoDB.Driver.MongoWriteException w when w.WriteError.Category == MongoDB.Driver.ServerErrorCategory.DuplicateKey:
                case MongoDB.Driver.MongoBulkWriteException b
                    when b.WriteErrors.Any(x => x.Category == MongoDB.Driver.ServerErrorCategory.DuplicateKey):
                case MongoDB.Driver.MongoCommandException { Code: 11000 }:
                    return true;
            }
        }
        return false;
    }
}
