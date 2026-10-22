// Lesson 3. Idempotent payment creation with a unique index.
// Run from src/:  docker compose exec mongo mongosh /mongosh/03-idempotency.js
// Better: open the shell, run `use lab` and paste the commands one by one. Paste each function as a whole.
// Needs 00-seed.js. Safe to re-run.
//
// The problem:
//   A client sends POST /payments. The network times out, and the client does not know whether the payment was
//   created. It sends the same request again. Without protection the customer is charged twice.
//
// The solution:
//   The client generates a key once per payment and sends it in every retry (the Idempotency-Key header).
//   The service stores the key in the payment, and a UNIQUE index guarantees one document per key.
//   The first request creates the payment (201 Created). A retry hits the unique index, and the service returns
//   the payment it already has (200 OK). The customer is charged once.
//
// What you learn:
//   Part 1. Insert first, catch the duplicate key error 11000 - the approach the API will use.
//   Part 2. The alternative: upsert with $setOnInsert.
//   Part 3. The same key with a different request body - a case the API must handle.
//
// The uniqueness is checked by the database, not by the code. A "find, then insert if not found" check in code
// is not enough: two concurrent requests can both find nothing and both insert.

db = db.getSiblingDB('lab'); // in a script; in the shell `use lab` does the same

function show(title, value) {
    print(`\n=== ${title}`);
    printjson(value);
}

// SQL: CREATE UNIQUE INDEX UX_Payments_IdempotencyKey ON Payments (IdempotencyKey)
// The seed keys seed-0 .. seed-199999 are unique, so the index can be created on the existing data.
// createIndex is idempotent itself: if the same index already exists, it does nothing.
db.payments.createIndex({ idempotencyKey: 1 }, { unique: true, name: 'ux_idempotencyKey' });

// Remove the documents of a previous run of this lesson (keys idem-1, idem-2). /^idem-/ is a regular expression:
// "starts with idem-", like LIKE 'idem-%'.
db.payments.deleteMany({ idempotencyKey: /^idem-/ });

// =============================================================================
// Part 1. Insert first, handle the duplicate key error
// =============================================================================
// This function is the logic of the future POST /payments endpoint:
//   1. Build the new payment document from the request.
//   2. Try to insert it.
//   3. Success -> 201 Created with the new payment.
//   4. Error 11000 (duplicate key) -> this key was already used. Read the stored payment and return 200 OK.
//   5. Any other error -> it is a real failure, throw it.
// In C# the driver throws MongoWriteException with ServerErrorCategory.DuplicateKey; the logic is the same.
function createPayment(request) {
    const doc = {
        _id: UUID(),
        ...request, // copies merchantId, idempotencyKey, amount, currency from the request
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
        if (e.code !== 11000) throw e; // 11000 = duplicate key, like SQL Server errors 2601/2627
        print(`  duplicate key: ${JSON.stringify(e.keyValue)}`); // the error says which key value was a duplicate
        return { httpStatus: 200, payment: db.payments.findOne({ idempotencyKey: request.idempotencyKey }) };
    }
}

const request = { merchantId: 'm1', idempotencyKey: 'idem-1', amount: NumberDecimal('25.00'), currency: 'EUR' };

show('first call -> 201 Created', createPayment(request));
// Check: httpStatus 201 and a new payment with a new _id.

show('retry with the same key -> 200 OK with the stored payment', createPayment(request));
// Check: the line "duplicate key: {"idempotencyKey":"idem-1"}" is printed first (by the catch block).
// Then httpStatus 200 and the SAME _id and createdAt as in the first call: this is the stored payment.

show('documents with key idem-1', db.payments.countDocuments({ idempotencyKey: 'idem-1' }));
// Check: 1. Two calls, one payment.

// =============================================================================
// Part 2. Alternative: upsert with $setOnInsert
// =============================================================================
// upsert = update or insert. If the filter finds a document, it is updated; if not, a new one is inserted.
// SQL: MERGE Payments USING ... WHEN NOT MATCHED THEN INSERT ...
//
// $setOnInsert sets fields ONLY when a new document is inserted. On a match it does nothing, so the stored payment
// is never changed by a retry. The result counters tell which case happened:
//   upsertedCount 1 -> created now (201)        matchedCount 1 -> already existed (200)
//
// Advantage: one round trip, no exception. Disadvantage: the response does not contain the stored payment,
// a second read is needed to return it.
//
// The unique index is still required. Two concurrent upserts can both miss the document and both try to insert.
// Then the unique index rejects one of them. Since MongoDB 4.2 the server retries such an upsert itself when the
// filter is an equality match on the unique index key, so the losing call becomes a normal match.
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
// Check: upsertedCount 1, matchedCount 0, insertedId is the new _id.

show('upsert, retry (matchedCount 1, upsertedCount 0)', upsertPayment(request2));
// Check: matchedCount 1, modifiedCount 0 (nothing was changed), upsertedCount 0.

// =============================================================================
// Part 3. The same key with a different body
// =============================================================================
// A buggy client reuses the key idem-1 for a different payment of 99.00.
// createPayment hits the unique index and returns the OLD payment of 25.00 with 200 OK.
// The client thinks it paid 99.00, but the stored payment is 25.00. This is a bug.
// A correct API compares the new request with the stored payment and answers 422 Unprocessable Entity
// when they differ. Exercise 1 fixes it.
const conflicting = { ...request, amount: NumberDecimal('99.00') };
show('same key, different amount (returns the OLD payment - a bug to fix in the API)', createPayment(conflicting));
// Check: httpStatus 200 and amount 25.00, not 99.00.

// =============================================================================
// Exercises
// =============================================================================
// 1. Change createPayment to return 422 when amount, currency or merchantId differ from the stored payment.
//    Hint: store a hash of the request body in the document and compare hashes.
// 2. Keys should be unique per merchant, not globally. Create a unique compound index
//    { merchantId: 1, idempotencyKey: 1 }. What happens when it is created on the existing data?
// 3. Idempotency keys are needed for 24 hours only. Where would you keep them so that old keys disappear?
//    (See TTL indexes in lesson 5.)
// 4. Try db.payments.createIndex({ customerId: 1 }, { unique: true }). Read the error: why does it fail?
