# PaymentsLab

[![CI](https://github.com/askrinnik/PaymentsLab/actions/workflows/ci.yml/badge.svg)](https://github.com/askrinnik/PaymentsLab/actions/workflows/ci.yml)
[![Compose smoke test](https://github.com/askrinnik/PaymentsLab/actions/workflows/compose-smoke.yml/badge.svg)](https://github.com/askrinnik/PaymentsLab/actions/workflows/compose-smoke.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![.NET 10](https://img.shields.io/badge/.NET-10-512BD4?logo=dotnet&logoColor=white)
![MongoDB 8.0](https://img.shields.io/badge/MongoDB-8.0-47A248?logo=mongodb&logoColor=white)
![MassTransit 8.5](https://img.shields.io/badge/MassTransit-8.5-0B5CAD)
![RabbitMQ 4](https://img.shields.io/badge/RabbitMQ-4-FF6600?logo=rabbitmq&logoColor=white)
![Testcontainers](https://img.shields.io/badge/tests-Testcontainers-2496ED?logo=docker&logoColor=white)

A learning project about MongoDB with .NET: a small payments-gateway-like Web API on MongoDB 8.0 and .NET 10
minimal APIs, built on the official MongoDB C# driver. It shows the MongoDB patterns a real service needs —
idempotency, optimistic concurrency, aggregations, transactions with an outbox, change streams — in a code base small
enough to read in one sitting. It is not intended for production.

**New to MongoDB? Start with the step-by-step course: [LEARNING_STEPS.md](LEARNING_STEPS.md).** It goes from an empty
machine to the full API in seven steps; each step has a goal, commands to run, checks, the files to read, key
concepts compared with SQL Server / EF Core, and pitfalls.

## What it demonstrates

| Topic | How | Where |
|---|---|---|
| Idempotent create | Unique index on `idempotencyKey`; duplicate key error 11000 returns the stored payment (200) or 422 if the body differs | [`PaymentService.cs`](src/Payments.Api/Payments/PaymentService.cs), [`MongoIndexInitializer.cs`](src/Payments.Api/Mongo/MongoIndexInitializer.cs) |
| Optimistic concurrency | `ETag` / `If-Match`; the version is part of the update filter, `$inc` bumps it (412 / 428 / 409) | [`PaymentService.cs`](src/Payments.Api/Payments/PaymentService.cs), [`PaymentEndpoints.cs`](src/Payments.Api/Payments/PaymentEndpoints.cs), [`ETag.cs`](src/Payments.Api/Payments/ETag.cs) |
| Queries | Merchant history with LINQ (`AsQueryable`), merchant totals with an aggregation pipeline (`$match` + `$group`) | [`PaymentService.cs`](src/Payments.Api/Payments/PaymentService.cs) |
| Indexes | Created in code at startup; compound index follows the ESR rule | [`MongoIndexInitializer.cs`](src/Payments.Api/Mongo/MongoIndexInitializer.cs) |
| BSON mapping | Global conventions, no attributes on domain classes: `decimal` as `Decimal128`, `Guid` as standard UUID, camelCase, enums as strings | [`MongoSetup.cs`](src/Payments.Api/Mongo/MongoSetup.cs), [`Domain/`](src/Payments.Api/Domain) |
| Transactional outbox | Capture updates the payment and stores `PaymentCaptured` in one MongoDB transaction (MassTransit MongoDB bus outbox); the event is delivered to RabbitMQ | [`PaymentService.cs`](src/Payments.Api/Payments/PaymentService.cs), [`Messaging/`](src/Payments.Api/Messaging) |
| EF Core provider side by side | The same endpoints under `/ef`, backed by `MongoDB.EntityFrameworkCore` on the same collection | [`EfCore/`](src/Payments.Api/EfCore) |
| Change stream | A `BackgroundService` follows `payments`, writes a status history projection and stores its resume token | [`ChangeStreams/`](src/Payments.Api/ChangeStreams) |
| Tests on a real MongoDB | xUnit + Testcontainers start `mongo:8.0` as a single-node replica set; no mocks for MongoDB | [`src/Payments.Tests/`](src/Payments.Tests) |
| mongosh lessons | CRUD, `explain()` and indexes, idempotency, aggregation, TTL / partial indexes / schema validation | [`mongosh/`](mongosh) |

## Architecture

```text
                    HTTP :8080
                        |
          +-------------+--------------+
          |       Payments.Api         |
          |  /payments, /merchants     |---- PaymentService (MongoDB driver)
          |  /ef/payments, /ef/...     |---- EfPaymentService (EF Core provider)
          |                            |
          |  PaymentStatusWatcher      |<--- change stream of "payments"
          |  PaymentCapturedConsumer   |<--- RabbitMQ
          +-------------+--------------+
                        |
     one transaction:   |                       outbox delivery
     payment + outbox   v                       service
          +----------------------------+        +-------------+
          | MongoDB 8.0 (replica set   |------->|  RabbitMQ   |
          | rs0), database "payments"  |        +-------------+
          +----------------------------+
```

Collections in the `payments` database: `payments` (the aggregate, with embedded attempts), `paymentStatusHistory`
and `changeStreamCheckpoints` (change stream), and the MassTransit outbox collections.

## Tech stack

| Component | Version |
|---|---|
| .NET SDK / ASP.NET Core minimal APIs | 10.0 (`src/global.json`: SDK 10.0.402, roll forward to latest feature) |
| MongoDB | 8.0 (`mongo:8.0`), single-node replica set `rs0` |
| MongoDB C# driver (`MongoDB.Driver`) | 3.12.0 |
| MongoDB EF Core provider (`MongoDB.EntityFrameworkCore`) | 10.0.4 |
| MassTransit (`MassTransit.MongoDb`, `MassTransit.RabbitMQ`) | 8.5.12 (Apache-2.0; version 9 needs a commercial license) |
| RabbitMQ | 4 (`rabbitmq:4-management`) |
| xUnit | 2.9.3 |
| Testcontainers (`Testcontainers.MongoDb`) | 4.16.0 |
| Docker Compose | stack of `mongo`, `rabbitmq` and `api` |

## Quick start

Prerequisites: Docker (Docker Desktop or Docker Engine with Compose v2). The .NET 10 SDK is needed only to run the
tests or the API outside Docker.

```bash
git clone https://github.com/askrinnik/PaymentsLab.git
cd PaymentsLab/src
docker compose up -d --build --wait
curl http://localhost:8080/health
```

`/health` returns `{"status":"ok","mongo":"ok"}`. The API may need a few seconds after `--wait` returns.

| Service  | Address |
|----------|---------|
| API      | http://localhost:8080 |
| MongoDB  | `mongodb://localhost:27017/?replicaSet=rs0&directConnection=true` (GUI tools: `mongodb://localhost:27017/?directConnection=true`) |
| RabbitMQ | `amqp://localhost:5672`, management UI http://localhost:15672 (guest/guest) |

Send requests with [`src/Payments.Api/payments.http`](src/Payments.Api/payments.http) (Visual Studio, Rider or the
VS Code REST Client extension): create a payment, retry it, read it, capture it with the ETag, query the merchant.

Run the tests (Docker must be running; Testcontainers starts its own MongoDB and does not touch the compose stack):

```bash
cd src
dotnet test
```

Stop the stack with `docker compose down` (add `-v` to drop the MongoDB volume). More commands:
[LEARNING_STEPS.md, command reference](LEARNING_STEPS.md#command-reference).

## API

| Endpoint | Description |
|---|---|
| `GET /health` | Pings MongoDB |
| `POST /payments` | Creates a payment. Requires `Idempotency-Key`: 201 created, 200 retry, 422 key reused with another body |
| `GET /payments/{id}` | Returns a payment and its version in `ETag` |
| `POST /payments/{id}/capture` | Captures a payment. Requires `If-Match` with the ETag: 428 missing, 412 version changed, 409 wrong status |
| `GET /merchants/{merchantId}/payments?from=&to=&limit=` | Newest payments of a merchant |
| `GET /merchants/{merchantId}/totals` | Captured amount per currency |

Every payment and merchant endpoint also exists under `/ef` (for example `/ef/payments`).

## Driver and EF Core provider side by side

The HTTP rules are shared; the data access is `PaymentService` (MongoDB driver) or `EfPaymentService` (MongoDB EF
Core provider). Both work on the same collection and read each other's documents; a test checks that both write the
same BSON shape.

| Operation | Driver | EF Core provider |
|---|---|---|
| Create, read, history | insert, find, LINQ | `Add` + `SaveChanges`, LINQ |
| Duplicate key | `MongoWriteException` | `MongoBulkWriteException` from `SaveChanges` (also logged by EF Core as an error) |
| Capture | one atomic `FindOneAndUpdate` (`$set`, `$push`, `$inc`, version in the filter) | read, change, `SaveChanges` with `version` as concurrency token |
| Capture event | same transaction as the update (MongoDB outbox) | published after `SaveChanges`: lost if the process stops in between |
| Totals | `$group` on the server | `GroupBy` not supported: all captured payments loaded and grouped in memory |
| Mapping | global BSON conventions | repeated by hand in `PaymentsDbContext` |
| Indexes, transactions with outbox | yes | no (indexes are created by the driver at startup) |

## Messaging

A capture updates the payment and publishes `PaymentCaptured` in one MongoDB transaction (transactional outbox,
MassTransit 8.5 MongoDB bus outbox). A background service delivers committed messages to RabbitMQ, and
`PaymentCapturedConsumer` logs them:

```bash
docker compose logs api | grep "PaymentCaptured received"
```

## Change stream

`PaymentStatusWatcher` follows the change stream of `payments` (MongoDB change data capture, needs the replica set).
It sees every insert and every status update, from any writer (driver, EF Core, mongosh), logs it, writes the
`paymentStatusHistory` collection and stores its resume token in `changeStreamCheckpoints`, so after a restart it
continues where it stopped.

```bash
docker compose logs api | grep "Change stream: payment"
```

## Project structure

```text
PaymentsLab/
├── LEARNING_STEPS.md            step-by-step course
├── mongosh/                     mongosh lessons (database "lab"), mounted into the mongo container
├── .github/workflows/           CI and compose smoke test
└── src/
    ├── PaymentsLab.slnx
    ├── global.json, Directory.Build.props
    ├── Dockerfile, docker-compose.yml
    ├── Payments.Api/
    │   ├── Domain/              Payment, Attempt, PaymentStatus (no MongoDB attributes)
    │   ├── Mongo/               client, BSON conventions, indexes at startup
    │   ├── Payments/            endpoints, HTTP rules, driver data access (PaymentService)
    │   ├── EfCore/              EF Core data access (PaymentsDbContext, EfPaymentService)
    │   ├── Messaging/           MassTransit, outbox, PaymentCaptured and its consumer
    │   ├── ChangeStreams/       PaymentStatusWatcher
    │   ├── Program.cs
    │   └── payments.http        ready-made requests
    └── Payments.Tests/          xUnit + Testcontainers
```

## CI

Two GitHub Actions workflows run on every push and pull request to `main`:

- [`ci.yml`](.github/workflows/ci.yml): restore, build in Release (warnings are errors), run all tests against a
  MongoDB replica set started by Testcontainers, upload the test results, build the API Docker image.
- [`compose-smoke.yml`](.github/workflows/compose-smoke.yml): start the whole stack with `docker compose up --build`
  and check `GET /health`.

## Learn step by step

[LEARNING_STEPS.md](LEARNING_STEPS.md) is the course built on this repository:

- [Prerequisites and tools](LEARNING_STEPS.md#prerequisites-and-tools)
- [Step 0. Setup: the Docker stack](LEARNING_STEPS.md#step-0-setup-the-docker-stack)
- [Step 1. MongoDB basics in mongosh](LEARNING_STEPS.md#step-1-mongodb-basics-in-mongosh)
- [Step 2. Web API on the MongoDB driver](LEARNING_STEPS.md#step-2-web-api-on-the-mongodb-driver)
- [Step 3. Automated tests on a real MongoDB](LEARNING_STEPS.md#step-3-automated-tests-on-a-real-mongodb)
- [Step 4. Transaction and transactional outbox](LEARNING_STEPS.md#step-4-transaction-and-transactional-outbox)
- [Step 5. The EF Core provider side by side with the driver](LEARNING_STEPS.md#step-5-the-ef-core-provider-side-by-side-with-the-driver)
- [Step 6. Change stream with a resume token](LEARNING_STEPS.md#step-6-change-stream-with-a-resume-token)

## License

[MIT](LICENSE) © 2026 Alexander Skrinnik
