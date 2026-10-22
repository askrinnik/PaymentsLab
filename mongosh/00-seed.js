// Seeds lab.payments with synthetic payments for the mongosh lessons.
// Run from src/:  docker compose exec mongo mongosh /mongosh/00-seed.js
// Safe to re-run: the collection is dropped first (with all its indexes).

db = db.getSiblingDB('lab');

const TOTAL = 200_000;
const BATCH = 5_000;
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

const merchants = ['m1', 'm2', 'm3', 'm4', 'm5'];
const merchantWeights = [0.40, 0.25, 0.15, 0.12, 0.08]; // m1 is a large merchant, m5 a small one
const currencies = ['EUR', 'SEK', 'NOK'];
const currencyWeights = [0.70, 0.20, 0.10];
const statuses = ['Captured', 'Authorized', 'Pending', 'Failed', 'Refunded'];
const statusWeights = [0.60, 0.10, 0.10, 0.12, 0.08];
const providers = ['Adyen', 'PayPal', 'Klarna'];

function pick(items) {
    return items[Math.floor(Math.random() * items.length)];
}

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

// Attempts are embedded: they are read together with the payment and their number is small and bounded.
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

function makePayment(i) {
    const createdAt = new Date(now - Math.floor(Math.random() * 365 * DAY));
    const status = pickWeighted(statuses, statusWeights);
    const attempts = attemptsFor(status, createdAt);
    return {
        _id: UUID(),
        merchantId: pickWeighted(merchants, merchantWeights),
        customerId: `c${1 + Math.floor(Math.random() * 5000)}`,
        idempotencyKey: `seed-${i}`,
        amount: randomAmount(),
        currency: pickWeighted(currencies, currencyWeights),
        status,
        attempts,
        createdAt,
        version: attempts.length,
        schemaVersion: 1,
    };
}

db.payments.drop();

const started = Date.now();
for (let offset = 0; offset < TOTAL; offset += BATCH) {
    const batch = [];
    for (let i = offset; i < Math.min(offset + BATCH, TOTAL); i++) batch.push(makePayment(i));
    db.payments.insertMany(batch, { ordered: false });
    if ((offset + BATCH) % 50_000 === 0) print(`inserted ${offset + BATCH}`);
}

print(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)} s. Documents: ${db.payments.countDocuments()}`);
print('\nPayments by status:');
db.payments.aggregate([
    { $group: { _id: '$status', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
]).forEach(r => print(`  ${r._id.padEnd(10)} ${r.n}`));

print('\nOne sample document:');
printjson(db.payments.findOne());
