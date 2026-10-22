# PaymentsLab

Learning project about MongoDB with .NET: a small payments-gateway-like Web API built on the official
MongoDB C# driver. Not intended for production.

## Plan

0. Repository skeleton, Dockerfile, docker-compose (done).
1. MongoDB basics in mongosh: CRUD, indexes, `explain()`, aggregation.
2. Web API on the driver: idempotent `POST /payments`, `capture` with optimistic concurrency, merchant history
   (LINQ), merchant totals (aggregation pipeline), indexes created at startup.
3. Tests on Testcontainers: idempotent retry, concurrent capture (200 + 409), transaction rollback.
4. Transaction and outbox: `WithTransactionAsync`, then MassTransit MongoDB outbox with a `PaymentCaptured` event.
5. Optional: second repository on the EF Core provider, compare with the driver.
6. Optional: change stream `BackgroundService` with a stored resume token.

If the code needs to deviate from the plan, say so and explain why instead of silently changing the approach.

Explain MongoDB-specific choices by comparing them with SQL Server / EF Core where it helps.

## Stack

- .NET 10 (SDK installed), minimal APIs.
- MongoDB 8.0 in Docker, always as a single-node replica set (`rs0`) so transactions and change streams work.
- Official driver `MongoDB.Driver`; `MongoDB.EntityFrameworkCore` only for the optional comparison step.
- Tests: xUnit + `Testcontainers.MongoDb` with `.WithReplicaSet()`. No mocks for MongoDB.
- Messaging (step 4): MassTransit on RabbitMQ with the MongoDB outbox.

## Layout and commands

- The repository root holds only general files: `README.md`, `CLAUDE.md`, git and editor settings.
- `mongosh/` holds the mongosh lessons (step 1). They use the database `lab`, not `payments`. The folder is
  mounted into the `mongo` container as `/mongosh`. Lessons must stay re-runnable.
- Everything related to the .NET build and Docker lives in `src/`: `PaymentsLab.slnx`, `global.json`,
  `Directory.Build.props`, `Dockerfile`, `.dockerignore`, `docker-compose.yml` and the projects.
- Test projects live in `src/` next to the projects they test (for example `src/Payments.Tests`); there is no
  separate `tests/` folder.
- `Directory.Build.props` holds shared settings (net10.0, nullable, warnings as errors); keep `.csproj` files minimal.
- `docker-compose.yml` runs `mongo` (replica set `rs0`, initiated by its healthcheck), `rabbitmq` and `api`.

Run all commands from `src/`:

```powershell
dotnet build
docker compose up -d --build --wait          # whole stack; API on http://localhost:8080
docker compose up -d --wait mongo rabbitmq   # infrastructure only, run the API with dotnet run
docker compose exec mongo mongosh            # interactive shell
docker compose down                          # stop; add -v to drop the mongo-data volume
```

Connection string from the host: `mongodb://localhost:27017/?replicaSet=rs0&directConnection=true`; inside
compose the host is `mongo`. `directConnection=true` is required because the replica set member is registered as
`localhost:27017`. Database `payments`. RabbitMQ UI: http://localhost:15672 (guest/guest).

## MongoDB conventions (mandatory)

- Money: `decimal` with `[BsonRepresentation(BsonType.Decimal128)]`, currency stored next to the amount. Never `double`.
- `Guid`: register `GuidSerializer(GuidRepresentation.Standard)` once at startup.
- Conventions: `CamelCaseElementNameConvention` and `IgnoreExtraElementsConvention(true)`.
- Enums stored as strings (`[BsonRepresentation(BsonType.String)]`).
- `DateTime` always UTC.
- `MongoClient` is a DI singleton; collections are resolved from it.
- Model aggregates for single-document atomicity first (payment attempts embedded, bounded); use multi-document
  transactions only where the guide asks for them (capture + outbox).
- Idempotency: unique index on `idempotencyKey`; duplicate key (11000) means "return the stored result".
- Optimistic concurrency: `Version` field in the update filter plus `$inc`; `ModifiedCount == 0` means 409.
- Indexes are created in code at startup (`Indexes.CreateManyAsync`); compound indexes follow the ESR rule.
- Write concern stays `majority` (the default); do not lower it.

## Working rules

- Work step by step following the guide; do one step per task and stop for review.
- Keep code small and readable; this is a learning project, so prefer clarity over abstractions.
- Code, comments, commit messages and repository files are in English.
- Never commit unless explicitly asked.
