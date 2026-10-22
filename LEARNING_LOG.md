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
