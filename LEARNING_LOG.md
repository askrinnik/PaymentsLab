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

Status: to do.

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
