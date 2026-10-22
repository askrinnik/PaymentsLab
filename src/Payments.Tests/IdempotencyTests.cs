using System.Net;
using MongoDB.Driver;
using Payments.Api.Payments;

namespace Payments.Tests;

[Collection(PaymentsApiCollection.Name)]
public sealed class IdempotencyTests(PaymentsApiFixture api)
{
    [Fact]
    public async Task Retry_with_the_same_key_returns_the_stored_payment()
    {
        var key = PaymentsApiFixture.NewId("key");
        var request = PaymentsApiFixture.NewRequest(PaymentsApiFixture.NewId("m"));

        var first = await api.CreateAsync(key, request);
        var retry = await api.CreateAsync(key, request);

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
        var created = await PaymentsApiFixture.ReadAsync<PaymentResponse>(first);
        var replayed = await PaymentsApiFixture.ReadAsync<PaymentResponse>(retry);
        Assert.Equal(created.Id, replayed.Id);
        Assert.Equal(created.CreatedAt, replayed.CreatedAt);
        Assert.Equal(1, await api.Payments.CountDocumentsAsync(p => p.IdempotencyKey == key));
    }

    [Fact]
    public async Task Same_key_with_a_different_body_returns_422()
    {
        var key = PaymentsApiFixture.NewId("key");
        var merchantId = PaymentsApiFixture.NewId("m");

        await api.CreateAsync(key, PaymentsApiFixture.NewRequest(merchantId, amount: 25.00m));
        var reused = await api.CreateAsync(key, PaymentsApiFixture.NewRequest(merchantId, amount: 99.00m));

        Assert.Equal(HttpStatusCode.UnprocessableEntity, reused.StatusCode);
        var stored = await api.Payments.Find(p => p.IdempotencyKey == key).SingleAsync();
        Assert.Equal(25.00m, stored.Amount);
    }

    [Fact]
    public async Task Same_amount_written_differently_is_the_same_request()
    {
        var key = PaymentsApiFixture.NewId("key");
        var merchantId = PaymentsApiFixture.NewId("m");

        await api.CreateAsync(key, PaymentsApiFixture.NewRequest(merchantId, amount: 25.00m));
        var retry = await api.CreateAsync(key, PaymentsApiFixture.NewRequest(merchantId, amount: 25m));

        Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
    }

    [Fact]
    public async Task Request_without_a_key_returns_400()
    {
        var message = new HttpRequestMessage(HttpMethod.Post, "/payments")
        {
            Content = System.Net.Http.Json.JsonContent.Create(PaymentsApiFixture.NewRequest("m")),
        };

        var response = await api.Client.SendAsync(message);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    /// <summary>
    /// The race a "find, then insert" check in code would lose: ten requests with one key at the same time.
    /// The unique index lets exactly one insert win; the other nine get error 11000 and return the stored payment.
    /// </summary>
    [Fact]
    public async Task Concurrent_requests_with_the_same_key_create_one_payment()
    {
        var key = PaymentsApiFixture.NewId("key");
        var request = PaymentsApiFixture.NewRequest(PaymentsApiFixture.NewId("m"));

        var responses = await Task.WhenAll(Enumerable.Range(0, 10).Select(_ => api.CreateAsync(key, request)));

        Assert.Single(responses, r => r.StatusCode == HttpStatusCode.Created);
        Assert.Equal(9, responses.Count(r => r.StatusCode == HttpStatusCode.OK));
        var ids = await Task.WhenAll(responses.Select(PaymentsApiFixture.ReadAsync<PaymentResponse>));
        Assert.Single(ids.Select(p => p.Id).Distinct());
        Assert.Equal(1, await api.Payments.CountDocumentsAsync(p => p.IdempotencyKey == key));
    }
}
