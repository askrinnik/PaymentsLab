namespace Payments.Api.Domain;

/// <summary>
/// The payment aggregate, stored as one document in the <c>payments</c> collection.
/// Mapping to BSON is configured by conventions in <c>MongoSetup</c>, so this class has no MongoDB attributes.
/// </summary>
public sealed class Payment
{
    public const int CurrentSchemaVersion = 1;

    public Guid Id { get; set; } // maps to _id
    public string MerchantId { get; set; } = "";
    public string CustomerId { get; set; } = "";
    public string IdempotencyKey { get; set; } = "";
    public decimal Amount { get; set; } // stored as Decimal128
    public string Currency { get; set; } = "";
    public PaymentStatus Status { get; set; }
    public List<Attempt> Attempts { get; set; } = [];
    public DateTime CreatedAt { get; set; } // UTC
    public int Version { get; set; } // optimistic concurrency, exposed to clients as the ETag
    public int SchemaVersion { get; set; } = CurrentSchemaVersion;
}
