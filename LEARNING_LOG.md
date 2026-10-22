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

Status: to do.

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
