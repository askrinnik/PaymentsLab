# PaymentsLab

Learning project about MongoDB with .NET: a small payments-gateway-like Web API built on the official
MongoDB C# driver. Not intended for production.

## Plan

0. Repository skeleton, Dockerfile, docker-compose (done).
1. MongoDB basics in mongosh: CRUD, indexes, `explain()`, aggregation (done).
2. Web API on the driver: idempotent `POST /payments`, `capture` with optimistic concurrency, merchant history
   (LINQ), merchant totals (aggregation pipeline), indexes created at startup. Manual requests: `payments.http` (done).
3. Tests on Testcontainers (`src/Payments.Tests`): idempotent retry, concurrent create and capture, merchant queries (done).
4. Transaction and outbox: capture updates the payment and publishes `PaymentCaptured` through the MassTransit
   MongoDB bus outbox in one transaction; the event reaches RabbitMQ and `PaymentCapturedConsumer`.
   Tests: one event per capture, one event for 10 concurrent captures, an aborted transaction leaves nothing (done).
5. EF Core provider side by side: `IPaymentService` with `PaymentService` (driver) and `EfPaymentService`
   (`MongoDB.EntityFrameworkCore`, `EfCore/`); the same endpoints are mapped twice, under "" and "/ef".
   Tests compare both on the same collection, including the raw BSON shape (done).
6. Change stream: `ChangeStreams/PaymentStatusWatcher` (`BackgroundService`) follows `payments`, logs every status
   change, writes the `paymentStatusHistory` projection (idempotent) and stores the resume token in
   `changeStreamCheckpoints`. Tests: both implementations are seen, a restarted watcher resumes, a new one starts now (done).

If the code needs to deviate from the plan, say so and explain why instead of silently changing the approach.

Explain MongoDB-specific choices by comparing them with SQL Server / EF Core where it helps.

## Stack

- .NET 10 (SDK installed), minimal APIs.
- MongoDB 8.0 in Docker, always as a single-node replica set (`rs0`) so transactions and change streams work.
- Official driver `MongoDB.Driver`; `MongoDB.EntityFrameworkCore` only for the optional comparison step.
- Tests: xUnit + `Testcontainers.MongoDb` with `.WithReplicaSet()`. No mocks for MongoDB.
- Messaging: MassTransit 8.5 on RabbitMQ with the MongoDB bus outbox. Stay on 8.x: MassTransit 9 needs a commercial
  license (8.x is Apache-2.0). Tests replace RabbitMQ with the MassTransit test harness but keep the same outbox.

## Layout and commands

- The repository root holds only general files: `README.md`, `CLAUDE.md`, git and editor settings.
- `mongosh/` holds the mongosh lessons (step 1). They use the database `lab`, not `payments`. The folder is
  mounted into the `mongo` container as `/mongosh`. Lessons must stay re-runnable.
- Everything related to the .NET build and Docker lives in `src/`: `PaymentsLab.slnx`, `global.json`,
  `Directory.Build.props`, `Dockerfile`, `.dockerignore`, `docker-compose.yml` and the projects.
- `Payments.Api` folders: `Domain/`, `Mongo/` (driver setup), `Payments/` (driver data access, shared endpoints),
  `EfCore/` (EF Core data access), `Messaging/` (MassTransit), `ChangeStreams/` (change stream watcher).
- Test projects live in `src/` next to the projects they test (for example `src/Payments.Tests`); there is no
  separate `tests/` folder.
- `Directory.Build.props` holds shared settings (net10.0, nullable, warnings as errors); keep `.csproj` files minimal.
- `docker-compose.yml` runs `mongo` (replica set `rs0`, initiated by its healthcheck), `rabbitmq` and `api`.

Run all commands from `src/`:

```powershell
dotnet build
dotnet test                                  # needs Docker: Testcontainers starts its own MongoDB
docker compose up -d --build --wait          # whole stack; API on http://localhost:8080
docker compose up -d --wait mongo rabbitmq   # infrastructure only, run the API with dotnet run
docker compose exec mongo mongosh            # interactive shell
docker compose down                          # stop; add -v to drop the mongo-data volume
```

Connection string from the host: `mongodb://localhost:27017/?replicaSet=rs0&directConnection=true`; inside
compose the host is `mongo`. `directConnection=true` is required because the replica set member is registered as
`localhost:27017`. GUI tools (Compass, VS Code extension) do not accept `replicaSet` together with
`directConnection`; give them `mongodb://localhost:27017/?directConnection=true`. Database `payments`. RabbitMQ UI: http://localhost:15672 (guest/guest).

## MongoDB conventions (mandatory)

- BSON mapping is global and lives in `Mongo/MongoSetup.cs`; domain classes have no MongoDB attributes:
  - money: `decimal` stored as `Decimal128` (`DecimalSerializer(BsonType.Decimal128)`), currency next to the amount.
    Never `double`;
  - `Guid`: `GuidSerializer(GuidRepresentation.Standard)`;
  - conventions: camelCase element names, `IgnoreExtraElements`, enums as strings.
- `DateTime` always UTC, truncated to milliseconds (MongoDB precision) before it is stored.
- `MongoClient` is a DI singleton; collections are resolved from it.
- Model aggregates for single-document atomicity first (payment attempts embedded, bounded); use multi-document
  transactions only where the plan asks for them (capture + outbox).
- Transactions with the MassTransit outbox: start them with MassTransit's `MongoDbContext.BeginTransaction` (the outbox
  needs its `TransactionId`), not with `session.WithTransactionAsync`; retry on the `TransientTransactionError`
  label (see `PaymentService.InTransactionAsync`).
- Idempotency: unique index on `idempotencyKey`; duplicate key (11000) means "return the stored result" if the
  request is the same (200), otherwise 422.
- Optimistic concurrency: the client sends the `ETag` it read in `If-Match`; the update filter contains that
  `version`, the update does `$inc`. Version mismatch -> 412, missing `If-Match` -> 428, wrong status -> 409.
- Indexes are created in code at startup (`Indexes.CreateManyAsync`); compound indexes follow the ESR rule.
- Write concern stays `majority` (the default); do not lower it.
- `PaymentsDbContext` must map exactly the same document shape as the driver conventions (element names, enums as
  strings, Decimal128). `EfCoreTests.Ef_and_driver_write_documents_of_the_same_shape` guards this.

## Working rules

- Work step by step following the plan; do one step per task and stop for review.
- Keep `LEARNING_LOG.md` in the repository root up to date: record the instructions given to the learner and the
  steps the learner reports as done, with the exact commands, so the whole path can be repeated later.
- Keep code small and readable; this is a learning project, so prefer clarity over abstractions.
- Code, comments, commit messages and repository files are in English.
- Never commit unless explicitly asked.
