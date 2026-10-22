# Learning log

Steps of the learning path in order, with the exact commands, so the whole path can be repeated.

## 2026-10-22. Install MongoDB Compass and connect to the local MongoDB

Status: done.

Prerequisite: MongoDB runs in Docker. From `src/`:

```powershell
docker compose up -d --wait mongo
```

1. Install MongoDB Compass (free GUI) with winget:

   ```powershell
   winget install --id MongoDB.Compass.Full -e
   ```

   Alternative: download the installer from https://www.mongodb.com/try/download/compass.

2. Open Compass and click **Add new connection**.
3. Paste this connection string into **URI**:

   ```text
   mongodb://localhost:27017/?directConnection=true
   ```

   Do not add `replicaSet=rs0`. Compass shows the error "directConnection is not supported with replicaSet"
   when both parameters are present. `directConnection=true` alone is enough: the node is still the primary of
   replica set `rs0`, so transactions and change streams work.
4. Click **Save & Connect**.
5. Check: the left panel shows the databases `admin`, `config`, `local` and, after the seed, `lab`.
   `admin`, `config` and `local` are system databases; do not change them.

The built-in shell is the **>_MONGOSH** panel at the bottom of the Compass window. Select the lesson database
there with `use lab`.

## 2026-10-22. Reset the lesson database `lab`

Status: done.

The database `lab` contains results of earlier test runs of all lessons: extra collections (`merchants`,
`payments_validated`, `threeDsSessions`), indexes and demo documents. Start the lessons from a clean state.

1. From `src/`, drop the whole database `lab`:

   ```powershell
   docker compose exec mongo mongosh --quiet --eval "db.getSiblingDB('lab').dropDatabase()"
   ```

   Expected output: `{ ok: 1, dropped: 'lab' }`.

2. Seed it again:

   ```powershell
   docker compose exec mongo mongosh /mongosh/00-seed.js
   ```

   Expected output ends with `Documents: 200000`, payment counts by status and one sample document.

3. In Compass, click the refresh button next to **CONNECTIONS**. Check: `lab` contains only `payments`, and its
   **Indexes** tab shows one index, `_id_`.

The same reset works at any time later, for example before repeating the lessons.

## 2026-10-22. How to run a mongosh lesson

This applies to every lesson in `mongosh/` (`01-crud.js` ... `05-extras.js`). Run the commands from `src/`.
MongoDB must be running (`docker compose up -d --wait mongo`) and `00-seed.js` must have been run once.

Way 1 - step by step (recommended for learning):

1. Open the shell: the **>_MONGOSH** panel in Compass, or

   ```powershell
   docker compose exec mongo mongosh
   ```

2. Select the lesson database:

   ```javascript
   use lab
   ```

3. Open the lesson file in an editor. The header lists the parts of the lesson and why they matter.
4. If the lesson has helper functions (lessons 2 and 5: `planStages`, `report`), paste them into the shell once.
5. Paste the commands one by one. Read the comment above each command first, and compare the result with the
   `Check:` / `Result:` comment below it. Paste a multi-line command or function as a whole.
6. Skip the `show(...)` wrapper: run the expression inside it, the shell prints the result itself. Example: instead
   of `show('findOne by _id', db.payments.findOne({ _id: id }))` run `db.payments.findOne({ _id: id })`.
7. Do the exercises at the end of the file.

Way 2 - the whole lesson at once (to see all results, or to restore the lesson state):

```powershell
docker compose exec mongo mongosh /mongosh/01-crud.js
```

Inside a shell opened with `docker compose exec mongo mongosh` the same is `load('/mongosh/01-crud.js')`. Lessons can be
loaded one after another, or again, in the same shell; no restart is needed. After `load()` the prompt shows `lab`:
the script switches the shell to the lesson database.
This does not work in the Compass shell: Compass runs on Windows, where the path `/mongosh` does not exist, and
its embedded shell does not support `load()`. In Compass use Way 1. Every lesson can be re-run.

The data is random, so numbers differ a little from the comments. To start over, reset the database (see above).

## 2026-10-22. Lesson 1: CRUD and update operators (`mongosh/01-crud.js`)

Status: done. Run it as described in "How to run a mongosh lesson".
Note: run the line `const id = UUID();` too; later commands use `id`.

## 2026-10-22. Lesson 2: indexes and explain() (`mongosh/02-indexes.js`)

Status: done. Paste the helpers `planStages` and `report` first; every query of the lesson is printed through
`report(...)`, so here keep the `report(...)` call instead of skipping it.

## 2026-10-22. Lesson 3: idempotency (`mongosh/03-idempotency.js`)

Status: done. Paste the functions `createPayment` and `upsertPayment` as a whole before calling them.

## 2026-10-22. Lesson 4: aggregation pipeline (`mongosh/04-aggregation.js`)

Status: done. Paste each pipeline (`db.payments.aggregate([...])`) as a whole. Run lesson 2 first: pipeline 2 uses
its index (it also works without it, only slower).

## 2026-10-22. Lesson 5: TTL, partial indexes, validation (`mongosh/05-extras.js`)

Status: done. Paste the helper `planStages` first. Check the TTL result again two minutes after Part 1.

## 2026-10-22. Step 2: Web API on the MongoDB driver

Status: done.

What was built (`src/Payments.Api`):

| File | What it shows |
|---|---|
| `Mongo/MongoSetup.cs` | Global BSON mapping (Guid, Decimal128, camelCase, enums as strings), `MongoClient` as a singleton |
| `Mongo/MongoIndexInitializer.cs` | Indexes created at startup: unique `idempotencyKey`, `{ merchantId: 1, createdAt: -1 }` |
| `Domain/Payment.cs` | The payment document with the embedded `attempts` array |
| `Payments/PaymentService.cs` | All MongoDB calls: insert + error 11000, `FindOneAndUpdate` with version, LINQ, aggregation |
| `Payments/PaymentEndpoints.cs` | HTTP: status codes, `Idempotency-Key`, `ETag` / `If-Match` |
| `payments.http` | Ready-made requests for every case |

### How to start the API

Visual Studio is not required. There are two ways; both can run at the same time.

```text
docker compose up ─► container api (port 8080) ─► container mongo
                     ▲
payments.http ───────┘  @baseUrl = http://localhost:8080
```

Way 1 - in Docker (`payments.http` is set up for this way):

1. From `src/`, build the API from the current code and start it with MongoDB and RabbitMQ. If the stack is
   already running, the command is safe to repeat:

   ```powershell
   docker compose up -d --build --wait
   ```

2. Open http://localhost:8080/health in a browser. Expected: `{"status":"ok","mongo":"ok"}`.

Way 2 - from Visual Studio (to use breakpoints and the debugger):

1. From `src/`, start only the infrastructure:

   ```powershell
   docker compose up -d --wait mongo rabbitmq
   ```

2. Open `src/PaymentsLab.slnx` in Visual Studio, select the launch profile **http** and press F5.
   The API listens on port 5113. Without Visual Studio the same is `dotnet run --project Payments.Api` from `src/`.
3. In `payments.http` change the first line to `@baseUrl = http://localhost:5113`.

Both ways use the same database `payments`. The container gets code changes only after
`docker compose up -d --build`; Visual Studio always runs the current code.

### How to send the requests

1. VS Code: install the REST Client extension once, then open `src/Payments.Api/payments.http` and click
   **Send Request** above each request:

   ```powershell
   code --install-extension humao.rest-client
   ```

   Visual Studio opens `.http` files itself (the **Send request** link above each request); no extension needed.
2. Send the requests from top to bottom. Request 1 creates a payment; requests 5-9 use its id automatically.
   Compare each response with the comment above the request: status code, `ETag` header, body.
3. In Compass, open the database `payments` (not `lab`), collection `payments`: check the stored document and the
   **Indexes** tab (`ux_idempotencyKey`, `ix_merchantId_createdAt`).
4. To run the requests again, change the `Idempotency-Key` in request 1 (for example `order-1002`), otherwise
   request 1 returns 200 with the old, already captured payment.

## 2026-10-22. Step 3: automated tests on a real MongoDB

Status: done.

What was built (`src/Payments.Tests`, xUnit):

```text
dotnet test ─► Testcontainers starts MongoDB 8.0 (single-node replica set) in Docker
            ─► WebApplicationFactory starts the API in memory, connected to that MongoDB
            ─► the tests send HTTP requests and check the responses and the stored documents
```

| File | What it checks |
|---|---|
| `PaymentsApiFixture.cs` | One MongoDB container and one API for the whole run; helpers for requests |
| `IdempotencyTests.cs` | retry -> 200 with the same payment; other body -> 422; no key -> 400; 10 parallel requests with one key -> one 201, one document |
| `CaptureTests.cs` | capture -> 200 and ETag "1"; 10 parallel captures -> one 200, nine 412; stale ETag on a Pending payment -> 412; 409, 428, 404 |
| `MerchantTests.cs` | history order, limit and date range; other merchants excluded; totals 0.10 + 0.20 = exactly 0.30 |

1. Start Docker Desktop. The docker-compose stack is not needed: the tests start their own MongoDB.
2. From `src/`, run all tests:

   ```powershell
   dotnet test
   ```

   Expected: `Passed! - Failed: 0, Passed: 16`. The first run downloads the `mongo:8.0` image if it is missing.
   Testcontainers removes its container after the run.
3. To run one test class: `dotnet test --filter "FullyQualifiedName~CaptureTests"`.
4. Visual Studio: **Test > Test Explorer**, then **Run All**.
5. Read the comments above the tests. Note `Capture_with_a_stale_etag_is_rejected_even_if_the_status_allows_it`:
   the parallel-capture test alone would pass even without the version check, because the status filter also stops
   a second capture. Only this test fails when the version is removed from the update filter (checked by hand).

## 2026-10-22. Step 4: transaction and transactional outbox

Status: done.

What was built:

```text
POST /payments/{id}/capture
  └─ one MongoDB transaction ─┬─ payments: status Captured, attempt, version + 1
                              └─ outbox.messages: PaymentCaptured (MassTransit bus outbox)
     commit
  └─ outbox delivery service (every second) ─► RabbitMQ ─► PaymentCapturedConsumer (log line)
```

| File | What it shows |
|---|---|
| `Messaging/MessagingSetup.cs` | MassTransit on RabbitMQ, MongoDB outbox with `UseBusOutbox()` |
| `Messaging/PaymentCaptured.cs`, `PaymentCapturedConsumer.cs` | The event and a consumer that logs it |
| `Payments/PaymentService.cs` | `CaptureAsync` in a transaction; `InTransactionAsync`: begin, commit, retry on `TransientTransactionError` |
| `Payments.Tests/OutboxTests.cs` | one event per capture; one event for 10 concurrent captures; an aborted transaction leaves nothing |

Notes:

- MassTransit is pinned to 8.5.12 (Apache-2.0). MassTransit 9 needs a commercial license.
- The plan said `session.WithTransactionAsync`. The MassTransit outbox cannot use it: the transaction must be started
  by MassTransit's `MongoDbContext.BeginTransaction`, which sets the `TransactionId` the outbox needs (without it:
  `ArgumentNullException: TransactionId`). `InTransactionAsync` does what `WithTransactionAsync` does: on a
  `TransientTransactionError` (a write conflict with a concurrent capture) it aborts and retries.

1. From `src/`, rebuild and start the stack:

   ```powershell
   docker compose up -d --build --wait
   ```

2. In `payments.http`, send request 1 (change the `Idempotency-Key` to a new value) and request 6 (capture).
3. Check that the event went through RabbitMQ to the consumer:

   ```powershell
   docker compose logs api | Select-String "PaymentCaptured received"
   ```

4. RabbitMQ UI: http://localhost:15672 (guest/guest), tab **Queues**: the queue `PaymentCaptured` and its message
   rates.
5. Compass, database `payments`: the collections `outbox.messages` (empty: delivered messages are removed),
   `outbox.states` and `inbox.states` were created by MassTransit.
6. From `src/`, run the tests (19 tests, about 15 seconds):

   ```powershell
   dotnet test
   ```

## 2026-10-22. Step 5: the EF Core provider side by side with the driver

Status: done.

What was built:

```text
/payments/...      ─┐                               ┌─► PaymentService     (MongoDB driver)
                    ├─► the same handlers ─► IPaymentService
/ef/payments/...   ─┘   (PaymentEndpoints)          └─► EfPaymentService   (MongoDB EF Core provider)
                                                              │
                                     both use the same collection payments
```

| File | What it shows |
|---|---|
| `Payments/IPaymentService.cs` | The common interface of both implementations |
| `Payments/PaymentEndpoints.cs` | `MapPaymentEndpoints<TService>(prefix)`: one set of HTTP rules, mapped twice in `Program.cs` |
| `EfCore/PaymentsDbContext.cs` | `UseMongoDB`; the document shape repeated by hand (element names, enums, Decimal128, owned `attempts`, `version` as concurrency token) |
| `EfCore/EfPaymentService.cs` | The same operations with `DbContext`; each workaround is explained in a comment |
| `Payments.Tests/EfCoreTests.cs` | Same behaviour, the same raw BSON shape, each side reads the other's documents, differences |

Differences found while building it (also in `README.md`):

- Capture: one atomic `FindOneAndUpdate` (driver) against read + `SaveChanges` with a concurrency token (EF Core).
  Without `IsConcurrencyToken()` the parallel-capture test fails (checked by hand).
- Event: the driver publishes it in the same transaction (outbox); EF Core publishes after `SaveChanges`, so a crash
  in between loses the event.
- Totals: EF Core cannot translate `GroupBy`; it loads all captured payments and groups in memory.
- Duplicate key: `SaveChanges` throws the driver's `MongoBulkWriteException` (not `DbUpdateException` as with
  SQL Server), and EF Core logs it as `fail: Microsoft.EntityFrameworkCore.Update` even though the code handles it.
- `Payments.Api.csproj` suppresses `AD0001`: the ASP.NET Core route handler analyzer crashes on the generic
  handlers. It is an analyzer bug, the code is valid.

1. From `src/`, rebuild and start the stack:

   ```powershell
   docker compose up -d --build --wait
   ```

2. In `payments.http`, run the section "The same endpoints with the EF Core provider" (requests EF 1 - EF 6).
   EF 2 reads the EF payment through the driver endpoint. Compare EF 5 and EF 6 with requests 10 and 12.
3. See the in-memory grouping in the log:

   ```powershell
   docker compose logs api | Select-String "EF Core totals"
   ```

4. From `src/`, run the tests (26 tests):

   ```powershell
   dotnet test
   ```

## 2026-10-22. Step 6: change stream with a resume token

Status: done.

What was built:

```text
payments ──write──► oplog ──change stream──► PaymentStatusWatcher ─┬─► log line
                                                                   ├─► paymentStatusHistory (projection)
                                                                   └─► changeStreamCheckpoints (resume token)
```

| File | What it shows |
|---|---|
| `ChangeStreams/PaymentStatusWatcher.cs` | `WatchAsync` with a server-side `$match` (inserts and updates of `status`), `ResumeAfter`, reopening after errors, history-lost handling (error 286) |
| `ChangeStreams/PaymentStatusChange.cs` | The projection document; `_id` = watcher + payment + version, so a replayed event is written once |
| `Payments.Tests/ChangeStreamTests.cs` | the watcher sees driver and EF Core writes; a restarted watcher catches up; a new watcher starts "from now" |

Notes:

- The plan said "log the status changes". The watcher also writes the `paymentStatusHistory` collection: the tests
  check it, and it shows the usual use of a change stream (a projection / audit trail) and why it must be idempotent
  (an event can arrive twice after a crash).
- Without `ResumeAfter` the restart test fails (checked by hand).
- Change stream vs outbox (step 4): the outbox sends the events the code decided to publish, in the same
  transaction; a change stream reports every change in the data, from any writer, with no code in the writers.

1. From `src/`, rebuild and start the stack:

   ```powershell
   docker compose up -d --build --wait
   ```

2. Create and capture a payment with `payments.http` (requests 1 and 6, new `Idempotency-Key`), then see the events:

   ```powershell
   docker compose logs api | Select-String "Change stream: payment"
   ```

3. A change from outside the API is seen too. Copy the payment id and change it in mongosh (Compass shell or
   `docker compose exec mongo mongosh payments`):

   ```javascript
   db.payments.updateOne({ _id: UUID('<payment id>') }, { $set: { status: 'Refunded' }, $inc: { version: 1 } })
   ```

4. Resume after a restart: stop the API, change a payment in mongosh as in item 3, start the API again:

   ```powershell
   docker compose stop api
   docker compose start api
   ```

   The log shows `Watching payments for status changes (resumed)` and then the change made while the API was down.
5. In Compass, database `payments`: collections `paymentStatusHistory` and `changeStreamCheckpoints`.
6. From `src/`, run the tests (30 tests):

   ```powershell
   dotnet test
   ```
