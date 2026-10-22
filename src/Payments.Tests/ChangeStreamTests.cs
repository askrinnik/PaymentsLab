using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Payments.Api.ChangeStreams;
using Payments.Api.Payments;

namespace Payments.Tests;

[Collection(PaymentsApiCollection.Name)]
public sealed class ChangeStreamTests(PaymentsApiFixture api)
{
    private IMongoDatabase Database => api.Payments.Database;

    private IMongoCollection<PaymentStatusChange> History =>
        Database.GetCollection<PaymentStatusChange>(PaymentStatusWatcher.HistoryCollection);

    private async Task<PaymentResponse> CreateAsync(string prefix = "")
    {
        var response = await api.CreateAsync(
            PaymentsApiFixture.NewId("key"), PaymentsApiFixture.NewRequest(PaymentsApiFixture.NewId("m")), prefix);
        return await PaymentsApiFixture.ReadAsync<PaymentResponse>(response);
    }

    private async Task<List<string>> StatusesAsync(string watcher, Guid paymentId) =>
        (await History.Find(h => h.Watcher == watcher && h.PaymentId == paymentId).SortBy(h => h.Version).ToListAsync())
        .Select(h => $"{h.Status}:{h.Version}")
        .ToList();

    private async Task<bool> SeenAsync(string watcher, Guid paymentId, params string[] expected)
    {
        var seen = Array.Empty<string>();
        var ok = await PaymentsApiFixture.EventuallyAsync(() =>
        {
            seen = StatusesAsync(watcher, paymentId).GetAwaiter().GetResult().ToArray();
            return seen.SequenceEqual(expected);
        });
        Assert.True(ok, $"expected [{string.Join(", ", expected)}], seen [{string.Join(", ", seen)}]");
        return ok;
    }

    /// <summary>The watcher of the API sees writes of both implementations: it reads the oplog, not the code.</summary>
    [Theory]
    [InlineData("")]
    [InlineData("/ef")]
    public async Task The_application_watcher_records_create_and_capture(string prefix)
    {
        var payment = await CreateAsync(prefix);
        await api.CaptureAsync(payment.Id, "\"0\"", prefix: prefix);

        await SeenAsync(PaymentStatusWatcher.DefaultName, payment.Id, "Pending:0", "Captured:1");
    }

    /// <summary>
    /// A separate watcher with its own name (own checkpoint and own history rows) is started, stopped and started
    /// again. The changes made while it was stopped must arrive after the restart: it resumes from the stored token.
    /// </summary>
    [Fact]
    public async Task A_restarted_watcher_resumes_and_sees_changes_made_while_it_was_stopped()
    {
        var name = PaymentsApiFixture.NewId("test-watcher");
        var first = new PaymentStatusWatcher(Database, NullLogger<PaymentStatusWatcher>.Instance, name);
        await first.StartAsync(CancellationToken.None);
        await first.Watching;

        var a = await CreateAsync();
        await SeenAsync(name, a.Id, "Pending:0");
        await first.StopAsync(CancellationToken.None);

        // The watcher is stopped now.
        await api.CaptureAsync(a.Id, "\"0\"");
        var b = await CreateAsync();

        var second = new PaymentStatusWatcher(Database, NullLogger<PaymentStatusWatcher>.Instance, name);
        await second.StartAsync(CancellationToken.None);
        try
        {
            await SeenAsync(name, a.Id, "Pending:0", "Captured:1");
            await SeenAsync(name, b.Id, "Pending:0");
        }
        finally
        {
            await second.StopAsync(CancellationToken.None);
        }
    }

    /// <summary>Without a stored token a new watcher starts "from now": earlier changes are not replayed.</summary>
    [Fact]
    public async Task A_new_watcher_without_a_checkpoint_starts_from_now()
    {
        var before = await CreateAsync();
        var name = PaymentsApiFixture.NewId("test-watcher");
        var watcher = new PaymentStatusWatcher(Database, NullLogger<PaymentStatusWatcher>.Instance, name);
        await watcher.StartAsync(CancellationToken.None);
        try
        {
            await watcher.Watching;
            var after = await CreateAsync();

            await SeenAsync(name, after.Id, "Pending:0");
            Assert.Empty(await StatusesAsync(name, before.Id));
        }
        finally
        {
            await watcher.StopAsync(CancellationToken.None);
        }
    }
}
