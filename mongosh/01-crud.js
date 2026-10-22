// Lesson 1. CRUD and update operators.
// Run from src/:  docker compose exec mongo mongosh /mongosh/01-crud.js
// Better: open the shell, run `use lab` and paste the commands one by one. Needs 00-seed.js. Safe to re-run.
//
// What you learn and why:
//   Part 1. Insert     - how a document gets into a collection. The API will do this in POST /payments.
//   Part 2. Read       - filters, projections, sorting and paging. The API will do this in GET .../payments.
//   Part 3. Arrays     - how to query the embedded `attempts` array without a JOIN.
//   Part 4. Update     - how to change part of a document atomically and protect it from lost updates.
//                        The API will do this in POST /payments/{id}/capture.
//   Part 5. Delete     - how to remove documents.
//
// How to read the results:
//   - Every write returns a result object. Its counters (insertedId, matchedCount, modifiedCount, deletedCount)
//     tell you what really happened. The API makes decisions from these counters, so learn to read them.
//   - mongosh shows types: UUID('...') is a GUID, Decimal128('10.50') is an exact decimal,
//     ISODate('...') is a UTC date.
//
// In the shell you do not need the `show(...)` wrapper: run the expression inside it, the shell prints the result.

db = db.getSiblingDB('lab'); // in a script; in the shell `use lab` does the same

function show(title, value) {
    print(`\n=== ${title}`);
    printjson(value);
}

// All demo documents of this lesson use merchantId 'demo'. The seed data is never changed, so the other lessons
// get the same data. This line removes the demo documents of a previous run, so the lesson can be repeated.
db.payments.deleteMany({ merchantId: 'demo' });

// =============================================================================
// Part 1. Insert
// =============================================================================
// SQL: INSERT INTO Payments (...) VALUES (...)
//
// There is no CREATE TABLE: the collection accepts a document of any shape. The shape you see here is the
// payment model of this project; the C# class Payment will have the same fields.
//
// _id is the primary key. Here we create it ourselves as a UUID (a GUID), because the API will also generate
// Guid ids in C#. If you do not pass _id, MongoDB generates an ObjectId.
// We keep the id in the variable `id`: Parts 2 and 4 use it to find this payment again.
const id = UUID();
show('insertOne', db.payments.insertOne({
    _id: id,
    merchantId: 'demo',
    customerId: 'c1',
    idempotencyKey: 'demo-1',
    amount: NumberDecimal('10.50'), // Decimal128: exact money; a plain JS number would be an inexact double
    currency: 'EUR',
    status: 'Pending',
    attempts: [], // no calls to a payment provider yet
    createdAt: new Date(), // stored in UTC
    version: 0, // for optimistic concurrency, see Part 4
    schemaVersion: 1,
}));
// Result: acknowledged: true means the server confirmed the write; insertedId is the _id of the new document.

// insertMany sends several documents in one call (the seed script does the same in batches of 5 000).
// These two payments are used later by updateMany, replaceOne and deleteOne.
show('insertMany', db.payments.insertMany([
    { _id: UUID(), merchantId: 'demo', idempotencyKey: 'demo-2', amount: NumberDecimal('5.00'), currency: 'EUR', status: 'Pending', attempts: [], createdAt: new Date(), version: 0, schemaVersion: 1 },
    { _id: UUID(), merchantId: 'demo', idempotencyKey: 'demo-3', amount: NumberDecimal('7.25'), currency: 'SEK', status: 'Pending', attempts: [], createdAt: new Date(), version: 0, schemaVersion: 1 },
]));
// Result: insertedIds lists the _id of each inserted document.

// =============================================================================
// Part 2. Read
// =============================================================================

// --- Read one document by its key ---
// SQL: SELECT * FROM Payments WHERE Id = @id
// findOne returns one document or null. A filter is itself a document: { field: value } means field = value.
// Look at the result: the whole payment, with all fields, comes back in one read. There is no JOIN.
show('findOne by _id', db.payments.findOne({ _id: id }));

// --- Filter, projection, sort and limit ---
// SQL: SELECT TOP 5 Id, Amount, Currency, CreatedAt FROM Payments
//      WHERE MerchantId = 'm2' AND Currency = 'SEK' AND Amount >= 500 ORDER BY CreatedAt DESC
//
// find(filter, projection):
//   - filter: several fields in one document are joined with AND. { $gte: x } means ">= x".
//     Compare amounts with NumberDecimal, so the types match the stored Decimal128.
//   - projection: the fields to return (1 = include). _id is always returned unless you write _id: 0.
//     Return only what you need: less data travels over the network.
// .sort({ createdAt: -1 }) is ORDER BY CreatedAt DESC (1 = ascending, -1 = descending).
// .limit(5) is TOP 5. Paging adds .skip(n), like OFFSET n ROWS.
// .toArray() collects the cursor into an array. find() returns a cursor, not the data itself:
// the shell and the driver fetch documents from the server in batches while you iterate.
show('filter + projection + sort + limit', db.payments
    .find(
        { merchantId: 'm2', currency: 'SEK', amount: { $gte: NumberDecimal('500') } },
        { amount: 1, currency: 1, createdAt: 1 })
    .sort({ createdAt: -1 })
    .limit(5)
    .toArray());
// Check: five documents, only the projected fields plus _id, newest first.

// --- Comparison and logical operators ---
// Operators start with $: $eq $ne $gt $gte $lt $lte $in $nin $and $or $not $exists.
// SQL: SELECT COUNT(*) FROM Payments WHERE Status IN ('Failed', 'Refunded') AND (Currency = 'NOK' OR Amount < 2)
// $or takes an array of filters; the other top-level fields are still joined with AND.
show('$in + $or count', db.payments.countDocuments({
    status: { $in: ['Failed', 'Refunded'] },
    $or: [{ currency: 'NOK' }, { amount: { $lt: NumberDecimal('2') } }],
}));

// --- Two ways to count ---
// countDocuments(filter) runs a real query: exact, but it reads data.
// estimatedDocumentCount() reads the collection metadata: instant, but no filter and may be approximate.
// Use the estimate for "about how many rows" dashboards, never for business decisions.
show('estimatedDocumentCount', db.payments.estimatedDocumentCount());

// =============================================================================
// Part 3. Query inside the embedded array
// =============================================================================
// In SQL Server the attempts would be a separate table PaymentAttempts, and these queries would need a JOIN
// or EXISTS. Here the attempts are inside the payment, and a dot path ('attempts.result') looks into them.
//
// Question: how many payments had an attempt that Klarna declined?
// Trap: with a dot path, each condition is checked against ANY element of the array independently.
// The filter below also matches a payment with a declined PayPal attempt plus a successful Klarna attempt:
// 'Declined' comes from one element and 'Klarna' from another.
show('declined + Klarna, any elements', db.payments.countDocuments({
    'attempts.result': 'Declined',
    'attempts.provider': 'Klarna',
}));
// $elemMatch requires ONE element to satisfy all conditions. This is the correct answer to the question.
// Compare the two numbers: the first is larger because it counts the wrong mixes too.
show('declined + Klarna, same element ($elemMatch)', db.payments.countDocuments({
    attempts: { $elemMatch: { result: 'Declined', provider: 'Klarna' } },
}));

// Array elements have positions 0, 1, 2... 'attempts.2' is the third element.
// "The third element exists" means "three or more attempts". This finds payments that needed many retries.
show('3+ attempts', db.payments.countDocuments({ 'attempts.2': { $exists: true } }));

// =============================================================================
// Part 4. Update
// =============================================================================
// An update sends only the changes, not the whole document. Update operators say what to change:
//   $set   - set a field                     $unset - remove a field
//   $inc   - add a number                    $push  - append to an array
//   $pull  - remove matching array elements  $addToSet - append if not already there
// MongoDB applies all operators of one update to one document atomically: nobody can see a half-updated payment.
//
// --- Capture with optimistic concurrency ---
// Scenario: the payment provider confirmed the payment. We must, in one step: set the status to Captured,
// record the attempt and increase the version.
//
// Problem: two requests can capture the same payment at the same time (a retry, a double click).
// Both read version 0. Without protection both writes succeed, and the second silently overwrites the first
// (a lost update).
// Solution: put the version we read into the filter. The update changes the document only if nobody changed it
// since we read it. It is the same idea as a rowversion column in SQL Server or a concurrency token in EF Core.
//
// SQL: UPDATE Payments SET Status = 'Captured', Version = Version + 1 WHERE Id = @id AND Version = 0
show('capture with version 0', db.payments.updateOne(
    { _id: id, version: 0 }, // filter: which document, and only if it still has version 0
    {
        $set: { status: 'Captured' },
        $push: { attempts: { at: new Date(), provider: 'Adyen', result: 'OK' } },
        $inc: { version: 1 }, // now version is 1
    }));
// Result: matchedCount 1 (the filter found the document), modifiedCount 1 (it was changed).

// The second request still thinks the version is 0. Run the same update again:
show('capture with stale version 0', db.payments.updateOne(
    { _id: id, version: 0 },
    { $set: { status: 'Captured' }, $inc: { version: 1 } }));
// Result: matchedCount 0. No document has _id = id AND version = 0 any more, so nothing changed.
// The API will turn matchedCount 0 into 409 Conflict: "the payment was changed by someone else, reload it".

// --- Update and get the new document back ---
// updateOne returns only counters. findOneAndUpdate returns the document itself, in one atomic step.
// SQL: UPDATE ... OUTPUT inserted.*
// returnDocument: 'after' returns the document after the change ('before' returns the old one).
// The filter status: 'Captured' is a business rule: only a captured payment can be refunded.
// $set can add a new field (refundedAt): documents of one collection do not need the same fields.
show('findOneAndUpdate (refund)', db.payments.findOneAndUpdate(
    { _id: id, status: 'Captured' },
    { $set: { status: 'Refunded', refundedAt: new Date() }, $inc: { version: 1 } },
    { returnDocument: 'after', projection: { status: 1, version: 1, refundedAt: 1, attempts: 1 } }));
// Check: status Refunded, version 2, the attempt from the capture, the new field refundedAt.

// --- Update many documents ---
// SQL: UPDATE Payments SET Status = 'Expired' WHERE MerchantId = 'demo' AND Status = 'Pending'
// For example, a nightly job expires payments that were never completed.
// Each document is changed atomically, but the whole updateMany is NOT one transaction: if it fails in the middle,
// some documents are already changed.
show('updateMany', db.payments.updateMany(
    { merchantId: 'demo', status: 'Pending' },
    { $set: { status: 'Expired' }, $inc: { version: 1 } }));
// Result: matchedCount 2 and modifiedCount 2: demo-2 and demo-3 (demo-1 is Refunded, it does not match).

// --- Replace the whole document ---
// replaceOne writes a NEW version of the whole document; only _id stays. Any field you do not pass is lost.
// The usual pattern: read the document, change it in code, write it back with the version check.
// This is how ReplaceOneAsync in the C# driver and SaveChanges in the EF Core provider work.
// { ...demo2, amount: ... } copies all fields of demo2 and overrides two of them.
const demo2 = db.payments.findOne({ idempotencyKey: 'demo-2' });
show('replaceOne', db.payments.replaceOne(
    { _id: demo2._id, version: demo2.version },
    { ...demo2, amount: NumberDecimal('6.00'), version: demo2.version + 1 }));
// Result: matchedCount 1, modifiedCount 1. Try it without `...demo2`: all other fields disappear.

// =============================================================================
// Part 5. Delete
// =============================================================================
// deleteOne removes the first matching document, deleteMany removes all matching documents.
// SQL: DELETE FROM Payments WHERE IdempotencyKey = 'demo-3'
// Real payment systems rarely delete payments; they change the status. Delete is shown for completeness.
show('deleteOne', db.payments.deleteOne({ idempotencyKey: 'demo-3' }));
// Result: deletedCount 1.

// Final state: demo-1 is Refunded with version 2, demo-2 is Expired with amount 6.00 and version 2.
show('remaining demo documents', db.payments.find({ merchantId: 'demo' }, { idempotencyKey: 1, status: 1, amount: 1, version: 1 }).toArray());

// =============================================================================
// Exercises
// =============================================================================
// 1. Find the 10 largest Captured EUR payments of merchant m4 and return only amount and createdAt, without _id.
// 2. Add a field `riskScore: 0` to all demo payments that do not have it ($exists + $set).
// 3. Remove the first attempt of a payment with $pop, then remove all 'Timeout' attempts with $pull.
// 4. Insert a document with amount 0.1 + 0.2 as a JS number and as NumberDecimal('0.3'). Compare them with find().
// 5. Run the capture update twice from two mongosh windows with the same version. What does each one return?
