// Lesson 4. Aggregation pipeline: GROUP BY, JOIN and reports.
// Run from src/:  docker compose exec mongo mongosh /mongosh/04-aggregation.js
// Needs 00-seed.js. Safe to re-run.
//
// A pipeline is a list of stages. Each stage takes documents from the previous one and passes new
// documents on: $match (WHERE) -> $group (GROUP BY) -> $sort (ORDER BY) -> $project (SELECT list).
// Put $match first: only the first stages can use indexes.

db = db.getSiblingDB('lab');

function show(title, value) {
    print(`\n=== ${title}`);
    printjson(value);
}

// --- 1. Totals per merchant and currency -------------------------------------
// SQL: SELECT MerchantId, Currency, SUM(Amount), COUNT(*), AVG(Amount) FROM Payments
//      WHERE Status = 'Captured' GROUP BY MerchantId, Currency ORDER BY SUM(Amount) DESC
// Decimal128 stays exact through $sum and $avg.
show('captured totals by merchant and currency', db.payments.aggregate([
    { $match: { status: 'Captured' } },
    {
        $group: {
            _id: { merchantId: '$merchantId', currency: '$currency' },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
            average: { $avg: '$amount' },
        },
    },
    { $sort: { total: -1 } },
    { $limit: 5 },
    { $project: { _id: 0, merchantId: '$_id.merchantId', currency: '$_id.currency', total: 1, count: 1, average: { $round: ['$average', 2] } } },
]).toArray());

// --- 2. Revenue by month -----------------------------------------------------
// $dateTrunc is like DATETRUNC(month, CreatedAt) in SQL Server 2022.
// The $match uses the index { merchantId: 1, createdAt: -1 } from lesson 2.
const sixMonthsAgo = new Date(Date.now() - 182 * 24 * 60 * 60 * 1000);
show('m1 EUR captured revenue by month', db.payments.aggregate([
    { $match: { merchantId: 'm1', createdAt: { $gte: sixMonthsAgo }, currency: 'EUR', status: 'Captured' } },
    { $group: { _id: { $dateTrunc: { date: '$createdAt', unit: 'month' } }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
]).toArray());

// --- 3. Unwind an array: provider success rate -------------------------------
// $unwind turns one payment with three attempts into three documents, one per attempt.
// SQL equivalent: a JOIN to a PaymentAttempts table.
show('success rate by provider', db.payments.aggregate([
    { $unwind: '$attempts' },
    {
        $group: {
            _id: '$attempts.provider',
            attempts: { $sum: 1 },
            ok: { $sum: { $cond: [{ $eq: ['$attempts.result', 'OK'] }, 1, 0] } },
            timeouts: { $sum: { $cond: [{ $eq: ['$attempts.result', 'Timeout'] }, 1, 0] } },
        },
    },
    { $project: { attempts: 1, ok: 1, timeouts: 1, successRate: { $round: [{ $multiply: [{ $divide: ['$ok', '$attempts'] }, 100] }, 1] } } },
    { $sort: { successRate: -1 } },
]).toArray());

// --- 4. $lookup: a LEFT OUTER JOIN -------------------------------------------
// Merchants are a separate collection: they have their own life cycle (referencing, not embedding).
db.merchants.drop();
db.merchants.insertMany([
    { _id: 'm1', name: 'Nordic Shoes', country: 'SE' },
    { _id: 'm2', name: 'Fjord Travel', country: 'NO' },
    { _id: 'm3', name: 'Berlin Books', country: 'DE' },
    { _id: 'm4', name: 'Amsterdam Bikes', country: 'NL' },
    { _id: 'm5', name: 'Vienna Coffee', country: 'AT' },
]);

// Group first, join after: 5 lookups instead of 120 000. Stage order matters for performance.
show('top merchants by captured EUR, with merchant names', db.payments.aggregate([
    { $match: { status: 'Captured', currency: 'EUR' } },
    { $group: { _id: '$merchantId', total: { $sum: '$amount' } } },
    { $sort: { total: -1 } },
    { $limit: 3 },
    { $lookup: { from: 'merchants', localField: '_id', foreignField: '_id', as: 'merchant' } },
    { $unwind: '$merchant' },
    { $project: { _id: 0, merchantId: '$_id', name: '$merchant.name', country: '$merchant.country', total: 1 } },
]).toArray());

// --- 5. $facet: several reports in one pass ----------------------------------
// $bucket is like GROUP BY CASE WHEN Amount < 10 THEN ... END.
show('m2 dashboard: status counts and amount buckets', db.payments.aggregate([
    { $match: { merchantId: 'm2' } },
    {
        $facet: {
            byStatus: [{ $sortByCount: '$status' }],
            byAmount: [{
                $bucket: {
                    groupBy: '$amount',
                    boundaries: [NumberDecimal('0'), NumberDecimal('10'), NumberDecimal('100'), NumberDecimal('500'), NumberDecimal('1000')],
                    output: { count: { $sum: 1 } },
                },
            }],
        },
    },
]).toArray());

// --- Exercises ---------------------------------------------------------------
// 1. Refund rate per merchant: Refunded / (Captured + Refunded), in percent, sorted descending.
// 2. Top 5 customers of m1 by captured EUR amount in the last 90 days. Which index helps the $match?
//    Check with db.payments.explain('executionStats').aggregate([...]).
// 3. Average number of attempts per payment by status ($size).
// 4. Put $lookup BEFORE $group in pipeline 4 and compare the execution time.
// 5. Write the result of pipeline 1 to a collection with $merge. When is a pre-computed collection
//    better than running the pipeline on every request? (Computed pattern.)
