namespace Payments.Api.Messaging;

/// <summary>Integration event: published when a payment is captured. Other services react to it.</summary>
public sealed record PaymentCaptured(Guid PaymentId, string MerchantId, decimal Amount, string Currency, DateTime CapturedAt);
