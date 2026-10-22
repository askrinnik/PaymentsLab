using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Driver;
using Payments.Api.Domain;
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

    /// <summary>Direct access to the collection: to arrange data and to check what is really stored.</summary>
    public IMongoCollection<Payment> Payments { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        await _mongo.StartAsync();

        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.UseSetting("ConnectionStrings:Mongo", _mongo.GetConnectionString()));

        // Creating the client starts the API; its hosted service creates the indexes.
        Client = _factory.CreateClient();
        Payments = _factory.Services.GetRequiredService<IMongoCollection<Payment>>();
    }

    public async Task DisposeAsync()
    {
        if (_factory is not null) await _factory.DisposeAsync();
        await _mongo.DisposeAsync();
    }

    public static string NewId(string prefix) => $"{prefix}-{Guid.NewGuid():N}";

    public static CreatePaymentRequest NewRequest(string merchantId, decimal amount = 25.00m, string currency = "EUR") =>
        new(merchantId, "c-42", amount, currency);

    public Task<HttpResponseMessage> CreateAsync(string idempotencyKey, CreatePaymentRequest request)
    {
        var message = new HttpRequestMessage(HttpMethod.Post, "/payments") { Content = JsonContent.Create(request) };
        message.Headers.Add("Idempotency-Key", idempotencyKey);
        return Client.SendAsync(message);
    }

    public Task<HttpResponseMessage> CaptureAsync(Guid id, string? ifMatch, string provider = "Adyen")
    {
        var message = new HttpRequestMessage(HttpMethod.Post, $"/payments/{id}/capture")
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
