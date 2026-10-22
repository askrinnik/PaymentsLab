// Lesson 3. Idempotent payment creation with a unique index.
// Run from src/:  docker compose exec mongo mongosh /mongosh/03-idempotency.js
// Needs 00-seed.js. Safe to re-run.
//
// A client retries POST /payments after a timeout. The retry must not charge the customer twice.
// The client sends the same Idempotency-Key header; the database guarantees one document per key.

db = db.getSiblingDB('lab');

function show(title, value) {
    print(`\n=== ${title}`);
    printjson(value);
}

// SQL: CREATE UNIQUE INDEX UX_Payments_IdempotencyKey ON Payments (IdempotencyKey)
// Creating an index that already exists with the same options does nothing.
db.payments.createIndex({ idempotencyKey: 1 }, { unique: true, name: 'ux_idempotencyKey' });
db.payments.deleteMany({ idempotencyKey: /^idem-/ });

// --- 1. Insert first, handle the duplicate key error -------------------------
// This is the logic of the future POST /payments endpoint.
function createPayment(request) {
    const doc = {
        _id: UUID(),
        ...request,
        status: 'Pending',
        attempts: [],
        createdAt: new Date(),
        version: 0,
        schemaVersion: 1,
    };
    try {
        db.payments.insertOne(doc);
        return { httpStatus: 201, payment: doc };
    } catch (e) {
        if (e.code !== 11000) throw e; // 11000 = duplicate key, like SQL Server error 2601
        print(`  duplicate key: ${JSON.stringify(e.keyValue)}`);
        return { httpStatus: 200, payment: db.payments.findOne({ idempotencyKey: request.idempotencyKey }) };
    }
}

const request = { merchantId: 'm1', idempotencyKey: 'idem-1', amount: NumberDecimal('25.00'), currency: 'EUR' };
show('first call -> 201 Created', createPayment(request));
show('retry with the same key -> 200 OK with the stored payment', createPayment(request));
show('documents with key idem-1', db.payments.countDocuments({ idempotencyKey: 'idem-1' }));

// --- 2. Alternative: upsert with $setOnInsert --------------------------------
// One round trip. $setOnInsert writes fields only when the document is created.
// upsertedCount tells you which call created it. The unique index is still required: two concurrent upserts
// can both miss the document. MongoDB retries such an upsert itself when the filter is an equality match
// on the unique index key, so the losing call becomes a normal match instead of an error.
function upsertPayment(request) {
    return db.payments.updateOne(
        { idempotencyKey: request.idempotencyKey },
        {
            $setOnInsert: {
                _id: UUID(),
                merchantId: request.merchantId,
                amount: request.amount,
                currency: request.currency,
                status: 'Pending',
                attempts: [],
                createdAt: new Date(),
                version: 0,
                schemaVersion: 1,
            },
        },
        { upsert: true });
}

const request2 = { merchantId: 'm1', idempotencyKey: 'idem-2', amount: NumberDecimal('40.00'), currency: 'EUR' };
show('upsert, first call (upsertedCount 1)', upsertPayment(request2));
show('upsert, retry (matchedCount 1, upsertedCount 0)', upsertPayment(request2));

// --- 3. The same key with a different body -----------------------------------
// The retry below has the same key but another amount. The code above silently returns the old payment.
// A real API should compare the request with the stored one and answer 422 Unprocessable Entity.
const conflicting = { ...request, amount: NumberDecimal('99.00') };
show('same key, different amount (returns the OLD payment - a bug to fix in the API)', createPayment(conflicting));

// --- Exercises ---------------------------------------------------------------
// 1. Change createPayment to return 422 when amount, currency or merchantId differ from the stored payment.
//    Hint: store a hash of the request body in the document and compare hashes.
// 2. Keys should be unique per merchant, not globally. Create a unique compound index
//    { merchantId: 1, idempotencyKey: 1 }. What happens when it is created on the existing data?
// 3. Idempotency keys are needed for 24 hours only. Where would you keep them so that old keys disappear?
//    (See TTL indexes in lesson 5.)
// 4. Try db.payments.createIndex({ customerId: 1 }, { unique: true }). Read the error: why does it fail?
