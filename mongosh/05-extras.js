// Lesson 5. TTL indexes, partial indexes, schema validation and schema versioning.
// Run from src/:  docker compose exec mongo mongosh /mongosh/05-extras.js
// Better: open the shell, run `use lab`, paste the helper function `planStages` once, then the commands one by one.
// Needs 00-seed.js. Safe to re-run.
//
// What you learn and why:
//   Part 1. TTL index        - documents that delete themselves after a time (sessions, idempotency keys).
//   Part 2. Partial index    - an index over only some documents: smaller and cheaper.
//   Part 3. Schema validation - how the database rejects bad documents even though the schema is flexible.
//   Part 4. Schema versioning - how the document shape changes without migrations.
// These are the tools a payment service uses for temporary data, "stuck payment" checks and data quality.

db = db.getSiblingDB('lab'); // in a script; in the shell `use lab` does the same

function show(title, value) {
    print(`\n=== ${title}`);
    printjson(value);
}

// The same helper as in lesson 2: the stage names of the winning plan in one line.
function planStages(explain) {
    const winningPlan = explain.queryPlanner.winningPlan;
    let node = winningPlan.queryPlan ?? winningPlan;
    const stages = [];
    while (node) {
        stages.push(node.indexName ? `${node.stage}(${node.indexName})` : node.stage);
        node = node.inputStage ?? node.inputStages?.[0];
    }
    return stages.join(' -> ');
}

// =============================================================================
// Part 1. TTL index: documents that delete themselves
// =============================================================================
// Scenario: a 3-D Secure session (the bank asks the customer to confirm the payment) lives only a few minutes.
// After that the session is useless and must disappear. In SQL Server you would write a cleanup job.
// In MongoDB a TTL (time to live) index does it: a background task deletes documents whose date has passed.
//
// A TTL index is a normal index on a date field plus the option expireAfterSeconds:
//   - expireAfterSeconds: N - delete N seconds after the date in the field (e.g. createdAt + 3600);
//   - expireAfterSeconds: 0 - delete at the date in the field itself. Then each document chooses its own expiry
//     time in expiresAt. This is the form used here.
// The background task runs about every 60 seconds, so a document can live up to a minute longer than its time.
// Never rely on TTL for exact timing; check the expiry in code too.
db.threeDsSessions.drop();
db.threeDsSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const now = Date.now();
db.threeDsSessions.insertMany([
    { paymentId: UUID(), challenge: 'otp', expiresAt: new Date(now + 30 * 1000) }, // expires in 30 seconds
    { paymentId: UUID(), challenge: 'app', expiresAt: new Date(now + 60 * 60 * 1000) }, // expires in 1 hour
]);
show('3DS sessions now (2). Run db.getSiblingDB("lab").threeDsSessions.countDocuments() in 2 minutes: expect 1',
    db.threeDsSessions.countDocuments());
// Check now: 2. Check again after about 2 minutes: 1 (the 'otp' session is gone).

// =============================================================================
// Part 2. Partial index: index only the documents you query
// =============================================================================
// Scenario: a monitoring job looks for "stuck" payments: still Pending after a week. Only ~10% of payments are
// Pending. A normal index on createdAt would hold entries for all 200 000 payments, and every write would update it.
// A partial index holds entries only for documents that match partialFilterExpression.
// SQL Server: a filtered index, CREATE INDEX ... ON Payments (CreatedAt) WHERE Status = 'Pending'.
db.payments.createIndex(
    { createdAt: 1 },
    { name: 'ix_pending_createdAt', partialFilterExpression: { status: 'Pending' } });

const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

// The query contains status: 'Pending', so MongoDB knows that every matching document is in the partial index.
// explain() without arguments only plans the query; it does not run it.
show('stuck pending payments: plan', planStages(
    db.payments.find({ status: 'Pending', createdAt: { $lt: weekAgo } }).explain()));
// Check: FETCH -> IXSCAN(ix_pending_createdAt).

// Without status: 'Pending' the result may include Captured or Failed payments. They are not in the partial index,
// so MongoDB cannot use it and scans the collection.
show('same date filter without status: plan', planStages(
    db.payments.find({ createdAt: { $lt: weekAgo } }).explain()));
// Check: COLLSCAN. The rule: a query can use a partial index only if its filter implies the index filter.

show('index sizes (bytes): the partial index is small',
    db.payments.aggregate([{ $collStats: { storageStats: {} } }]).next().storageStats.indexSizes);
// Check: ix_pending_createdAt is several times smaller than a full single-field index (compare with customerId_1
// if lesson 2 created it).

// =============================================================================
// Part 3. Schema validation with $jsonSchema
// =============================================================================
// A collection accepts documents of any shape. That is flexible, but a bug in one service can write a payment with
// amount as a double or without a currency. A validator makes the database check every insert and update,
// like column types, NOT NULL and CHECK constraints in SQL Server.
//
// $jsonSchema describes the rules:
//   required    - fields that must exist (NOT NULL);
//   bsonType    - the stored type: 'string', 'decimal' (Decimal128), 'date', 'object', 'array', ...;
//   pattern     - a regular expression the string must match (a CHECK constraint);
//   enum        - the list of allowed values.
// Fields not listed in properties are allowed: the schema stays open for new fields.
// validationLevel 'strict' checks all inserts and updates. validationAction 'error' rejects a bad document;
// 'warn' would accept it and only write a warning to the server log.
// A new collection is used, so the seed data is not affected.
db.payments_validated.drop();
db.createCollection('payments_validated', {
    validator: {
        $jsonSchema: {
            bsonType: 'object',
            required: ['merchantId', 'idempotencyKey', 'amount', 'currency', 'status', 'createdAt'],
            properties: {
                merchantId: { bsonType: 'string' },
                idempotencyKey: { bsonType: 'string', minLength: 1 },
                amount: { bsonType: 'decimal', description: 'Decimal128, never double' },
                currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' }, // three capital letters, ISO 4217
                status: { enum: ['Pending', 'Authorized', 'Captured', 'Failed', 'Refunded'] },
                createdAt: { bsonType: 'date' },
            },
        },
    },
    validationLevel: 'strict',
    validationAction: 'error',
});

// A valid document. No _id is given, so MongoDB generates an ObjectId (12 bytes, starts with the creation time).
show('valid document', db.payments_validated.insertOne({
    merchantId: 'm1', idempotencyKey: 'v-1', amount: NumberDecimal('10.00'), currency: 'EUR', status: 'Pending', createdAt: new Date(),
}));
// Check: acknowledged: true and an ObjectId in insertedId.

// An invalid document with two mistakes: amount is a JS number (stored as double) and currency is lower case.
try {
    db.payments_validated.insertOne({
        merchantId: 'm1', idempotencyKey: 'v-2', amount: 10.5, currency: 'eur', status: 'Pending', createdAt: new Date(),
    });
} catch (e) {
    print(`\n=== invalid document rejected, code ${e.code} (DocumentValidationFailure)`);
    printjson(e.errInfo.details.schemaRulesNotSatisfied);
}
// Check: error code 121. The details name both broken rules: amount 'type did not match' (double instead of
// decimal) and currency 'regular expression did not match'. In the shell you can run the insertOne without
// try/catch and read the full error.

// =============================================================================
// Part 4. Schema versioning
// =============================================================================
// MongoDB has no migrations like EF Core. When the payment shape changes (for example, amount becomes amountMinor
// in cents), the old documents stay as they are. The common approach:
//   1. Every document has schemaVersion. The seed writes 1.
//   2. The new code can read both version 1 and version 2.
//   3. Documents are upgraded lazily when the code writes them, or by a background job in batches.
//   4. When no version 1 is left, the code for version 1 is removed.
// This query shows how many documents have each version. Today all have 1; exercise 1 adds version 2.
show('documents per schemaVersion', db.payments.aggregate([{ $sortByCount: '$schemaVersion' }]).toArray());

// =============================================================================
// Exercises
// =============================================================================
// 1. Version 2 stores the amount as amountMinor (long, in cents). Upgrade 1000 documents of m5 with an update
//    pipeline: updateMany({...}, [{ $set: { amountMinor: ... , schemaVersion: 2 } }, { $unset: 'amount' }]).
//    Then write one find() that returns the amount for both versions ($ifNull or $cond in an aggregation).
// 2. Change the validator with db.runCommand({ collMod: 'payments_validated', validator: {...} }) to also
//    require attempts as an array. What happens to existing documents? Read about validationLevel 'moderate'.
// 3. Create a TTL index that deletes Failed payments older than 90 days. Why can a TTL index not be
//    a compound index, and how does a partialFilterExpression help here?
// 4. Check db.threeDsSessions.countDocuments() after two minutes.
