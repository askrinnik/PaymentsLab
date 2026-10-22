using Payments.Api.Domain;

namespace Payments.Api.Payments;

public sealed record CreatePaymentRequest(string MerchantId, string CustomerId, decimal Amount, string Currency);

public sealed record CapturePaymentRequest(string Provider);

/// <summary>What clients see. Internal fields (idempotency key, schema version) stay in the database.</summary>
public sealed record PaymentResponse(
    Guid Id,
    string MerchantId,
    string CustomerId,
    decimal Amount,
    string Currency,
    PaymentStatus Status,
    IReadOnlyList<Attempt> Attempts,
    DateTime CreatedAt,
    int Version)
{
    public static PaymentResponse From(Payment p) =>
        new(p.Id, p.MerchantId, p.CustomerId, p.Amount, p.Currency, p.Status, p.Attempts, p.CreatedAt, p.Version);
}

public sealed record CurrencyTotal(string Currency, decimal Total, int Count);
