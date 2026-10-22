# PaymentsLab

A small payments API used to learn MongoDB with .NET 10 and the official MongoDB C# driver:
idempotency keys, optimistic concurrency, aggregations, transactions and a transactional outbox.

## Run

Requirements: .NET 10 SDK and Docker. The solution and Docker files are in `src/`.

```bash
cd src
docker compose up -d --build --wait
curl http://localhost:8080/health
```

| Service  | Address                                                          |
|----------|------------------------------------------------------------------|
| API      | http://localhost:8080                                            |
| MongoDB  | `mongodb://localhost:27017/?replicaSet=rs0&directConnection=true` |
| RabbitMQ | `amqp://localhost:5672`, UI http://localhost:15672 (guest/guest) |

MongoDB runs as a single-node replica set, because transactions and change streams need one.

## API

| Endpoint | Description |
|---|---|
| `POST /payments` | Creates a payment. Requires `Idempotency-Key`: 201 created, 200 retry, 422 key reused with another body |
| `GET /payments/{id}` | Returns a payment and its version in `ETag` |
| `POST /payments/{id}/capture` | Captures a payment. Requires `If-Match` with the ETag: 412 version changed, 409 wrong status |
| `GET /merchants/{merchantId}/payments?from=&to=&limit=` | Newest payments of a merchant |
| `GET /merchants/{merchantId}/totals` | Captured amount per currency |

Ready-made requests: `src/Payments.Api/payments.http`.

## Tests

```bash
cd src
dotnet test
```

The tests start their own MongoDB replica set in Docker (Testcontainers) and run the API in memory, so only Docker
must be running. They do not touch the database of docker-compose.

## Messaging

A capture updates the payment and publishes `PaymentCaptured` in one MongoDB transaction (transactional outbox,
MassTransit 8.5 MongoDB bus outbox). A background service delivers committed messages to RabbitMQ, and
`PaymentCapturedConsumer` logs them:

```bash
docker compose logs api | grep "PaymentCaptured received"
```
