using Microsoft.EntityFrameworkCore;
using MongoDB.Bson;
using MongoDB.Driver;
using MongoDB.EntityFrameworkCore.Extensions;
using Payments.Api.Domain;
using Payments.Api.Mongo;

namespace Payments.Api.EfCore;

/// <summary>
/// EF Core over the same <c>payments</c> collection as the driver.
///
/// The EF Core provider does not use the driver's BSON conventions from MongoSetup (camelCase, enums as strings).
/// It has its own model, like the Fluent API for SQL Server (ToTable, HasColumnName). So the document shape is
/// repeated here field by field; otherwise EF Core would read and write "MerchantId" instead of "merchantId", and
/// the two implementations would not see each other's documents.
/// </summary>
public sealed class PaymentsDbContext(DbContextOptions<PaymentsDbContext> options) : DbContext(options)
{
    public DbSet<Payment> Payments => Set<Payment>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Payment>(payment =>
        {
            payment.ToCollection(MongoSetup.PaymentsCollection);

            payment.HasKey(p => p.Id);
            payment.Property(p => p.Id).HasElementName("_id");
            payment.Property(p => p.MerchantId).HasElementName("merchantId");
            payment.Property(p => p.CustomerId).HasElementName("customerId");
            payment.Property(p => p.IdempotencyKey).HasElementName("idempotencyKey");
            payment.Property(p => p.Amount).HasElementName("amount").HasBsonRepresentation(BsonType.Decimal128);
            payment.Property(p => p.Currency).HasElementName("currency");
            payment.Property(p => p.Status).HasElementName("status").HasConversion<string>();
            payment.Property(p => p.CreatedAt).HasElementName("createdAt");
            payment.Property(p => p.SchemaVersion).HasElementName("schemaVersion");

            // The concurrency token: SaveChanges adds "version = <value that was read>" to the update filter,
            // like a rowversion column. No match -> DbUpdateConcurrencyException.
            payment.Property(p => p.Version).HasElementName("version").IsConcurrencyToken();

            // The embedded array. In EF Core terms an owned collection: it has no table (collection) of its own.
            payment.OwnsMany(p => p.Attempts, attempt =>
            {
                attempt.HasElementName("attempts");
                attempt.Property(a => a.At).HasElementName("at");
                attempt.Property(a => a.Provider).HasElementName("provider");
                attempt.Property(a => a.Result).HasElementName("result").HasConversion<string>();
            });
        });
    }
}

public static class PaymentsDbContextSetup
{
    /// <summary>Reuses the application's MongoClient, so both implementations share one connection pool.</summary>
    public static IServiceCollection AddPaymentsDbContext(this IServiceCollection services) =>
        services.AddDbContext<PaymentsDbContext>((sp, options) =>
            options.UseMongoDB(sp.GetRequiredService<IMongoClient>(), MongoSetup.DatabaseName));
}
