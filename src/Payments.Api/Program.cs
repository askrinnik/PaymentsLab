using System.Text.Json.Serialization;
using MongoDB.Bson;
using MongoDB.Driver;
using Payments.Api.Mongo;
using Payments.Api.Payments;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddMongo(builder.Configuration);
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<PaymentService>();
builder.Services.AddProblemDetails();
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter())); // "Captured" instead of 2 in JSON

var app = builder.Build();

app.MapGet("/health", async (IMongoDatabase database, CancellationToken ct) =>
{
    await database.RunCommandAsync((Command<BsonDocument>)"{ ping: 1 }", cancellationToken: ct);
    return Results.Ok(new { status = "ok", mongo = "ok" });
});
app.MapPaymentEndpoints();

app.Run();
