namespace Payments.Api.Payments;

/// <summary>
/// The payment version as an HTTP entity tag. GET returns <c>ETag: "3"</c>; the client sends it back in
/// <c>If-Match: "3"</c>, and the update succeeds only if the stored version is still 3.
/// </summary>
public static class ETag
{
    public static string Format(int version) => $"\"{version}\"";

    /// <summary>Accepts one strong tag with a number, for example <c>"3"</c>. Weak tags and <c>*</c> are not supported.</summary>
    public static bool TryParse(string? header, out int version)
    {
        version = 0;
        var value = header?.Trim();
        return value is { Length: > 2 } && value[0] == '"' && value[^1] == '"'
            && int.TryParse(value.AsSpan(1, value.Length - 2), out version);
    }
}
