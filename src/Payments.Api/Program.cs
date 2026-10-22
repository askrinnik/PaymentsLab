using System.Text.Json.Serialization;
using MongoDB.Bson;
using MongoDB.Driver;
using Payments.Api.ChangeStreams;
using Payments.Api.EfCore;
using Payments.Api.Messaging;
using Payments.Api.Mongo;
using Payments.Api.Payments;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddMongo();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddMessaging();
builder.Services.AddScoped<PaymentService>();
builder.Services.AddPaymentsDbContext(); // EF Core provider: the alternative data access under /ef
builder.Services.AddScoped<EfPaymentService>();
builder.Services.AddPaymentStatusWatcher(); // change stream: records status changes of all payments
builder.Services.AddProblemDetails();
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter())); // "Captured" instead of 2 in JSON

var app = builder.Build();

app.MapGet("/health", async (IMongoDatabase database, CancellationToken ct) =>
{
    await database.RunCommandAsync((Command<BsonDocument>)"{ ping: 1 }", cancellationToken: ct);
    return Results.Ok(new { status = "ok", mongo = "ok" });
});
app.MapPaymentEndpoints<PaymentService>(); // MongoDB driver: /payments, /merchants
app.MapPaymentEndpoints<EfPaymentService>("/ef"); // EF Core provider: /ef/payments, /ef/merchants

app.Run();

// Makes the entry point visible to WebApplicationFactory<Program> in Payments.Tests.
public partial class Program;
