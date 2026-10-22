// Lesson 5. TTL indexes, partial indexes and schema validation.
// Run from src/:  docker compose exec mongo mongosh /mongosh/05-extras.js
// Needs 00-seed.js. Safe to re-run.

db = db.getSiblingDB('lab');

function show(title, value) {
    print(`\n=== ${title}`);
    printjson(value);
}

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

// --- 1. TTL index: documents that delete themselves --------------------------
// 3-D Secure sessions live for a short time. With expireAfterSeconds: 0 each document expires at the time
// in its expiresAt field. SQL Server has no such feature: you would write a cleanup job.
// A background task removes expired documents about every 60 seconds, so deletion is not instant.
db.threeDsSessions.drop();
db.threeDsSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const now = Date.now();
db.threeDsSessions.insertMany([
    { paymentId: UUID(), challenge: 'otp', expiresAt: new Date(now + 30 * 1000) },
    { paymentId: UUID(), challenge: 'app', expiresAt: new Date(now + 60 * 60 * 1000) },
]);
show('3DS sessions now (2). Run db.getSiblingDB("lab").threeDsSessions.countDocuments() in 2 minutes: expect 1',
    db.threeDsSessions.countDocuments());

// --- 2. Partial index: index only the documents you query --------------------
// Only Pending payments need a "stuck payments" query. A partial index is smaller and cheaper to update.
// SQL: CREATE INDEX ... WHERE Status = 'Pending' (a filtered index).
db.payments.createIndex(
    { createdAt: 1 },
    { name: 'ix_pending_createdAt', partialFilterExpression: { status: 'Pending' } });

const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
// The filter includes status: 'Pending', so the planner may use the partial index.
show('stuck pending payments: plan', planStages(
    db.payments.find({ status: 'Pending', createdAt: { $lt: weekAgo } }).explain()));
// Without status: 'Pending' the partial index cannot answer the query: it does not contain other statuses.
show('same date filter without status: plan', planStages(
    db.payments.find({ createdAt: { $lt: weekAgo } }).explain()));
show('index sizes (bytes): the partial index is small',
    db.payments.aggregate([{ $collStats: { storageStats: {} } }]).next().storageStats.indexSizes);

// --- 3. Schema validation with $jsonSchema -----------------------------------
// The schema is flexible, but the database can still reject bad documents.
// validationAction 'error' rejects them; 'warn' only writes to the log.
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
                currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
                status: { enum: ['Pending', 'Authorized', 'Captured', 'Failed', 'Refunded'] },
                createdAt: { bsonType: 'date' },
            },
        },
    },
    validationLevel: 'strict',
    validationAction: 'error',
});

// No _id is given, so MongoDB generates an ObjectId (12 bytes, starts with the creation time).
show('valid document', db.payments_validated.insertOne({
    merchantId: 'm1', idempotencyKey: 'v-1', amount: NumberDecimal('10.00'), currency: 'EUR', status: 'Pending', createdAt: new Date(),
}));

try {
    // amount is a JS number (double) and currency is lower case.
    db.payments_validated.insertOne({
        merchantId: 'm1', idempotencyKey: 'v-2', amount: 10.5, currency: 'eur', status: 'Pending', createdAt: new Date(),
    });
} catch (e) {
    print(`\n=== invalid document rejected, code ${e.code} (DocumentValidationFailure)`);
    printjson(e.errInfo.details.schemaRulesNotSatisfied);
}

// --- 4. Schema versioning ----------------------------------------------------
// There are no migrations. Each document carries schemaVersion; the code reads all versions and upgrades
// documents when it writes them, or a background job upgrades them in batches.
show('documents per schemaVersion', db.payments.aggregate([{ $sortByCount: '$schemaVersion' }]).toArray());

// --- Exercises ---------------------------------------------------------------
// 1. Version 2 stores the amount as amountMinor (long, in cents). Upgrade 1000 documents of m5 with an update
//    pipeline: updateMany({...}, [{ $set: { amountMinor: ... , schemaVersion: 2 } }, { $unset: 'amount' }]).
//    Then write one find() that returns the amount for both versions ($ifNull or $cond in an aggregation).
// 2. Change the validator with db.runCommand({ collMod: 'payments_validated', validator: {...} }) to also
//    require attempts as an array. What happens to existing documents? Read about validationLevel 'moderate'.
// 3. Create a TTL index that deletes Failed payments older than 90 days. Why can a TTL index not be
//    a compound index, and how does a partialFilterExpression help here?
// 4. Check db.threeDsSessions.countDocuments() after two minutes.
