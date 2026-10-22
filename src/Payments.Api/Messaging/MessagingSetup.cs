using MassTransit;
using MongoDB.Driver;

namespace Payments.Api.Messaging;

public static class MessagingSetup
{
    /// <summary>MassTransit on RabbitMQ with the MongoDB transactional outbox.</summary>
    public static IServiceCollection AddMessaging(this IServiceCollection services) =>
        services.AddMassTransit(x =>
        {
            AddConsumersAndOutbox(x);

            x.UsingRabbitMq((context, cfg) =>
            {
                var connectionString = context.GetRequiredService<IConfiguration>().GetConnectionString("RabbitMq")
                    ?? throw new InvalidOperationException("Connection string 'RabbitMq' is not configured.");
                cfg.Host(new Uri(connectionString));
                cfg.ConfigureEndpoints(context);
            });
        });

    /// <summary>
    /// Everything except the transport. The tests call this too: they replace RabbitMQ with the in-memory test
    /// harness but must keep the same outbox.
    ///
    /// UseBusOutbox: IPublishEndpoint.Publish does not send to RabbitMQ. It inserts the message into the outbox
    /// collection with the current MongoDB session, so the message is part of the same transaction as the payment
    /// update. A background delivery service reads committed outbox messages and sends them to RabbitMQ.
    /// </summary>
    public static void AddConsumersAndOutbox(IBusRegistrationConfigurator x)
    {
        x.AddConsumer<PaymentCapturedConsumer>();

        x.AddMongoDbOutbox(o =>
        {
            // Reuse the application's client and database: the outbox must write with our sessions.
            o.ClientFactory(sp => sp.GetRequiredService<IMongoClient>());
            o.DatabaseFactory(sp => sp.GetRequiredService<IMongoDatabase>());
            o.QueryDelay = TimeSpan.FromSeconds(1); // how often the delivery service looks for new messages
            o.UseBusOutbox();
        });
    }
}
