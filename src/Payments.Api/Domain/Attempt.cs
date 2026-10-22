namespace Payments.Api.Domain;

public enum AttemptResult
{
    Ok,
    Declined,
    Timeout,
}

/// <summary>One call to a payment provider. Embedded in <see cref="Payment"/>: read together with it, bounded in number.</summary>
public sealed record Attempt(DateTime At, string Provider, AttemptResult Result);
