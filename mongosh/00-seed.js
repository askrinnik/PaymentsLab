// Seeds lab.payments with synthetic payments for the mongosh lessons.
// Run from src/:  docker compose exec mongo mongosh /mongosh/00-seed.js
// Safe to re-run: the collection is dropped first (with all its indexes).
//
// What the script does:
//   1. Drops the collection lab.payments.
//   2. Builds payments in memory, 5 000 at a time. Each payment is one composite document: the payment data
//      plus an embedded array `attempts` with the history of calls to payment providers.
//   3. Inserts each batch with insertMany, 40 batches in total.
//   4. Prints a summary: the document count, payments per status and one sample document.
//
// The database `lab` and the collection `payments` need no CREATE statement: MongoDB creates them on the first
// insert. The only index is the automatic unique index on _id.

db = db.getSiblingDB('lab');

// --- Settings ----------------------------------------------------------------

const TOTAL = 200_000;
const BATCH = 5_000; // documents per insertMany call
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

// Values are picked at random with these weights, so the data is uneven like real data.
const merchants = ['m1', 'm2', 'm3', 'm4', 'm5'];
const merchantWeights = [0.40, 0.25, 0.15, 0.12, 0.08]; // m1 is a large merchant, m5 a small one
const currencies = ['EUR', 'SEK', 'NOK'];
const currencyWeights = [0.70, 0.20, 0.10];
const statuses = ['Captured', 'Authorized', 'Pending', 'Failed', 'Refunded'];
const statusWeights = [0.60, 0.10, 0.10, 0.12, 0.08];
const providers = ['Adyen', 'PayPal', 'Klarna'];

// --- Random helpers ----------------------------------------------------------

// Any item with the same probability.
function pick(items) {
    return items[Math.floor(Math.random() * items.length)];
}

// An item with the probability from `weights` (the weights add up to 1).
function pickWeighted(items, weights) {
    let r = Math.random();
    for (let i = 0; i < items.length; i++) {
        r -= weights[i];
        if (r <= 0) return items[i];
    }
    return items[items.length - 1];
}

// 1.00 .. 999.99 as Decimal128. Never use double for money.
function randomAmount() {
    const cents = 100 + Math.floor(Math.random() * 99_900);
    return NumberDecimal((cents / 100).toFixed(2));
}

// --- One payment -------------------------------------------------------------

// Builds the attempt history that matches an already chosen status.
// Attempts are embedded: they are read together with the payment and their number is small and bounded.
//
//   status                            failed attempts   successful attempt
//   Failed                            1-3               no
//   Pending                           0-1               no (not processed yet)
//   Captured, Authorized, Refunded    0-1               yes, the last one
//
// A failed attempt has the result 'Declined' or 'Timeout', a successful one 'OK'.
// Each attempt happens 1-6 seconds after the previous one, the first one after createdAt.
function attemptsFor(status, createdAt) {
    const attempts = [];
    const failures = status === 'Failed' ? 1 + Math.floor(Math.random() * 3) : Math.floor(Math.random() * 2);
    let at = createdAt.getTime();
    for (let i = 0; i < failures; i++) {
        at += 1000 + Math.floor(Math.random() * 5000);
        attempts.push({ at: new Date(at), provider: pick(providers), result: pick(['Declined', 'Timeout']) });
    }
    if (status !== 'Failed' && status !== 'Pending') {
        at += 1000 + Math.floor(Math.random() * 5000);
        attempts.push({ at: new Date(at), provider: pick(providers), result: 'OK' });
    }
    return attempts;
}

// Builds one payment document in memory; nothing is written to the database here.
// `i` is the payment number; it makes the idempotency key unique.
// The status is chosen first, then attemptsFor builds the attempts that match it.
function makePayment(i) {
    const createdAt = new Date(now - Math.floor(Math.random() * 365 * DAY)); // within the last year
    const status = pickWeighted(statuses, statusWeights);
    const attempts = attemptsFor(status, createdAt);
    return {
        _id: UUID(), // like a C# Guid
        merchantId: pickWeighted(merchants, merchantWeights),
        customerId: `c${1 + Math.floor(Math.random() * 5000)}`,
        idempotencyKey: `seed-${i}`,
        amount: randomAmount(),
        currency: pickWeighted(currencies, currencyWeights),
        status,
        attempts,
        createdAt,
        version: attempts.length, // as if every attempt was an update with $inc: { version: 1 }
        schemaVersion: 1,
    };
}

// --- Step 1. Drop the old data -----------------------------------------------

db.payments.drop();

// --- Steps 2-3. Build and insert in batches ----------------------------------
// Build 5 000 documents, send them in one insertMany call, repeat. Only one batch is in memory at a time.
// One call per batch instead of one per document is what makes the seed take seconds (like SqlBulkCopy).
// ordered: false lets the server insert the rest of a batch if one document fails.

const started = Date.now();
for (let offset = 0; offset < TOTAL; offset += BATCH) {
    const batch = [];
    for (let i = offset; i < Math.min(offset + BATCH, TOTAL); i++) batch.push(makePayment(i));
    db.payments.insertMany(batch, { ordered: false });
    if ((offset + BATCH) % 50_000 === 0) print(`inserted ${offset + BATCH}`); // progress every 10 batches
}

// --- Step 4. Summary ---------------------------------------------------------

// countDocuments asks the database itself how many documents the collection has.
print(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)} s. Documents: ${db.payments.countDocuments()}`);

// SQL: SELECT Status, COUNT(*) FROM Payments GROUP BY Status ORDER BY COUNT(*) DESC (see lesson 4).
print('\nPayments by status:');
db.payments.aggregate([
    { $group: { _id: '$status', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
]).forEach(r => print(`  ${r._id.padEnd(10)} ${r.n}`));

// Without a sort the order is not guaranteed; usually it is the first inserted document (seed-0).
print('\nOne sample document:');
printjson(db.payments.findOne());
