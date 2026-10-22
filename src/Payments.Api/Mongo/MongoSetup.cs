using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Bson.Serialization.Conventions;
using MongoDB.Bson.Serialization.Serializers;
using MongoDB.Driver;
using Payments.Api.Domain;

namespace Payments.Api.Mongo;

public static class MongoSetup
{
    public const string DatabaseName = "payments";
    public const string PaymentsCollection = "payments";

    private static readonly Lock RegistrationLock = new();
    private static bool _registered;

    /// <summary>
    /// Global BSON mapping rules. They must be registered once, before the first collection is used.
    /// </summary>
    public static void RegisterConventions()
    {
        lock (RegistrationLock)
        {
            if (_registered) return;

            // Driver 3.x does not store Guid without an explicit representation. Standard = BSON UUID (subtype 4).
            BsonSerializer.RegisterSerializer(new GuidSerializer(GuidRepresentation.Standard));
            // decimal as Decimal128: exact money. The default would be a string.
            BsonSerializer.RegisterSerializer(new DecimalSerializer(BsonType.Decimal128));

            var conventions = new ConventionPack
            {
                new CamelCaseElementNameConvention(), // MerchantId -> merchantId
                new IgnoreExtraElementsConvention(true), // old or unknown fields do not break reads
                new EnumRepresentationConvention(BsonType.String), // "Captured" instead of 2
            };
            ConventionRegistry.Register("payments", conventions, _ => true);

            _registered = true;
        }
    }

    public static IServiceCollection AddMongo(this IServiceCollection services, IConfiguration configuration)
    {
        RegisterConventions();

        var connectionString = configuration.GetConnectionString("Mongo")
            ?? throw new InvalidOperationException("Connection string 'Mongo' is not configured.");

        // MongoClient is thread-safe and holds the connection pool: one instance per application.
        services.AddSingleton<IMongoClient>(_ => new MongoClient(connectionString));
        services.AddSingleton(sp => sp.GetRequiredService<IMongoClient>().GetDatabase(DatabaseName));
        services.AddSingleton(sp => sp.GetRequiredService<IMongoDatabase>().GetCollection<Payment>(PaymentsCollection));
        services.AddHostedService<MongoIndexInitializer>();

        return services;
    }
}
