using Payments.Api.Domain;
using Payments.Api.Payments;

namespace Payments.Tests;

/// <summary>
/// The data is inserted directly into MongoDB with fixed dates and statuses, so the expected results are exact.
/// </summary>
[Collection(PaymentsApiCollection.Name)]
public sealed class MerchantTests(PaymentsApiFixture api)
{
    private static Payment NewPayment(
        string merchantId, DateTime createdAt, decimal amount = 10m, string currency = "EUR",
        PaymentStatus status = PaymentStatus.Captured) => new()
    {
        Id = Guid.NewGuid(),
        MerchantId = merchantId,
        CustomerId = "c-1",
        IdempotencyKey = PaymentsApiFixture.NewId("key"),
        Amount = amount,
        Currency = currency,
        Status = status,
        CreatedAt = createdAt,
    };

    private static DateTime Utc(int month, int day) => new(2026, month, day, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task History_returns_the_newest_payments_first_up_to_the_limit()
    {
        var merchantId = PaymentsApiFixture.NewId("m");
        await api.Payments.InsertManyAsync([
            NewPayment(merchantId, Utc(1, 10)),
            NewPayment(merchantId, Utc(3, 10)),
            NewPayment(merchantId, Utc(2, 10)),
        ]);

        var history = await GetHistoryAsync($"/merchants/{merchantId}/payments?limit=2");

        Assert.Equal([Utc(3, 10), Utc(2, 10)], history.Select(p => p.CreatedAt));
    }

    [Fact]
    public async Task History_filters_by_date_range_with_from_included_and_to_excluded()
    {
        var merchantId = PaymentsApiFixture.NewId("m");
        await api.Payments.InsertManyAsync([
            NewPayment(merchantId, Utc(1, 31)),
            NewPayment(merchantId, Utc(2, 1)),
            NewPayment(merchantId, Utc(2, 15)),
            NewPayment(merchantId, Utc(3, 1)),
        ]);

        var history = await GetHistoryAsync($"/merchants/{merchantId}/payments?from=2026-02-01&to=2026-03-01T12:00:00");

        Assert.Equal([Utc(2, 15), Utc(2, 1)], history.Select(p => p.CreatedAt));
    }

    [Fact]
    public async Task History_does_not_return_payments_of_other_merchants()
    {
        var merchantId = PaymentsApiFixture.NewId("m");
        await api.Payments.InsertManyAsync([
            NewPayment(merchantId, Utc(1, 1)),
            NewPayment(PaymentsApiFixture.NewId("other"), Utc(1, 2)),
        ]);

        var history = await GetHistoryAsync($"/merchants/{merchantId}/payments");

        Assert.All(history, p => Assert.Equal(merchantId, p.MerchantId));
        Assert.Single(history);
    }

    /// <summary>
    /// 0.10 + 0.20 is 0.30000000000000004 in double. Decimal128 and $sum keep the exact value.
    /// Only captured payments count.
    /// </summary>
    [Fact]
    public async Task Totals_sum_captured_amounts_per_currency_exactly()
    {
        var merchantId = PaymentsApiFixture.NewId("m");
        await api.Payments.InsertManyAsync([
            NewPayment(merchantId, Utc(1, 1), 0.10m, "EUR"),
            NewPayment(merchantId, Utc(1, 2), 0.20m, "EUR"),
            NewPayment(merchantId, Utc(1, 3), 500m, "EUR", PaymentStatus.Failed),
            NewPayment(merchantId, Utc(1, 4), 1.00m, "SEK"),
        ]);

        var response = await api.Client.GetAsync($"/merchants/{merchantId}/totals");
        var totals = await PaymentsApiFixture.ReadAsync<List<CurrencyTotal>>(response);

        Assert.Equal([new CurrencyTotal("SEK", 1.00m, 1), new CurrencyTotal("EUR", 0.30m, 2)], totals);
    }

    private async Task<List<PaymentResponse>> GetHistoryAsync(string url)
    {
        var response = await api.Client.GetAsync(url);
        response.EnsureSuccessStatusCode();
        return await PaymentsApiFixture.ReadAsync<List<PaymentResponse>>(response);
    }
}
