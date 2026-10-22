# Learning MongoDB with .NET: step by step

This guide takes you from an empty machine to a small payments Web API on MongoDB 8.0 and .NET 10. You run every
step yourself, check the result, and read the code that implements it. The guide assumes you know C# and some
SQL Server / EF Core; MongoDB is new to you.

```text
Step 0  Setup             tools, Docker stack, Compass
Step 1  mongosh lessons   CRUD, indexes, idempotency, aggregation, TTL / validation   (database lab)
Step 2  Web API           idempotent create, capture with ETag, history, totals        (database payments)
Step 3  Tests             Testcontainers: a real MongoDB per test run
Step 4  Outbox            capture + event in one transaction, RabbitMQ
Step 5  EF Core           the same API with the MongoDB EF Core provider, side by side
Step 6  Change stream     follow every change of payments, resume after a restart
```

Every step has the same parts: **Goal**, **Run**, **Check**, **Files**, **Key concepts** (with a comparison to
SQL Server / EF Core) and **Pitfalls**.

Commands are for PowerShell on Windows. Most of them work the same in bash; where they differ, the bash form is
given too. Unless a step says otherwise, run commands from the `src/` folder of the repository.

## Contents

- [Prerequisites and tools](#prerequisites-and-tools)
- [Step 0. Setup: the Docker stack](#step-0-setup-the-docker-stack)
- [Step 1. MongoDB basics in mongosh](#step-1-mongodb-basics-in-mongosh)
- [Step 2. Web API on the MongoDB driver](#step-2-web-api-on-the-mongodb-driver)
- [Step 3. Automated tests on a real MongoDB](#step-3-automated-tests-on-a-real-mongodb)
- [Step 4. Transaction and transactional outbox](#step-4-transaction-and-transactional-outbox)
- [Step 5. The EF Core provider side by side with the driver](#step-5-the-ef-core-provider-side-by-side-with-the-driver)
- [Step 6. Change stream with a resume token](#step-6-change-stream-with-a-resume-token)
- [Command reference](#command-reference)

## Prerequisites and tools

| Tool | Why | Install |
|---|---|---|
| .NET 10 SDK | Build, run and test the API (`src/global.json` asks for 10.0.402 or a later feature band) | https://dotnet.microsoft.com/download |
| Docker Desktop | Runs MongoDB, RabbitMQ and the API; the tests start their own MongoDB in Docker | https://www.docker.com/products/docker-desktop |
| Git | Get the repository | https://git-scm.com |
| MongoDB Compass | Free GUI: browse documents and indexes, built-in mongosh panel | see below |
| VS Code + REST Client, or Visual Studio | Send the requests in `src/Payments.Api/payments.http` | see below |

Check the versions:

```powershell
dotnet --version     # 10.0.x
docker --version
docker compose version
```

Get the repository and go to `src/`:

```powershell
git clone https://github.com/askrinnik/PaymentsLab.git
cd PaymentsLab/src
```

### MongoDB Compass

1. Install it with winget, or download the installer from https://www.mongodb.com/try/download/compass:

   ```powershell
   winget install --id MongoDB.Compass.Full -e
   ```

2. Start MongoDB first (Step 0), then open Compass and click **Add new connection**.
3. Paste this connection string into **URI**:

   ```text
   mongodb://localhost:27017/?directConnection=true
   ```

   Do not add `replicaSet=rs0`. Compass shows the error "directConnection is not supported with replicaSet" when
   both parameters are present. `directConnection=true` alone is enough: the node is still the primary of the
   replica set `rs0`, so transactions and change streams work. The same string works for the MongoDB for VS Code
   extension.
4. Click **Save & Connect**.
5. Check: the left panel shows the databases `admin`, `config` and `local`. They are system databases; do not
   change them. `lab` appears after the seed (Step 1), `payments` after the first start of the API (Step 2).

The built-in shell is the **>_MONGOSH** panel at the bottom of the Compass window. Select a database there with
`use lab` or `use payments`.

Why the API uses another string: the .NET driver accepts `mongodb://localhost:27017/?replicaSet=rs0&directConnection=true`.
`directConnection=true` is required in both strings, because the replica set member is registered as
`localhost:27017`. Inside Docker Compose the API container reaches MongoDB as `mongo`, not `localhost`; without
`directConnection` the driver would try to connect to `localhost:27017` inside the API container and fail.

### Sending HTTP requests

- VS Code: install the REST Client extension once, then open `src/Payments.Api/payments.http` and click
  **Send Request** above a request:

  ```powershell
  code --install-extension humao.rest-client
  ```

- Visual Studio opens `.http` files itself (the **Send request** link above each request); no extension is needed.
- JetBrains Rider opens `.http` files too.

## Step 0. Setup: the Docker stack

### Goal

Run MongoDB 8.0 as a single-node replica set, RabbitMQ and the API with one command, and understand why MongoDB is
a replica set even on a developer machine.

### Run

From `src/`:

```powershell
docker compose up -d --wait mongo            # only MongoDB: enough for Step 1
docker compose up -d --wait mongo rabbitmq   # infrastructure only: run the API yourself (Step 2, way 2)
docker compose up -d --build --wait          # the whole stack: mongo, rabbitmq and api (built from the code)
docker compose ps                            # state of the containers
docker compose exec mongo mongosh            # interactive shell inside the mongo container (exit with: exit)
docker compose down                          # stop and remove the containers, keep the data
docker compose down -v                       # the same, and drop the mongo-data volume (all data)
```

`--wait` returns when every started container is healthy. The first start downloads the images.

### Check

- `docker compose ps` shows `mongo` and `rabbitmq` (and `api`, after the full start) with status `healthy` or `Up`.
- The replica set is initiated:

  ```powershell
  docker compose exec mongo mongosh --quiet --eval "rs.status().members[0].stateStr"
  ```

  Expected output: `PRIMARY`.
- After the full start, http://localhost:8080/health returns `{"status":"ok","mongo":"ok"}`.
- Compass connects with the string from [MongoDB Compass](#mongodb-compass).

### Files

| File | What it does |
|---|---|
| `src/docker-compose.yml` | Services `mongo` (replica set `rs0`, initiated by its healthcheck, volume `mongo-data`, `../mongosh` mounted as `/mongosh`), `rabbitmq` (with the management UI) and `api` |
| `src/Dockerfile` | Two-stage build of `Payments.Api`: SDK image to publish, ASP.NET image to run |
| `src/global.json` | Pins the .NET SDK (10.0.402, `rollForward: latestFeature`) |
| `src/Directory.Build.props` | Shared settings for all projects: `net10.0`, nullable, warnings as errors |
| `src/PaymentsLab.slnx` | The solution: `Payments.Api` and `Payments.Tests` |

### Key concepts

- **Replica set.** A group of `mongod` servers with one primary and copies (secondaries). Transactions and change
  streams work only on a replica set, so even the local MongoDB runs as a single-node replica set `rs0`. SQL Server
  has transactions on a single instance; MongoDB needs the replication log (the oplog) for them.
- **Healthcheck initiates the replica set.** A new replica set must be initiated once with `rs.initiate`. The
  healthcheck does it on the first start and reports healthy only when the node is the primary, so
  `docker compose up --wait` returns when MongoDB is writable.
- **No schema, no migrations step.** There is no `CREATE DATABASE` or `CREATE TABLE`: a database and a collection
  appear on the first insert. Indexes are created by code (Step 2), like EF Core migrations would create them, but
  at application start.

### Pitfalls

- The member is registered as `localhost:27017`. Clients outside the container must use `directConnection=true`;
  otherwise the driver discovers the member `localhost:27017` and connects there, which is wrong inside another
  container.
- GUI tools reject `replicaSet` together with `directConnection` (see Compass above).
- `docker compose down -v` deletes all data, including the lesson database `lab`. Use it only to start from zero.
- Ports 27017, 5672, 15672 and 8080 must be free. A locally installed MongoDB service also listens on 27017.

## Step 1. MongoDB basics in mongosh

### Goal

Learn the MongoDB query language in the shell before you write C#: CRUD and update operators, indexes and
`explain()`, idempotency with a unique index, the aggregation pipeline, TTL and partial indexes, schema validation.
The lessons use the database `lab` with 200 000 generated payments; they never touch the API database `payments`.

### Run

MongoDB must run (`docker compose up -d --wait mongo`). The folder `mongosh/` of the repository is mounted into
the container as `/mongosh`, so the container sees the lesson files.

**1. Seed the lesson database** (once, and again whenever you want to start over). From `src/`:

```powershell
docker compose exec mongo mongosh /mongosh/00-seed.js
```

Expected output ends with `Documents: 200000`, the payment counts by status and one sample document.
`00-seed.js` drops and recreates `lab.payments`, so it is safe to repeat.

**2. Reset the lesson database** (optional). The lessons create extra collections (`merchants`,
`payments_validated`, `threeDsSessions`), indexes and demo documents. To remove all of them, drop the whole
database and seed again:

```powershell
docker compose exec mongo mongosh --quiet --eval "db.getSiblingDB('lab').dropDatabase()"
docker compose exec mongo mongosh /mongosh/00-seed.js
```

Expected output of the first command: `{ ok: 1, dropped: 'lab' }`. In Compass, click the refresh button next to
**CONNECTIONS**: `lab` contains only `payments`, and its **Indexes** tab shows one index, `_id_`.

**3. Run a lesson.** There are five lessons, `01-crud.js` ... `05-extras.js`. Do them in order.

Way 1 - step by step (recommended for learning):

1. Open a shell: the **>_MONGOSH** panel in Compass, or from `src/`:

   ```powershell
   docker compose exec mongo mongosh
   ```

2. Select the lesson database:

   ```javascript
   use lab
   ```

3. Open the lesson file (`mongosh/01-crud.js` and so on) in an editor. The header lists the parts of the lesson and
   why they matter.
4. If the lesson has helper functions, paste them into the shell once (see the table below).
5. Paste the commands one by one. Read the comment above each command first, and compare the result with the
   `Check:` / `Result:` comment below it. Paste a multi-line command or a function as a whole.
6. Skip the `show(...)` wrapper: run the expression inside it, the shell prints the result itself. Example: instead
   of `show('findOne by _id', db.payments.findOne({ _id: id }))` run `db.payments.findOne({ _id: id })`.
7. Do the exercises at the end of the file.

Way 2 - the whole lesson at once (to see all results, or to restore the state of a lesson). From `src/`:

```powershell
docker compose exec mongo mongosh /mongosh/01-crud.js
```

Inside a shell opened with `docker compose exec mongo mongosh` the same is:

```javascript
load('/mongosh/01-crud.js')
```

Lessons can be loaded one after another, or again, in the same shell; no restart is needed. After `load()` the
prompt shows `lab`: the script switches the shell to the lesson database. Every lesson can be re-run.

The data is random, so your numbers differ a little from the numbers in the comments.

| Lesson | Topic | Notes for Way 1 |
|---|---|---|
| `01-crud.js` | insert, find, projections, query operators, arrays, `$elemMatch`, update operators, optimistic concurrency, delete | Run the line `const id = UUID();` too; later commands use `id` |
| `02-indexes.js` | `explain()`, `COLLSCAN` vs `IXSCAN`, compound indexes, the ESR rule, covered queries, multikey indexes, index cost | Paste the helpers `planStages` and `report` first. Every query is printed through `report(...)`, so keep the `report(...)` call here |
| `03-idempotency.js` | unique index, duplicate key error 11000, upsert with `$setOnInsert`, the same key with another body | Paste the functions `createPayment` and `upsertPayment` as a whole before you call them |
| `04-aggregation.js` | `$match`, `$group`, `$sort`, `$project`, `$unwind`, `$lookup`, `$facet`, `$bucket` | Paste each pipeline (`db.payments.aggregate([...])`) as a whole. Do lesson 2 first: pipeline 2 uses its index (without it the pipeline is only slower) |
| `05-extras.js` | TTL index, partial index, `$jsonSchema` validation, schema versioning | Paste the helper `planStages` first. Check the TTL result again two minutes after Part 1 |

### Check

- Every lesson prints results with `===` titles (Way 2), or the shell prints them (Way 1). Compare them with the
  `Check:` / `Result:` comments.
- In Compass, open `lab` > `payments`: the **Documents** tab shows the documents, the **Indexes** tab shows the
  indexes the lesson created, the **Explain Plan** tab shows the same plans as `explain()`.
- `mongosh/README.md` has ten self-check questions. Answer them after lesson 5.

### Files

| File | What it contains |
|---|---|
| `mongosh/00-seed.js` | 200 000 synthetic payments in `lab.payments`: 5 merchants, 3 currencies, 5 statuses, 1 year, embedded `attempts` |
| `mongosh/01-crud.js` ... `mongosh/05-extras.js` | The lessons, with SQL equivalents in the comments and exercises at the end |
| `mongosh/README.md` | Short overview of the lessons and the self-check questions |

### Key concepts

- **Document and embedding.** A payment is one document with its attempts embedded as an array. In SQL Server it
  would be two tables and a JOIN; in MongoDB one read returns the whole aggregate, and one write to one document is
  atomic. Embed what is read together and bounded in size; keep unbounded or shared data (merchants) in a separate
  collection.
- **Types.** `UUID('...')` is a GUID, `Decimal128('10.50')` an exact decimal (SQL `decimal`), `ISODate('...')` a UTC
  date. A JS number is a `double`: never use it for money.
- **Update operators.** `$set`, `$inc`, `$push`, `$pull` change parts of a document on the server, like
  `UPDATE ... SET Col = Col + 1`. The result counters (`matchedCount`, `modifiedCount`) are how code learns what
  happened, like `@@ROWCOUNT`.
- **Indexes and `explain()`.** `COLLSCAN` is a table scan, `IXSCAN` an index seek, `FETCH` a key lookup.
  `explain('executionStats')` is the execution plan of SQL Server Management Studio. A good plan reads about as many
  keys and documents as it returns.
- **The ESR rule.** In a compound index put fields in this order: Equality, Sort, Range. It is the MongoDB
  version of "equality columns first" for SQL Server indexes; lesson 2 also shows when the rule does not win.
- **Aggregation pipeline.** A list of stages, like a chain of LINQ methods: `$match` = `WHERE`, `$group` =
  `GROUP BY`, `$lookup` = `LEFT JOIN`, `$project` = the `SELECT` list. Put `$match` first: only the first stages
  can use indexes.
- **TTL index.** MongoDB deletes expired documents itself; in SQL Server you would write a cleanup job.

### Pitfalls

- `load()` does not work in the Compass shell: Compass runs on Windows, where the path `/mongosh` does not exist,
  and its embedded shell does not support `load()`. In Compass use Way 1.
- In lesson 1, forgetting `const id = UUID();` makes the later commands fail with `id is not defined`.
- A multi-line function or pipeline pasted line by line fails with a syntax error. Paste it as a whole.
- The TTL monitor runs about once a minute, so an expired document is not deleted at the exact second.
- `use lab` works only in an interactive shell. Scripts use `db = db.getSiblingDB('lab')` instead.

## Step 2. Web API on the MongoDB driver

### Goal

Build the payments API on the official MongoDB C# driver:

- `POST /payments` is idempotent: the `Idempotency-Key` header and a unique index give one payment per key;
- `POST /payments/{id}/capture` uses optimistic concurrency: the client sends the `ETag` it read in `If-Match`;
- merchant history with LINQ, merchant totals with an aggregation pipeline;
- the BSON mapping is global, indexes are created at startup.

| Endpoint | Result |
|---|---|
| `POST /payments` | `Idempotency-Key` required: 201 created, 200 retry with the same body, 422 the key reused with another body, 400 no key |
| `GET /payments/{id}` | The payment, its version in `ETag` |
| `POST /payments/{id}/capture` | `If-Match` with the ETag: 200 captured, 412 version changed, 409 wrong status, 428 no `If-Match`, 404 unknown id |
| `GET /merchants/{merchantId}/payments?from=&to=&limit=` | Newest payments of a merchant (`from` included, `to` excluded, `limit` 1-100, default 20) |
| `GET /merchants/{merchantId}/totals` | Captured amount and count per currency |

### Run

There are two ways to start the API; both can run at the same time.

```text
docker compose up ─► container api (port 8080) ─► container mongo
                     ▲
payments.http ───────┘  @baseUrl = http://localhost:8080
```

Way 1 - in Docker (`payments.http` is set up for this way). From `src/`, build the API from the current code and
start it with MongoDB and RabbitMQ. The command is safe to repeat while the stack is running:

```powershell
docker compose up -d --build --wait
```

Way 2 - from the IDE or `dotnet run` (to use breakpoints and the debugger):

1. From `src/`, start only the infrastructure:

   ```powershell
   docker compose up -d --wait mongo rabbitmq
   ```

2. Open `src/PaymentsLab.slnx` in Visual Studio, select the launch profile **http** and press F5. Without Visual
   Studio, from `src/`:

   ```powershell
   dotnet run --project Payments.Api
   ```

   The API listens on http://localhost:5113.
3. In `payments.http` change the first line to `@baseUrl = http://localhost:5113`.

Both ways use the same database `payments`. The container gets code changes only after
`docker compose up -d --build`; Visual Studio and `dotnet run` always run the current code.

Send the requests:

1. Open `src/Payments.Api/payments.http` (VS Code with REST Client, Visual Studio or Rider).
2. Send the requests from top to bottom. Request 1 creates a payment; requests 5-9 use its id automatically.
   Compare each response with the comment above the request: status code, `ETag` header, body.
3. To run the requests again, change the `Idempotency-Key` in request 1 (for example `order-1002`). Otherwise
   request 1 returns 200 with the old, already captured payment, and request 6 returns 409.

Without an `.http` client, the same in PowerShell:

```powershell
Invoke-RestMethod http://localhost:8080/health
$headers = @{ 'Idempotency-Key' = 'ps-order-1' }
$body = '{ "merchantId": "shop-1", "customerId": "c-42", "amount": 25.00, "currency": "EUR" }'
Invoke-WebRequest http://localhost:8080/payments -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

### Check

- `GET /health` (request "Health" in `payments.http`, or http://localhost:8080/health in a browser):
  `{"status":"ok","mongo":"ok"}`.
- Requests 1-12 return the status codes in their comments: 201, 200, 422, 400, 200, 200, 412, 409, 428, 200, 200,
  200. Request 6 returns `ETag: "1"`; request 7 returns 412 with the current ETag.
- Request 12 (totals): amounts are exact decimals (`0.10 + 0.20` is `0.30`, not `0.30000000000000004`).
- Compass, database `payments` (not `lab`), collection `payments`: the stored document with `_id` as `UUID`,
  `amount` as `Decimal128`, `status` as a string, the `attempts` array and `version`. The **Indexes** tab shows
  `ux_idempotencyKey` (unique) and `ix_merchantId_createdAt`.
- The API log (`docker compose logs api`) has the line `MongoDB indexes ensured: ux_idempotencyKey, ix_merchantId_createdAt`.

### Files

All in `src/Payments.Api`:

| File | What it shows |
|---|---|
| `Mongo/MongoSetup.cs` | Global BSON mapping (Guid, Decimal128, camelCase, enums as strings, ignore extra elements), `MongoClient` as a singleton |
| `Mongo/MongoIndexInitializer.cs` | Indexes created at startup: unique `idempotencyKey`, `{ merchantId: 1, createdAt: -1 }` |
| `Domain/Payment.cs`, `Domain/Attempt.cs`, `Domain/PaymentStatus.cs` | The payment document with the embedded `attempts` array; no MongoDB attributes |
| `Payments/PaymentService.cs` | All MongoDB calls: insert + error 11000, `FindOneAndUpdate` with the version, LINQ, aggregation |
| `Payments/PaymentEndpoints.cs` | HTTP: status codes, `Idempotency-Key`, `ETag` / `If-Match`, validation |
| `Payments/PaymentRules.cs` | Shared rules: capturable statuses, "same request", UTC time truncated to milliseconds, duplicate key detection |
| `Payments/ETag.cs` | Version as an HTTP entity tag (`"3"`) |
| `Program.cs` | Composition: Mongo, messaging, both data access implementations, the watcher, `/health` |
| `payments.http` | Ready-made requests for every case |

### Key concepts

- **Global mapping instead of attributes.** `MongoSetup.RegisterConventions` maps all domain types once: camelCase
  element names, enums as strings, `decimal` as `Decimal128`, `Guid` as the standard UUID. It is the counterpart of
  `OnModelCreating` in EF Core, but for the whole application and without a model class per entity.
- **`MongoClient` is a singleton.** It holds the connection pool and is thread-safe. Unlike a `DbContext`, it is
  never created per request.
- **Idempotency with a unique index.** The service inserts first. A duplicate key error (code 11000) means "this
  key exists": the service reads the stored payment and returns 200 if the body is the same, otherwise 422. A
  "find, then insert" check in code is not enough: two concurrent requests can both find nothing. SQL Server: a
  unique index and error 2627/2601.
- **Optimistic concurrency with `FindOneAndUpdate`.** One atomic command: filter `_id + version + allowed status`,
  update `$set status`, `$push attempt`, `$inc version`. If nothing matched, the service reads the payment once more
  to choose 404, 412 or 409. EF Core with SQL Server does the same with a `rowversion` column and
  `DbUpdateConcurrencyException`, but needs a read first.
- **LINQ and aggregation.** The history query is LINQ (`AsQueryable`), translated into `find + sort + limit` and
  served by the ESR index. The totals use the fluent aggregation API: `$match -> $group -> $sort`, computed on the
  server.
- **Dates.** MongoDB stores milliseconds in UTC. The API truncates `DateTime` to milliseconds before it stores it,
  so the 201 response shows the same `createdAt` as every later read. Query dates without an offset are taken as
  UTC.

### Pitfalls

- Driver 3.x throws on `Guid` without an explicit representation: register `GuidSerializer(GuidRepresentation.Standard)`.
- Without the `Decimal128` serializer the driver stores `decimal` as a string; with `double` money loses precision.
- A `DateTime` with more precision than milliseconds comes back different after a round trip, so equality checks
  in tests fail.
- Repeating `payments.http` without a new `Idempotency-Key` returns the old payment (200), not a new one.
- `If-Match` must be a quoted strong ETag (`"0"`); `0` without quotes returns 400.

## Step 3. Automated tests on a real MongoDB

### Goal

Test the API against a real MongoDB replica set, started by the tests themselves, without mocks: idempotent
retries, concurrent creates and captures, merchant queries.

```text
dotnet test ─► Testcontainers starts MongoDB 8.0 (single-node replica set) in Docker
            ─► WebApplicationFactory starts the API in memory, connected to that MongoDB
            ─► the tests send HTTP requests and check the responses and the stored documents
```

### Run

1. Start Docker Desktop. The docker-compose stack is not needed: the tests start their own MongoDB and do not touch
   the database of docker-compose.
2. From `src/`, run all tests:

   ```powershell
   dotnet test
   ```

3. To run one test class:

   ```powershell
   dotnet test --filter "FullyQualifiedName~CaptureTests"
   ```

4. Visual Studio: **Test > Test Explorer**, then **Run All**.

### Check

- With all steps of this repository: `Passed! - Failed: 0, Passed: 30` (16 tests belong to Step 3, the others to
  Steps 4-6). The first run downloads the `mongo:8.0` image if it is missing; Testcontainers removes its container
  after the run.
- While the tests run, `docker ps` shows a `mongo:8.0` container with a random port, and a `testcontainers/ryuk`
  container that cleans up.

### Files

All in `src/Payments.Tests`:

| File | What it checks |
|---|---|
| `PaymentsApiFixture.cs` | One MongoDB container (`.WithReplicaSet()`) and one API for the whole run; helpers for requests |
| `IdempotencyTests.cs` | Retry -> 200 with the same payment; other body -> 422; `25.0` and `25.00` are the same request; no key -> 400; 10 parallel requests with one key -> one 201, one document |
| `CaptureTests.cs` | Capture -> 200 and ETag "1"; 10 parallel captures -> one 200, nine 412; stale ETag on a Pending payment -> 412; 409, 428, 404 |
| `MerchantTests.cs` | History order, limit and date range; other merchants excluded; totals 0.10 + 0.20 = exactly 0.30 |

### Key concepts

- **Testcontainers instead of mocks or an in-memory provider.** EF Core users often test with the InMemory or SQLite
  provider; it hides real behaviour (unique indexes, transactions, concurrency). Here every test runs against a real
  `mongod`, like a SQL Server container in tests.
- **One container per run.** Starting MongoDB takes seconds, so the fixture shares one container and one API
  (`WebApplicationFactory<Program>`) across all tests. Tests stay independent by using unique merchant ids and
  idempotency keys.
- **Concurrency tests.** Ten parallel requests with `Task.WhenAll` prove that the unique index and the version
  filter decide, not timing luck.

### Pitfalls

- Docker must run before `dotnet test`; otherwise Testcontainers fails at once with a Docker connection error.
- `.WithReplicaSet()` is required: without it the transaction and change stream tests (Steps 4 and 6) fail.
- The parallel-capture test alone would pass even without the version check, because the status filter also stops
  a second capture. `Capture_with_a_stale_etag_is_rejected_even_if_the_status_allows_it` is the test that fails when
  the version is removed from the update filter. Try it: remove the version from the filter in `CaptureAsync` and
  run the tests.

## Step 4. Transaction and transactional outbox

### Goal

When a payment is captured, publish the integration event `PaymentCaptured` to RabbitMQ without losing it and
without sending it for a capture that did not happen. The capture and the event are written in one MongoDB
transaction (the transactional outbox pattern, with the MassTransit MongoDB bus outbox).

```text
POST /payments/{id}/capture
  └─ one MongoDB transaction ─┬─ payments: status Captured, attempt, version + 1
                              └─ outbox.messages: PaymentCaptured (MassTransit bus outbox)
     commit
  └─ outbox delivery service (every second) ─► RabbitMQ ─► PaymentCapturedConsumer (log line)
```

### Run

1. From `src/`, rebuild and start the stack:

   ```powershell
   docker compose up -d --build --wait
   ```

2. In `payments.http`, send request 1 (change the `Idempotency-Key` to a new value) and request 6 (capture).
3. Check that the event went through RabbitMQ to the consumer:

   ```powershell
   docker compose logs api | Select-String "PaymentCaptured received"
   ```

   In bash: `docker compose logs api | grep "PaymentCaptured received"`.
4. From `src/`, run the tests:

   ```powershell
   dotnet test --filter "FullyQualifiedName~OutboxTests"
   ```

### Check

- The log shows `PaymentCaptured received: <payment id> 25.00 EUR (merchant shop-1)` about a second after the
  capture.
- RabbitMQ UI: http://localhost:15672 (user `guest`, password `guest`), tab **Queues and Streams**: the queue
  `PaymentCaptured` and its message rates.
- Compass, database `payments`: the collections `outbox.messages` (empty: delivered messages are removed),
  `outbox.states` and `inbox.states` were created by MassTransit.
- The three `OutboxTests` pass.

### Files

| File | What it shows |
|---|---|
| `src/Payments.Api/Messaging/MessagingSetup.cs` | MassTransit on RabbitMQ, MongoDB outbox with `UseBusOutbox()`, the same `MongoClient` and database |
| `src/Payments.Api/Messaging/PaymentCaptured.cs`, `PaymentCapturedConsumer.cs` | The event and a consumer that logs it |
| `src/Payments.Api/Payments/PaymentService.cs` | `CaptureAsync` in a transaction; `InTransactionAsync`: begin, commit, retry on `TransientTransactionError` |
| `src/Payments.Tests/OutboxTests.cs` | One event per capture; one event for 10 concurrent captures; an aborted transaction leaves nothing |
| `src/Payments.Tests/PaymentsApiFixture.cs` | Replaces RabbitMQ with the MassTransit test harness but keeps the same MongoDB outbox |

### Key concepts

- **Single-document atomicity first.** A write to one document is atomic, so the payment and its attempts need no
  transaction. A multi-document transaction is used only where two documents must change together: the payment and
  the outbox message.
- **Transactional outbox.** With `UseBusOutbox()`, `IPublishEndpoint.Publish` does not send to RabbitMQ. It inserts
  the message into `outbox.messages` with the current MongoDB session, so the message commits or aborts with the
  payment. A background delivery service sends committed messages to RabbitMQ. With EF Core and SQL Server the same
  pattern is the MassTransit Entity Framework outbox: the message row is saved in the same `SaveChanges`.
- **Transactions in MongoDB.** `BEGIN TRAN ... COMMIT` maps to `StartTransaction` / `CommitTransaction` on a
  session; every operation in the transaction must get the session. A write conflict with a concurrent transaction
  is an error with the label `TransientTransactionError`: abort and run the whole transaction again (SQL Server: a
  retry loop for deadlock victims).
- **At-least-once delivery.** The delivery service can send a message twice (crash after send, before delete). A
  real consumer must be idempotent; the inbox (`inbox.states`) helps with that.

### Pitfalls

- MassTransit is pinned to 8.5 (8.5.12, Apache-2.0). MassTransit 9 needs a commercial license. Do not upgrade the
  package to 9.x.
- The outbox needs the transaction to be started by MassTransit's `MongoDbContext.BeginTransaction`, which sets the
  `TransactionId` the outbox stores with each message. The driver's `session.WithTransactionAsync` does not set it;
  the publish then fails with `ArgumentNullException: TransactionId`. So `InTransactionAsync` does what
  `WithTransactionAsync` would do: on a `TransientTransactionError` it aborts and retries.
- The outbox must use the application's `MongoClient` and database (`ClientFactory`, `DatabaseFactory`); otherwise
  it writes outside the transaction.
- `outbox.messages` is empty after a successful delivery. An empty collection is the expected state, not a bug.

## Step 5. The EF Core provider side by side with the driver

### Goal

Implement the same endpoints with the MongoDB EF Core provider (`MongoDB.EntityFrameworkCore`) and compare it with
the driver on the same collection: what works the same, what needs a workaround, what is not possible.

```text
/payments/...      ─┐                               ┌─► PaymentService     (MongoDB driver)
                    ├─► the same handlers ─► IPaymentService
/ef/payments/...   ─┘   (PaymentEndpoints)          └─► EfPaymentService   (MongoDB EF Core provider)
                                                              │
                                     both use the same collection payments
```

### Run

1. From `src/`, rebuild and start the stack:

   ```powershell
   docker compose up -d --build --wait
   ```

2. In `payments.http`, run the section "The same endpoints with the EF Core provider" (requests EF 1 - EF 6).
   EF 2 reads the EF payment through the driver endpoint. Compare EF 5 and EF 6 with requests 10 and 12.
   To repeat the section, change the `Idempotency-Key` in EF 1.
3. See the in-memory grouping in the log:

   ```powershell
   docker compose logs api | Select-String "EF Core totals"
   ```

   In bash: `docker compose logs api | grep "EF Core totals"`.
4. From `src/`, run the tests:

   ```powershell
   dotnet test --filter "FullyQualifiedName~EfCoreTests"
   ```

### Check

- EF 1 returns 201 with `Location: /ef/payments/{id}`, EF 2 returns the same payment through `/payments/{id}`,
  EF 3 returns 200 with `ETag: "1"`, EF 4 returns 412.
- EF 5 and EF 6 return the same data as requests 10 and 12.
- The log shows `EF Core totals for shop-1: loaded N documents to group them in memory`.
- Compass: a document written through `/ef` has the same shape as one written through `/payments` (camelCase
  names, `status` as a string, `amount` as `Decimal128`).
- The seven `EfCoreTests` pass.

### Files

| File | What it shows |
|---|---|
| `src/Payments.Api/Payments/IPaymentService.cs` | The common interface of both implementations |
| `src/Payments.Api/Payments/PaymentEndpoints.cs` | `MapPaymentEndpoints<TService>(prefix)`: one set of HTTP rules, mapped twice in `Program.cs` |
| `src/Payments.Api/EfCore/PaymentsDbContext.cs` | `UseMongoDB`; the document shape repeated by hand (element names, enums, Decimal128, owned `attempts`, `version` as concurrency token) |
| `src/Payments.Api/EfCore/EfPaymentService.cs` | The same operations with `DbContext`; each workaround is explained in a comment |
| `src/Payments.Tests/EfCoreTests.cs` | Same behaviour, the same raw BSON shape, each side reads the other's documents, the differences |

### Key concepts

| Operation | Driver | EF Core provider |
|---|---|---|
| Create, read, history | insert, find, LINQ | `Add` + `SaveChanges`, LINQ |
| Duplicate key | `MongoWriteException` | `MongoBulkWriteException` from `SaveChanges` |
| Capture | one atomic `FindOneAndUpdate` (`$set`, `$push`, `$inc`, version in the filter) | read, change, `SaveChanges` with `version` as concurrency token |
| Capture event | same transaction as the update (outbox) | published after `SaveChanges`: lost if the process stops in between |
| Totals | `$group` on the server | `GroupBy` not supported: all captured payments loaded and grouped in memory |
| Mapping | global BSON conventions | repeated by hand in `PaymentsDbContext` |
| Indexes, transactions with the outbox | yes | no (indexes are created by the driver at startup) |

- **Familiar model, MongoDB storage.** `DbContext`, `DbSet`, change tracking, `OwnsMany` for the embedded array,
  `IsConcurrencyToken()` for the version: the same API as with SQL Server. `ToCollection` and `HasElementName`
  replace `ToTable` and `HasColumnName`.
- **Own model, not the driver conventions.** The provider ignores the BSON conventions of `MongoSetup`. The shape
  must be repeated by hand, and a test (`Ef_and_driver_write_documents_of_the_same_shape`) compares the raw BSON of
  both sides.
- **When to choose which.** EF Core is fine for simple CRUD with LINQ. The driver gives atomic update operators,
  aggregation, transactions shared with other libraries and index management.

### Pitfalls

- The duplicate key error from `SaveChanges` is the driver's `MongoBulkWriteException`, not `DbUpdateException` as
  with SQL Server. EF Core also logs it as `fail: Microsoft.EntityFrameworkCore.Update` even though the code
  handles it, so an error line in the log after EF 1 is repeated is expected.
- Without `IsConcurrencyToken()` on `version` the parallel-capture test fails: both captures win.
- `GroupBy` and `Select` projections are not translated; the totals load whole documents.
- The MassTransit MongoDB outbox needs its own `MongoDbContext` session, and the MassTransit EF Core outbox supports
  relational databases only, so the EF Core capture has no transactional outbox.
- `Payments.Api.csproj` suppresses `AD0001`: the ASP.NET Core route handler analyzer crashes on the generic
  handlers, and warnings as errors would turn the crash into a build error. It is an analyzer bug; the code is valid.

## Step 6. Change stream with a resume token

### Goal

Follow every change of the `payments` collection, from any writer, with a background service: log each status
change, write an idempotent projection `paymentStatusHistory`, and store the resume token so that a restarted
service continues where it stopped.

```text
payments ──write──► oplog ──change stream──► PaymentStatusWatcher ─┬─► log line
                                                                   ├─► paymentStatusHistory (projection)
                                                                   └─► changeStreamCheckpoints (resume token)
```

### Run

1. From `src/`, rebuild and start the stack:

   ```powershell
   docker compose up -d --build --wait
   ```

2. Create and capture a payment with `payments.http` (requests 1 and 6, new `Idempotency-Key`), then see the events:

   ```powershell
   docker compose logs api | Select-String "Change stream: payment"
   ```

   In bash: `docker compose logs api | grep "Change stream: payment"`.
3. A change from outside the API is seen too. Copy the payment id from the response of request 1 and change the
   payment in mongosh (the Compass shell after `use payments`, or from `src/`:
   `docker compose exec mongo mongosh payments`):

   ```javascript
   db.payments.updateOne({ _id: UUID('<payment id>') }, { $set: { status: 'Refunded' }, $inc: { version: 1 } })
   ```

   Run the log command of item 2 again.
4. Resume after a restart: stop the API, change a payment in mongosh as in item 3 (for example set `status` to
   `'Failed'`), and start the API again. From `src/`:

   ```powershell
   docker compose stop api
   docker compose start api
   ```

5. From `src/`, run the tests:

   ```powershell
   dotnet test --filter "FullyQualifiedName~ChangeStreamTests"
   ```

### Check

- Item 2: two lines, `... is Pending (version 0, Insert)` and `... is Captured (version 1, Update)`.
- Item 3: a line `... is Refunded (version 2, Update)`, although the API did not make the change.
- Item 4: after the start the log shows `Watching payments for status changes (resumed)` and then the change made
  while the API was down.
- Compass, database `payments`: `paymentStatusHistory` has one document per payment version (`_id` =
  `payment-status-watcher:<payment id>:<version>`), `changeStreamCheckpoints` has one document with the last
  `resumeToken`.
- The `ChangeStreamTests` pass, and a full `dotnet test` reports 30 passed tests.

### Files

| File | What it shows |
|---|---|
| `src/Payments.Api/ChangeStreams/PaymentStatusWatcher.cs` | `WatchAsync` with a server-side `$match` (inserts and updates of `status`), `ResumeAfter`, reopening after errors, history-lost handling (error 286) |
| `src/Payments.Api/ChangeStreams/PaymentStatusChange.cs` | The projection document; `_id` = watcher + payment + version, so a replayed event is written once |
| `src/Payments.Tests/ChangeStreamTests.cs` | The watcher sees driver and EF Core writes; a restarted watcher catches up; a new watcher starts "from now" |

### Key concepts

- **Change stream = change data capture.** The server reads its replication log (the oplog) and sends every
  matching change to the client. SQL Server has CDC or Change Tracking for this; in MongoDB it needs a replica set.
  The `$match` runs on the server, so only inserts and status updates reach the application.
- **Resume token.** Every event has a token. The watcher stores it after each event; on restart it opens the stream
  with `ResumeAfter` and gets everything after that event. If the oplog no longer contains it (error 286), the
  watcher starts from now; a real system would rebuild the projection.
- **Idempotent projection.** An event can be processed twice (a crash after the projection write, before the token
  write). The projection `_id` is built from watcher, payment and version, and the write is an upsert, so a replay
  changes nothing.
- **Change stream vs outbox.** The outbox (Step 4) sends the events the code decided to publish, in the same
  transaction. A change stream reports every change in the data, from any writer (driver, EF Core, mongosh), with no
  code in the writers.

### Pitfalls

- Change streams need a replica set; on a standalone `mongod` `Watch` fails.
- Without `ResumeAfter` the restart test fails: changes made while the watcher was stopped are lost.
- An update that does not touch `status` produces no event: the `$match` filters it on the server.
- The oplog has a limited size. A watcher stopped for a long time cannot resume and must start again.

## Command reference

From `src/`:

```powershell
dotnet build
dotnet test                                  # needs Docker: Testcontainers starts its own MongoDB
dotnet test --filter "FullyQualifiedName~CaptureTests"
dotnet run --project Payments.Api            # API on http://localhost:5113; needs mongo and rabbitmq
docker compose up -d --build --wait          # whole stack; API on http://localhost:8080
docker compose up -d --wait mongo rabbitmq   # infrastructure only
docker compose up -d --wait mongo            # MongoDB only, for the mongosh lessons
docker compose exec mongo mongosh            # interactive shell
docker compose exec mongo mongosh payments   # interactive shell in the API database
docker compose exec mongo mongosh /mongosh/00-seed.js
docker compose exec mongo mongosh /mongosh/01-crud.js
docker compose exec mongo mongosh --quiet --eval "db.getSiblingDB('lab').dropDatabase()"
docker compose logs api                      # API log
docker compose stop api                      # stop only the API
docker compose start api
docker compose down                          # stop; add -v to drop the mongo-data volume
```

| Service | Address |
|---|---|
| API | http://localhost:8080 (Docker), http://localhost:5113 (`dotnet run`, Visual Studio) |
| MongoDB from the .NET driver | `mongodb://localhost:27017/?replicaSet=rs0&directConnection=true` |
| MongoDB from Compass / VS Code extension | `mongodb://localhost:27017/?directConnection=true` |
| RabbitMQ | `amqp://localhost:5672`, UI http://localhost:15672 (guest/guest) |
