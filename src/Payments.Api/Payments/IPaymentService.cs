using Payments.Api.Domain;

namespace Payments.Api.Payments;

/// <summary>
/// Data access for the payment endpoints. Two implementations use the same collection:
/// <see cref="PaymentService"/> (MongoDB driver, endpoints under /payments) and
/// <c>EfPaymentService</c> (EF Core provider, the same endpoints under /ef).
/// </summary>
public interface IPaymentService
{
    Task<CreateResult> CreateAsync(string idempotencyKey, CreatePaymentRequest request, CancellationToken ct);

    Task<Payment?> GetAsync(Guid id, CancellationToken ct);

    Task<CaptureResult> CaptureAsync(Guid id, int expectedVersion, string provider, CancellationToken ct);

    Task<List<Payment>> GetMerchantHistoryAsync(string merchantId, DateTime? from, DateTime? to, int limit, CancellationToken ct);

    Task<List<CurrencyTotal>> GetMerchantTotalsAsync(string merchantId, CancellationToken ct);
}
