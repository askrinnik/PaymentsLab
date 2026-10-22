using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;

namespace Payments.Api.Payments;

public static partial class PaymentEndpoints
{
    public static IEndpointRouteBuilder MapPaymentEndpoints(this IEndpointRouteBuilder app)
    {
        var payments = app.MapGroup("/payments");
        payments.MapPost("/", Create);
        payments.MapGet("/{id:guid}", Get);
        payments.MapPost("/{id:guid}/capture", Capture);

        var merchants = app.MapGroup("/merchants/{merchantId}");
        merchants.MapGet("/payments", History);
        merchants.MapGet("/totals", Totals);

        return app;
    }

    private static async Task<IResult> Create(
        CreatePaymentRequest request,
        [FromHeader(Name = "Idempotency-Key")] string? idempotencyKey,
        PaymentService service,
        HttpResponse response,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey))
            return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "The Idempotency-Key header is required.");

        var errors = Validate(request);
        if (errors.Count > 0) return Results.ValidationProblem(errors);

        var result = await service.CreateAsync(idempotencyKey, request, ct);
        switch (result.Outcome)
        {
            case CreateOutcome.Created:
                response.Headers.ETag = ETag.Format(result.Payment.Version);
                return Results.Created($"/payments/{result.Payment.Id}", PaymentResponse.From(result.Payment));
            case CreateOutcome.Replayed:
                response.Headers.ETag = ETag.Format(result.Payment.Version);
                return Results.Ok(PaymentResponse.From(result.Payment));
            default:
                return Results.Problem(
                    statusCode: StatusCodes.Status422UnprocessableEntity,
                    title: "The Idempotency-Key was already used for a different request.");
        }
    }

    private static async Task<IResult> Get(Guid id, PaymentService service, HttpResponse response, CancellationToken ct)
    {
        var payment = await service.GetAsync(id, ct);
        if (payment is null) return Results.NotFound();

        response.Headers.ETag = ETag.Format(payment.Version);
        return Results.Ok(PaymentResponse.From(payment));
    }

    private static async Task<IResult> Capture(
        Guid id,
        CapturePaymentRequest request,
        [FromHeader(Name = "If-Match")] string? ifMatch,
        PaymentService service,
        HttpResponse response,
        CancellationToken ct)
    {
        if (ifMatch is null)
            return Results.Problem(
                statusCode: StatusCodes.Status428PreconditionRequired,
                title: "The If-Match header with the payment ETag is required.");
        if (!ETag.TryParse(ifMatch, out var expectedVersion))
            return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "If-Match must be an ETag like \"3\".");
        if (string.IsNullOrWhiteSpace(request.Provider))
            return Results.ValidationProblem(new Dictionary<string, string[]> { ["provider"] = ["Provider is required."] });

        var result = await service.CaptureAsync(id, expectedVersion, request.Provider, ct);
        if (result.Payment is not null) response.Headers.ETag = ETag.Format(result.Payment.Version);

        return result.Outcome switch
        {
            CaptureOutcome.Captured => Results.Ok(PaymentResponse.From(result.Payment!)),
            CaptureOutcome.NotFound => Results.NotFound(),
            CaptureOutcome.VersionMismatch => Results.Problem(
                statusCode: StatusCodes.Status412PreconditionFailed,
                title: "The payment was changed by another request.",
                detail: $"Expected version {expectedVersion}, current version {result.Payment!.Version}. Read the payment again."),
            _ => Results.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: "The payment cannot be captured.",
                detail: $"Current status: {result.Payment!.Status}."),
        };
    }

    private static async Task<IResult> History(
        string merchantId, DateTime? from, DateTime? to, PaymentService service, CancellationToken ct, int limit = 20)
    {
        if (limit is < 1 or > 100)
            return Results.ValidationProblem(new Dictionary<string, string[]> { ["limit"] = ["Limit must be from 1 to 100."] });

        var payments = await service.GetMerchantHistoryAsync(merchantId, AsUtc(from), AsUtc(to), limit, ct);
        return Results.Ok(payments.Select(PaymentResponse.From));
    }

    private static async Task<IResult> Totals(string merchantId, PaymentService service, CancellationToken ct) =>
        Results.Ok(await service.GetMerchantTotalsAsync(merchantId, ct));

    private static Dictionary<string, string[]> Validate(CreatePaymentRequest request)
    {
        var errors = new Dictionary<string, string[]>();
        if (string.IsNullOrWhiteSpace(request.MerchantId)) errors["merchantId"] = ["MerchantId is required."];
        if (string.IsNullOrWhiteSpace(request.CustomerId)) errors["customerId"] = ["CustomerId is required."];
        if (request.Amount <= 0) errors["amount"] = ["Amount must be greater than 0."];
        if (request.Currency is null || !CurrencyCode().IsMatch(request.Currency))
            errors["currency"] = ["Currency must be a three-letter ISO 4217 code, for example EUR."];
        return errors;
    }

    // A date without an offset (?from=2026-10-01) is taken as UTC. Without this the driver would treat it as local time.
    private static DateTime? AsUtc(DateTime? value) => value switch
    {
        null => null,
        { Kind: DateTimeKind.Unspecified } v => DateTime.SpecifyKind(v, DateTimeKind.Utc),
        { } v => v.ToUniversalTime(),
    };

    [GeneratedRegex("^[A-Z]{3}$")]
    private static partial Regex CurrencyCode();
}
