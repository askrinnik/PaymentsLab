using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using MassTransit;
using MassTransit.Testing;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using MongoDB.Driver;
using Payments.Api.ChangeStreams;
using Payments.Api.Domain;
using Payments.Api.Messaging;
using Payments.Api.Payments;
using Testcontainers.MongoDb;

namespace Payments.Tests;

/// <summary>
/// One MongoDB container and one API instance for the whole test run.
/// MongoDB runs as a single-node replica set, like in docker-compose, so transactions will work in step 4.
/// The API runs in memory (WebApplicationFactory) and is connected to the container instead of localhost:27017.
/// Tests do not clean the database: each test uses its own merchant id and idempotency keys.
/// </summary>
public sealed class PaymentsApiFixture : IAsyncLifetime
{
    private readonly MongoDbContainer _mongo = new MongoDbBuilder("mongo:8.0").WithReplicaSet().Build();
    private WebApplicationFactory<Program>? _factory;

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    public HttpClient Client { get; private set; } = null!;

    /// <summary>Records published and consumed messages; waits for them with a timeout.</summary>
    public ITestHarness Harness => _factory!.Services.GetTestHarness();

    /// <summary>A DI scope, like one HTTP request: for scoped services such as the MassTransit MongoDbContext.</summary>
    public IServiceScope CreateScope() => _factory!.Services.CreateScope();

    /// <summary>Direct access to the collection: to arrange data and to check what is really stored.</summary>
    public IMongoCollection<Payment> Payments { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        await _mongo.StartAsync();

        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.UseSetting("ConnectionStrings:Mongo", _mongo.GetConnectionString());
            // The MassTransit test harness replaces RabbitMQ with an in-memory transport and records every message.
            // AddMassTransitTestHarness replaces the whole MassTransit setup, so the outbox is configured again with
            // the same code as in the API: messages still go through the outbox collection in the container.
            builder.ConfigureTestServices(services => services.AddMassTransitTestHarness(MessagingSetup.AddConsumersAndOutbox));
        });

        // Creating the client starts the API; its hosted service creates the indexes.
        Client = _factory.CreateClient();
        Payments = _factory.Services.GetRequiredService<IMongoCollection<Payment>>();

        // The change stream of the API opens in the background; wait for it, so no test write happens before it.
        await _factory.Services.GetServices<IHostedService>().OfType<PaymentStatusWatcher>().Single().Watching;
    }

    public async Task DisposeAsync()
    {
        if (_factory is not null) await _factory.DisposeAsync();
        await _mongo.DisposeAsync();
    }

    /// <summary>
    /// Waits until the condition is true, up to 10 seconds. The outbox delivers messages in the background, up to
    /// one QueryDelay after the commit, so a test must wait for them. Harness.Any is not enough here: it stops
    /// waiting as soon as the bus looks idle, which happens before the delivery service polls the outbox.
    /// </summary>
    public static async Task<bool> EventuallyAsync(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < deadline)
        {
            if (condition()) return true;
            await Task.Delay(100);
        }
        return condition();
    }

    /// <summary>Longer than the outbox QueryDelay: a message that was going to be delivered has arrived by now.</summary>
    public static Task WaitLongerThanOutboxDelayAsync() => Task.Delay(TimeSpan.FromSeconds(3));

    public static string NewId(string prefix) => $"{prefix}-{Guid.NewGuid():N}";

    public static CreatePaymentRequest NewRequest(string merchantId, decimal amount = 25.00m, string currency = "EUR") =>
        new(merchantId, "c-42", amount, currency);

    /// <summary>POST {prefix}/payments. prefix "" = driver endpoints, "/ef" = EF Core endpoints.</summary>
    public Task<HttpResponseMessage> CreateAsync(string idempotencyKey, CreatePaymentRequest request, string prefix = "")
    {
        var message = new HttpRequestMessage(HttpMethod.Post, $"{prefix}/payments") { Content = JsonContent.Create(request) };
        message.Headers.Add("Idempotency-Key", idempotencyKey);
        return Client.SendAsync(message);
    }

    public Task<HttpResponseMessage> CaptureAsync(Guid id, string? ifMatch, string provider = "Adyen", string prefix = "")
    {
        var message = new HttpRequestMessage(HttpMethod.Post, $"{prefix}/payments/{id}/capture")
        {
            Content = JsonContent.Create(new CapturePaymentRequest(provider)),
        };
        // TryAddWithoutValidation: the If-Match value is passed as is, so the API sees exactly what the test sends.
        if (ifMatch is not null) message.Headers.TryAddWithoutValidation("If-Match", ifMatch);
        return Client.SendAsync(message);
    }

    public static async Task<T> ReadAsync<T>(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<T>(Json))!;
}

[CollectionDefinition(Name)]
public sealed class PaymentsApiCollection : ICollectionFixture<PaymentsApiFixture>
{
    public const string Name = "Payments API";
}
