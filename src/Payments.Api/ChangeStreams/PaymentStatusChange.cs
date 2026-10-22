namespace Payments.Api.ChangeStreams;

/// <summary>
/// One status change seen by a <see cref="PaymentStatusWatcher"/>, stored in the <c>paymentStatusHistory</c>
/// collection: a projection (audit trail) built from the change stream.
/// </summary>
public sealed class PaymentStatusChange
{
    /// <summary>"{watcher}:{paymentId}:{version}". A replayed event writes the same id again, so the projection is idempotent.</summary>
    public string Id { get; set; } = "";
    public string Watcher { get; set; } = "";
    public Guid PaymentId { get; set; }
    public string Status { get; set; } = "";
    public int Version { get; set; }
    public string Operation { get; set; } = ""; // insert or update
    public DateTime? ChangedAt { get; set; } // wall time of the write on the server
}
