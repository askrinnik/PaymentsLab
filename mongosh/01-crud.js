// Lesson 1. CRUD and update operators.
// Run from src/:  docker compose exec mongo mongosh /mongosh/01-crud.js
// Better: open `docker compose exec mongo mongosh`, run `db = db.getSiblingDB('lab')`
// and paste the commands one by one. Needs 00-seed.js. Safe to re-run.

db = db.getSiblingDB('lab');

function show(title, value) {
    print(`\n=== ${title}`);
    printjson(value);
}

// Demo documents use merchantId 'demo', so the seed data stays untouched.
db.payments.deleteMany({ merchantId: 'demo' });

// --- 1. Insert ---------------------------------------------------------------
// SQL: INSERT INTO Payments (...) VALUES (...)
// No table definition was needed: the collection accepts any document shape.
const id = UUID();
show('insertOne', db.payments.insertOne({
    _id: id,
    merchantId: 'demo',
    customerId: 'c1',
    idempotencyKey: 'demo-1',
    amount: NumberDecimal('10.50'),
    currency: 'EUR',
    status: 'Pending',
    attempts: [],
    createdAt: new Date(),
    version: 0,
    schemaVersion: 1,
}));

show('insertMany', db.payments.insertMany([
    { _id: UUID(), merchantId: 'demo', idempotencyKey: 'demo-2', amount: NumberDecimal('5.00'), currency: 'EUR', status: 'Pending', attempts: [], createdAt: new Date(), version: 0, schemaVersion: 1 },
    { _id: UUID(), merchantId: 'demo', idempotencyKey: 'demo-3', amount: NumberDecimal('7.25'), currency: 'SEK', status: 'Pending', attempts: [], createdAt: new Date(), version: 0, schemaVersion: 1 },
]));

// --- 2. Read -----------------------------------------------------------------
// SQL: SELECT * FROM Payments WHERE Id = @id
show('findOne by _id', db.payments.findOne({ _id: id }));

// SQL: SELECT TOP 5 Id, Amount, Currency, CreatedAt FROM Payments
//      WHERE MerchantId = 'm2' AND Currency = 'SEK' AND Amount >= 500 ORDER BY CreatedAt DESC
// The second argument is a projection; _id is returned unless you exclude it with _id: 0.
show('filter + projection + sort + limit', db.payments
    .find(
        { merchantId: 'm2', currency: 'SEK', amount: { $gte: NumberDecimal('500') } },
        { amount: 1, currency: 1, createdAt: 1 })
    .sort({ createdAt: -1 })
    .limit(5)
    .toArray());

// Comparison and logical operators: $eq $ne $gt $gte $lt $lte $in $nin $and $or $not $exists.
// SQL: WHERE Status IN ('Failed', 'Refunded') AND (Currency = 'NOK' OR Amount < 2)
show('$in + $or count', db.payments.countDocuments({
    status: { $in: ['Failed', 'Refunded'] },
    $or: [{ currency: 'NOK' }, { amount: { $lt: NumberDecimal('2') } }],
}));

// countDocuments runs a real query; estimatedDocumentCount reads collection metadata (fast, no filter).
show('estimatedDocumentCount', db.payments.estimatedDocumentCount());

// --- 3. Query inside arrays --------------------------------------------------
// A dot path matches if ANY array element matches. There is no JOIN: attempts are inside the payment.
// The two conditions below may match DIFFERENT elements of the same array...
show('declined + Klarna, any elements', db.payments.countDocuments({
    'attempts.result': 'Declined',
    'attempts.provider': 'Klarna',
}));
// ...while $elemMatch requires ONE element to match both. Compare the two numbers.
show('declined + Klarna, same element ($elemMatch)', db.payments.countDocuments({
    attempts: { $elemMatch: { result: 'Declined', provider: 'Klarna' } },
}));
// Array size: payments that needed three or more attempts.
show('3+ attempts', db.payments.countDocuments({ 'attempts.2': { $exists: true } }));

// --- 4. Update operators -----------------------------------------------------
// Update only changes the listed fields: $set, $unset, $inc, $push, $pull, $addToSet, $currentDate.
// Optimistic concurrency: the version is part of the filter, like rowversion in a WHERE clause.
// SQL: UPDATE Payments SET Status = 'Captured', Version = Version + 1 WHERE Id = @id AND Version = 0
show('capture with version 0', db.payments.updateOne(
    { _id: id, version: 0 },
    {
        $set: { status: 'Captured' },
        $push: { attempts: { at: new Date(), provider: 'Adyen', result: 'OK' } },
        $inc: { version: 1 },
    }));

// The same update again: the version is now 1, so matchedCount is 0. The API will answer 409 Conflict.
show('capture with stale version 0', db.payments.updateOne(
    { _id: id, version: 0 },
    { $set: { status: 'Captured' }, $inc: { version: 1 } }));

// findOneAndUpdate returns the document. SQL: UPDATE ... OUTPUT inserted.*
show('findOneAndUpdate (refund)', db.payments.findOneAndUpdate(
    { _id: id, status: 'Captured' },
    { $set: { status: 'Refunded', refundedAt: new Date() }, $inc: { version: 1 } },
    { returnDocument: 'after', projection: { status: 1, version: 1, refundedAt: 1, attempts: 1 } }));

// updateMany. SQL: UPDATE Payments SET Status = 'Expired' WHERE MerchantId = 'demo' AND Status = 'Pending'
show('updateMany', db.payments.updateMany(
    { merchantId: 'demo', status: 'Pending' },
    { $set: { status: 'Expired' }, $inc: { version: 1 } }));

// replaceOne replaces the WHOLE document except _id. Fields you do not pass are gone.
// The EF Core provider and ReplaceOneAsync in the driver work this way.
const demo2 = db.payments.findOne({ idempotencyKey: 'demo-2' });
show('replaceOne', db.payments.replaceOne(
    { _id: demo2._id, version: demo2.version },
    { ...demo2, amount: NumberDecimal('6.00'), version: demo2.version + 1 }));

// --- 5. Delete ---------------------------------------------------------------
show('deleteOne', db.payments.deleteOne({ idempotencyKey: 'demo-3' }));
show('remaining demo documents', db.payments.find({ merchantId: 'demo' }, { idempotencyKey: 1, status: 1, amount: 1, version: 1 }).toArray());

// --- Exercises ---------------------------------------------------------------
// 1. Find the 10 largest Captured EUR payments of merchant m4 and return only amount and createdAt, without _id.
// 2. Add a field `riskScore: 0` to all demo payments that do not have it ($exists + $set).
// 3. Remove the first attempt of a payment with $pop, then remove all 'Timeout' attempts with $pull.
// 4. Insert a document with amount 0.1 + 0.2 as a JS number and as NumberDecimal('0.3'). Compare them with find().
// 5. Run the capture update twice from two mongosh windows with the same version. What does each one return?
