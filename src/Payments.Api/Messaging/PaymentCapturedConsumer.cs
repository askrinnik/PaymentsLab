using MassTransit;

namespace Payments.Api.Messaging;

/// <summary>
/// Shows that the event really travels through RabbitMQ. In a real system another service (accounting,
/// notifications) would consume it. Delivery is at least once, so a real consumer must be idempotent.
/// </summary>
public sealed class PaymentCapturedConsumer(ILogger<PaymentCapturedConsumer> logger) : IConsumer<PaymentCaptured>
{
    public Task Consume(ConsumeContext<PaymentCaptured> context)
    {
        var message = context.Message;
        logger.LogInformation(
            "PaymentCaptured received: {PaymentId} {Amount} {Currency} (merchant {MerchantId})",
            message.PaymentId, message.Amount, message.Currency, message.MerchantId);
        return Task.CompletedTask;
    }
}
