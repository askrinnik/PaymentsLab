# mongosh lessons

Hands-on lessons for the MongoDB shell. They use the database `lab`, so they do not touch the `payments`
database of the API. This is Step 1 of the course: see
[LEARNING_STEPS.md](../LEARNING_STEPS.md#step-1-mongodb-basics-in-mongosh) for the full instructions (seed, reset,
how to run a lesson step by step, notes per lesson, pitfalls).

| File | Topic |
|---|---|
| `00-seed.js` | 200 000 synthetic payments in `lab.payments` (5 merchants, 3 currencies, 5 statuses, 1 year) |
| `01-crud.js` | insert, find, projections, query operators, arrays, `$elemMatch`, update operators, optimistic concurrency |
| `02-indexes.js` | `explain()`, `COLLSCAN` vs `IXSCAN`, compound indexes, the ESR rule, covered queries, multikey indexes |
| `03-idempotency.js` | unique index, duplicate key error 11000, upsert with `$setOnInsert` |
| `04-aggregation.js` | `$match`, `$group`, `$unwind`, `$lookup`, `$facet`, `$bucket` |
| `05-extras.js` | TTL index, partial index, `$jsonSchema` validation, schema versioning |

## Run

Start MongoDB from `src/`; the folder is mounted into the container as `/mongosh`:

```powershell
cd src
docker compose up -d --wait mongo
docker compose exec mongo mongosh /mongosh/00-seed.js
```

A whole lesson at once:

```powershell
docker compose exec mongo mongosh /mongosh/02-indexes.js
```

The better way to learn: open the shell, select the database and paste the commands one by one.

```powershell
docker compose exec mongo mongosh
```

```javascript
db = db.getSiblingDB('lab')
db.payments.findOne()
```

`load('/mongosh/02-indexes.js')` inside this shell runs a lesson too (not in the Compass shell: there `/mongosh` does
not exist and `load()` is not supported). Every lesson can be re-run; `00-seed.js`
drops and recreates the collection with all its indexes.

GUI: MongoDB Compass or the MongoDB for VS Code extension, connection string
`mongodb://localhost:27017/?directConnection=true`. Compass rejects `replicaSet` together with
`directConnection`; without `replicaSet` it still connects to the replica set primary.

## Self-check questions

1. Why are payment attempts embedded in the payment, but merchants are a separate collection?
2. What is the difference between `{ 'attempts.result': 'Declined', 'attempts.provider': 'Klarna' }` and the same
   filter with `$elemMatch`?
3. How does the `version` field protect a payment from a lost update? What does the API return when
   `matchedCount` is 0?
4. What do `totalKeysExamined`, `totalDocsExamined` and `nReturned` tell you? What are good values?
5. What does the ESR rule say, and when did the E-R-S index win in lesson 2? Why?
6. What makes a query covered?
7. What happens on a retry with the same idempotency key? What should happen if the body is different?
8. Why must `$match` be the first stage of a pipeline? Why is `$lookup` after `$group` in lesson 4?
9. When does a TTL index delete a document? Why is a partial index used only for some queries?
10. How do you change the document shape without migrations?
