# PaymentsLab

A small payments API used to learn MongoDB with .NET 10 and the official MongoDB C# driver:
idempotency keys, optimistic concurrency, aggregations, transactions and a transactional outbox.

## Run

Requirements: .NET 10 SDK and Docker.

```bash
docker compose up -d --build --wait
curl http://localhost:8080/health
```

| Service  | Address                                                          |
|----------|------------------------------------------------------------------|
| API      | http://localhost:8080                                            |
| MongoDB  | `mongodb://localhost:27017/?replicaSet=rs0&directConnection=true` |
| RabbitMQ | `amqp://localhost:5672`, UI http://localhost:15672 (guest/guest) |

MongoDB runs as a single-node replica set, because transactions and change streams need one.
