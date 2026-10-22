using System.Net;
using MongoDB.Driver;
using Payments.Api.Domain;
using Payments.Api.Payments;

namespace Payments.Tests;

[Collection(PaymentsApiCollection.Name)]
public sealed class CaptureTests(PaymentsApiFixture api)
{
    private async Task<PaymentResponse> CreatePendingAsync()
    {
        var response = await api.CreateAsync(
            PaymentsApiFixture.NewId("key"), PaymentsApiFixture.NewRequest(PaymentsApiFixture.NewId("m")));
        return await PaymentsApiFixture.ReadAsync<PaymentResponse>(response);
    }

    [Fact]
    public async Task Capture_with_the_current_etag_captures_the_payment()
    {
        var payment = await CreatePendingAsync();

        var response = await api.CaptureAsync(payment.Id, "\"0\"", provider: "Klarna");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("\"1\"", response.Headers.ETag?.Tag);
        var captured = await PaymentsApiFixture.ReadAsync<PaymentResponse>(response);
        Assert.Equal(PaymentStatus.Captured, captured.Status);
        Assert.Equal(1, captured.Version);
        var attempt = Assert.Single(captured.Attempts);
        Assert.Equal("Klarna", attempt.Provider);
        Assert.Equal(AttemptResult.Ok, attempt.Result);
    }

    /// <summary>
    /// Ten clients read version 0 and capture at the same time. The version in the update filter lets exactly one
    /// update match; the others find no document with version 0 and get 412. Only one attempt is stored.
    /// </summary>
    [Fact]
    public async Task Concurrent_captures_with_the_same_etag_succeed_once()
    {
        var payment = await CreatePendingAsync();

        var responses = await Task.WhenAll(Enumerable.Range(0, 10).Select(_ => api.CaptureAsync(payment.Id, "\"0\"")));

        Assert.Single(responses, r => r.StatusCode == HttpStatusCode.OK);
        Assert.Equal(9, responses.Count(r => r.StatusCode == HttpStatusCode.PreconditionFailed));
        var document = await api.Payments.Find(p => p.Id == payment.Id).SingleAsync();
        Assert.Equal(1, document.Version);
        Assert.Single(document.Attempts);
    }

    /// <summary>
    /// The test above would also pass without the version check: after the first capture the status is Captured,
    /// and the status filter alone stops the other nine. This test isolates the version: the payment is still
    /// Pending, but someone changed it (version 1) after the client read version 0. Only the version can stop it.
    /// </summary>
    [Fact]
    public async Task Capture_with_a_stale_etag_is_rejected_even_if_the_status_allows_it()
    {
        var payment = new Payment
        {
            Id = Guid.NewGuid(),
            MerchantId = PaymentsApiFixture.NewId("m"),
            CustomerId = "c-1",
            IdempotencyKey = PaymentsApiFixture.NewId("key"),
            Amount = 10m,
            Currency = "EUR",
            Status = PaymentStatus.Pending,
            Attempts = [new Attempt(DateTime.UtcNow, "Adyen", AttemptResult.Timeout)],
            CreatedAt = DateTime.UtcNow,
            Version = 1, // a failed attempt was recorded after the client read version 0
        };
        await api.Payments.InsertOneAsync(payment);

        var response = await api.CaptureAsync(payment.Id, "\"0\"");

        Assert.Equal(HttpStatusCode.PreconditionFailed, response.StatusCode);
        var stored = await api.Payments.Find(p => p.Id == payment.Id).SingleAsync();
        Assert.Equal(PaymentStatus.Pending, stored.Status);
    }

    [Fact]
    public async Task Capture_with_an_old_etag_returns_412_and_the_current_etag()
    {
        var payment = await CreatePendingAsync();
        await api.CaptureAsync(payment.Id, "\"0\"");

        var response = await api.CaptureAsync(payment.Id, "\"0\"");

        Assert.Equal(HttpStatusCode.PreconditionFailed, response.StatusCode);
        Assert.Equal("\"1\"", response.Headers.ETag?.Tag);
    }

    [Fact]
    public async Task Capture_of_a_captured_payment_returns_409()
    {
        var payment = await CreatePendingAsync();
        await api.CaptureAsync(payment.Id, "\"0\"");

        var response = await api.CaptureAsync(payment.Id, "\"1\"");

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    [Fact]
    public async Task Capture_without_if_match_returns_428()
    {
        var payment = await CreatePendingAsync();

        var response = await api.CaptureAsync(payment.Id, ifMatch: null);

        Assert.Equal(HttpStatusCode.PreconditionRequired, response.StatusCode);
    }

    [Fact]
    public async Task Capture_of_an_unknown_payment_returns_404()
    {
        var response = await api.CaptureAsync(Guid.NewGuid(), "\"0\"");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
