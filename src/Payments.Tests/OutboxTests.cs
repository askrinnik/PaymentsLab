using MassTransit;
using MassTransit.MongoDbIntegration;
using MassTransit.Testing;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Bson;
using MongoDB.Driver;
using Payments.Api.Domain;
using Payments.Api.Messaging;
using Payments.Api.Payments;

namespace Payments.Tests;

/// <summary>
/// The capture and its PaymentCaptured event are written in one MongoDB transaction (transactional outbox).
/// The test harness records what the outbox delivery service really sends and what the consumer receives.
/// </summary>
[Collection(PaymentsApiCollection.Name)]
public sealed class OutboxTests(PaymentsApiFixture api)
{
    private IEnumerable<IReceivedMessage<PaymentCaptured>> ConsumedFor(Guid paymentId) =>
        api.Harness.Consumed.Select<PaymentCaptured>(m => m.Context.Message.PaymentId == paymentId);

    private async Task<PaymentResponse> CreatePendingAsync()
    {
        var response = await api.CreateAsync(
            PaymentsApiFixture.NewId("key"), PaymentsApiFixture.NewRequest(PaymentsApiFixture.NewId("m")));
        return await PaymentsApiFixture.ReadAsync<PaymentResponse>(response);
    }

    [Fact]
    public async Task Capture_delivers_PaymentCaptured_to_the_consumer()
    {
        var payment = await CreatePendingAsync();

        await api.CaptureAsync(payment.Id, "\"0\"");

        Assert.True(await PaymentsApiFixture.EventuallyAsync(() => ConsumedFor(payment.Id).Any()));
        var message = Assert.Single(ConsumedFor(payment.Id));
        Assert.Equal(payment.Amount, message.Context.Message.Amount);
        Assert.Equal(payment.Currency, message.Context.Message.Currency);
    }

    /// <summary>
    /// Ten concurrent captures: one transaction commits; the others hit a write conflict, are retried, find version 1
    /// and commit nothing. Exactly one event must leave the outbox.
    /// </summary>
    [Fact]
    public async Task Concurrent_captures_publish_exactly_one_event()
    {
        var payment = await CreatePendingAsync();

        await Task.WhenAll(Enumerable.Range(0, 10).Select(_ => api.CaptureAsync(payment.Id, "\"0\"")));

        Assert.True(await PaymentsApiFixture.EventuallyAsync(() => ConsumedFor(payment.Id).Any()));
        await PaymentsApiFixture.WaitLongerThanOutboxDelayAsync(); // a second event would have arrived by now
        Assert.Single(ConsumedFor(payment.Id));
    }

    /// <summary>
    /// The same calls as PaymentService.CaptureAsync, but the transaction is aborted after Publish, as if the service
    /// crashed before the commit. Inside the transaction both writes are visible; after the abort neither exists.
    /// </summary>
    [Fact]
    public async Task Aborted_transaction_leaves_neither_the_capture_nor_the_outbox_message()
    {
        var payment = await CreatePendingAsync();
        using var scope = api.CreateScope();
        var mongoContext = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var publishEndpoint = scope.ServiceProvider.GetRequiredService<IPublishEndpoint>();
        var outbox = scope.ServiceProvider.GetRequiredService<IMongoDatabase>().GetCollection<BsonDocument>("outbox.messages");
        var messageForPayment = Builders<BsonDocument>.Filter.Regex("Body", new BsonRegularExpression(payment.Id.ToString()));

        await mongoContext.BeginTransaction(CancellationToken.None);
        var session = mongoContext.Session!;
        await api.Payments.UpdateOneAsync(
            session, p => p.Id == payment.Id, Builders<Payment>.Update.Set(p => p.Status, PaymentStatus.Captured));
        await publishEndpoint.Publish(
            new PaymentCaptured(payment.Id, payment.MerchantId, payment.Amount, payment.Currency, DateTime.UtcNow));

        // Inside the transaction: the session sees its own uncommitted writes.
        Assert.Equal(1, await outbox.CountDocumentsAsync(session, messageForPayment));
        Assert.Equal(1, await api.Payments.CountDocumentsAsync(
            session, p => p.Id == payment.Id && p.Status == PaymentStatus.Captured));

        await mongoContext.AbortTransaction(CancellationToken.None);

        // After the abort: nothing was ever written.
        Assert.Equal(0, await outbox.CountDocumentsAsync(messageForPayment));
        var stored = await api.Payments.Find(p => p.Id == payment.Id).SingleAsync();
        Assert.Equal(PaymentStatus.Pending, stored.Status);
        await PaymentsApiFixture.WaitLongerThanOutboxDelayAsync();
        Assert.Empty(ConsumedFor(payment.Id));
    }
}
