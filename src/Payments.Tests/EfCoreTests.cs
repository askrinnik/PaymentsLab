using System.Net;
using MassTransit.Testing;
using MongoDB.Bson;
using MongoDB.Driver;
using Payments.Api.Domain;
using Payments.Api.Messaging;
using Payments.Api.Payments;

namespace Payments.Tests;

/// <summary>
/// The /ef endpoints use the EF Core provider on the same collection. These tests show what works the same way,
/// that both implementations read each other's documents, and where EF Core behaves differently.
/// </summary>
[Collection(PaymentsApiCollection.Name)]
public sealed class EfCoreTests(PaymentsApiFixture api)
{
    private const string Ef = "/ef";

    private async Task<PaymentResponse> CreateAsync(string prefix, string? merchantId = null)
    {
        var response = await api.CreateAsync(
            PaymentsApiFixture.NewId("key"), PaymentsApiFixture.NewRequest(merchantId ?? PaymentsApiFixture.NewId("m")), prefix);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return await PaymentsApiFixture.ReadAsync<PaymentResponse>(response);
    }

    private async Task<PaymentResponse> GetAsync(string prefix, Guid id) =>
        await PaymentsApiFixture.ReadAsync<PaymentResponse>(await api.Client.GetAsync($"{prefix}/payments/{id}"));

    [Fact]
    public async Task Ef_create_is_idempotent_like_the_driver()
    {
        var key = PaymentsApiFixture.NewId("key");
        var merchantId = PaymentsApiFixture.NewId("m");

        var first = await api.CreateAsync(key, PaymentsApiFixture.NewRequest(merchantId), Ef);
        var retry = await api.CreateAsync(key, PaymentsApiFixture.NewRequest(merchantId), Ef);
        var reused = await api.CreateAsync(key, PaymentsApiFixture.NewRequest(merchantId, amount: 99m), Ef);

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal($"/ef/payments/{(await PaymentsApiFixture.ReadAsync<PaymentResponse>(first)).Id}",
            first.Headers.Location?.OriginalString);
        Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, reused.StatusCode);
        Assert.Equal(1, await api.Payments.CountDocumentsAsync(p => p.IdempotencyKey == key));
    }

    /// <summary>
    /// The EF Core model in PaymentsDbContext repeats the driver conventions by hand. If one field name or type
    /// differed, the two implementations would silently write different documents. Compare the raw BSON.
    /// </summary>
    [Fact]
    public async Task Ef_and_driver_write_documents_of_the_same_shape()
    {
        var byDriver = await CreateAsync(prefix: "");
        var byEf = await CreateAsync(Ef);
        foreach (var id in new[] { byDriver.Id, byEf.Id })
            await api.CaptureAsync(id, "\"0\""); // fill the attempts array too

        var raw = api.Payments.Database.GetCollection<BsonDocument>(api.Payments.CollectionNamespace.CollectionName);
        var driverDoc = await raw.Find(new BsonDocument("_id", new BsonBinaryData(byDriver.Id, GuidRepresentation.Standard))).SingleAsync();
        var efDoc = await raw.Find(new BsonDocument("_id", new BsonBinaryData(byEf.Id, GuidRepresentation.Standard))).SingleAsync();

        Assert.Equal(Shape(driverDoc), Shape(efDoc));
        Assert.Equal(Shape(driverDoc["attempts"][0].AsBsonDocument), Shape(efDoc["attempts"][0].AsBsonDocument));
        Assert.Equal(BsonType.Decimal128, efDoc["amount"].BsonType);
        Assert.Equal(BsonType.String, efDoc["status"].BsonType);
    }

    // Field names in order, each with its BSON type: "_id:Binary", "merchantId:String", ...
    private static string[] Shape(BsonDocument document) =>
        document.Elements.Select(e => $"{e.Name}:{e.Value.BsonType}").OrderBy(x => x, StringComparer.Ordinal).ToArray();

    [Fact]
    public async Task Each_implementation_reads_the_payments_of_the_other()
    {
        var byDriver = await CreateAsync(prefix: "");
        var byEf = await CreateAsync(Ef);

        Assert.Equivalent(byDriver, await GetAsync(Ef, byDriver.Id));
        Assert.Equivalent(byEf, await GetAsync("", byEf.Id));
    }

    [Fact]
    public async Task Ef_capture_follows_the_same_http_rules()
    {
        var payment = await CreateAsync(Ef);

        var captured = await api.CaptureAsync(payment.Id, "\"0\"", provider: "Klarna", prefix: Ef);
        var stale = await api.CaptureAsync(payment.Id, "\"0\"", prefix: Ef);
        var again = await api.CaptureAsync(payment.Id, "\"1\"", prefix: Ef);

        Assert.Equal(HttpStatusCode.OK, captured.StatusCode);
        Assert.Equal("\"1\"", captured.Headers.ETag?.Tag);
        var body = await PaymentsApiFixture.ReadAsync<PaymentResponse>(captured);
        Assert.Equal(PaymentStatus.Captured, body.Status);
        Assert.Equal("Klarna", Assert.Single(body.Attempts).Provider);
        Assert.Equal(HttpStatusCode.PreconditionFailed, stale.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, again.StatusCode);
    }

    /// <summary>
    /// The concurrency token (version) protects the read-modify-write: ten requests read version 0, one SaveChanges
    /// wins, the others get DbUpdateConcurrencyException (412) or lose on the write conflict inside SaveChanges.
    /// </summary>
    [Fact]
    public async Task Ef_concurrent_captures_succeed_once()
    {
        var payment = await CreateAsync(Ef);

        var responses = await Task.WhenAll(
            Enumerable.Range(0, 10).Select(_ => api.CaptureAsync(payment.Id, "\"0\"", prefix: Ef)));

        Assert.Single(responses, r => r.StatusCode == HttpStatusCode.OK);
        Assert.All(responses.Where(r => r.StatusCode != HttpStatusCode.OK),
            r => Assert.Equal(HttpStatusCode.PreconditionFailed, r.StatusCode));
        var stored = await api.Payments.Find(p => p.Id == payment.Id).SingleAsync();
        Assert.Equal(1, stored.Version);
        Assert.Single(stored.Attempts);
    }

    [Fact]
    public async Task Ef_capture_publishes_the_event_without_the_outbox()
    {
        var payment = await CreateAsync(Ef);

        await api.CaptureAsync(payment.Id, "\"0\"", prefix: Ef);

        Assert.True(await PaymentsApiFixture.EventuallyAsync(() =>
            api.Harness.Consumed.Select<PaymentCaptured>(m => m.Context.Message.PaymentId == payment.Id).Any()));
        // Published directly: nothing for this payment ever went through the outbox collection.
        var outbox = api.Payments.Database.GetCollection<BsonDocument>("outbox.messages");
        Assert.Equal(0, await outbox.CountDocumentsAsync(
            Builders<BsonDocument>.Filter.Regex("Body", new BsonRegularExpression(payment.Id.ToString()))));
    }

    /// <summary>
    /// Same answers, different work: the driver groups on the server ($group); EF Core loads every captured payment
    /// and groups in memory, because the provider does not translate GroupBy.
    /// </summary>
    [Fact]
    public async Task Ef_history_and_totals_return_the_same_results_as_the_driver()
    {
        var merchantId = PaymentsApiFixture.NewId("m");
        for (var i = 0; i < 5; i++)
        {
            var payment = await CreateAsync(i % 2 == 0 ? "" : Ef, merchantId);
            if (i < 3) await api.CaptureAsync(payment.Id, "\"0\"");
        }

        Assert.Equal(
            await api.Client.GetStringAsync($"/merchants/{merchantId}/payments?limit=10"),
            await api.Client.GetStringAsync($"/ef/merchants/{merchantId}/payments?limit=10"));
        Assert.Equal(
            await api.Client.GetStringAsync($"/merchants/{merchantId}/totals"),
            await api.Client.GetStringAsync($"/ef/merchants/{merchantId}/totals"));
    }
}
