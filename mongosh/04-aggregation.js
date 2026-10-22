// Lesson 4. Aggregation pipeline: GROUP BY, JOIN and reports.
// Run from src/:  docker compose exec mongo mongosh /mongosh/04-aggregation.js
// Better: open the shell, run `use lab` and paste each pipeline as a whole. Needs 00-seed.js
// (pipeline 2 is faster with the index from lesson 2, but works without it). Safe to re-run.
//
// What it is:
//   find() can filter, sort and project, but it cannot group, count per group or join. For that MongoDB has the
//   aggregation pipeline: a list of stages. Each stage takes the documents from the previous stage and passes new
//   documents on, like a pipe in a shell or a chain of LINQ methods.
//
//     payments ──► $match ──► $group ──► $sort ──► $project ──► result
//                  WHERE      GROUP BY   ORDER BY  SELECT list
//
//   Other stages used here: $limit (TOP), $unwind (one document per array element), $lookup (LEFT JOIN),
//   $facet (several reports in one pass), $bucket (GROUP BY ranges).
//
// What you learn:
//   Pipeline 1. Totals per merchant and currency  - the future endpoint GET /merchants/{id}/totals.
//   Pipeline 2. Revenue by month                  - grouping by a computed value.
//   Pipeline 3. Provider success rate             - statistics over the embedded attempts array.
//   Pipeline 4. Merchant names with $lookup       - a join, and why the stage order matters.
//   Pipeline 5. A dashboard with $facet           - several groupings in one query.
//
// Syntax to know:
//   - '$amount' (a string with $) means "the value of the field amount". 'amount' without $ is just a string.
//   - In $group, _id is the grouping key, not a document id. _id: { a: '$x', b: '$y' } groups by two fields.
//   - Accumulators compute a value per group: $sum, $avg, $min, $max, $first, $last, $push.
//   - Put $match first. Only the first stages can use indexes, and every later stage gets fewer documents.

db = db.getSiblingDB('lab'); // in a script; in the shell `use lab` does the same

function show(title, value) {
    print(`\n=== ${title}`);
    printjson(value);
}

// =============================================================================
// Pipeline 1. Totals per merchant and currency
// =============================================================================
// SQL: SELECT TOP 5 MerchantId, Currency, SUM(Amount) AS Total, COUNT(*) AS Count, ROUND(AVG(Amount), 2) AS Average
//      FROM Payments WHERE Status = 'Captured'
//      GROUP BY MerchantId, Currency ORDER BY Total DESC
// Decimal128 stays exact through $sum and $avg: no rounding errors in money totals.
show('captured totals by merchant and currency', db.payments.aggregate([
    // WHERE: only captured payments (money really received).
    { $match: { status: 'Captured' } },
    // GROUP BY merchantId, currency. Each output document has the key in _id plus the computed fields.
    {
        $group: {
            _id: { merchantId: '$merchantId', currency: '$currency' },
            total: { $sum: '$amount' }, // SUM(Amount)
            count: { $sum: 1 }, // COUNT(*): add 1 for every document
            average: { $avg: '$amount' }, // AVG(Amount)
        },
    },
    // ORDER BY Total DESC, TOP 5.
    { $sort: { total: -1 } },
    { $limit: 5 },
    // SELECT list: move the key fields out of _id, hide _id, round the average.
    { $project: { _id: 0, merchantId: '$_id.merchantId', currency: '$_id.currency', total: 1, count: 1, average: { $round: ['$average', 2] } } },
]).toArray());
// Check: m1 EUR is first (m1 is the largest merchant and EUR the main currency). Averages are about 500,
// because the seed amounts are uniform from 1 to 999.99.

// =============================================================================
// Pipeline 2. Revenue by month
// =============================================================================
// $group can group by a computed value. $dateTrunc cuts a date to the start of its month,
// like DATETRUNC(month, CreatedAt) in SQL Server 2022.
// The $match filters by merchantId and createdAt first, so it can use the index { merchantId: 1, createdAt: -1 }
// from lesson 2.
const sixMonthsAgo = new Date(Date.now() - 182 * 24 * 60 * 60 * 1000);
show('m1 EUR captured revenue by month', db.payments.aggregate([
    { $match: { merchantId: 'm1', createdAt: { $gte: sixMonthsAgo }, currency: 'EUR', status: 'Captured' } },
    { $group: { _id: { $dateTrunc: { date: '$createdAt', unit: 'month' } }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } }, // by month, oldest first
]).toArray());
// Check: usually 7 rows. The first and the last months are partial (the 6-month window starts and ends inside them),
// so their totals are smaller.

// =============================================================================
// Pipeline 3. Provider success rate: statistics over an embedded array
// =============================================================================
// Question: what share of attempts does each payment provider complete successfully?
// The attempts are inside the payments. $unwind turns one payment with 3 attempts into 3 documents, each with one
// attempt in the field `attempts` (now an object, not an array). After that we can group by attempt fields.
// SQL equivalent: SELECT ... FROM Payments JOIN PaymentAttempts ... GROUP BY Provider.
show('success rate by provider', db.payments.aggregate([
    { $unwind: '$attempts' },
    {
        $group: {
            _id: '$attempts.provider',
            attempts: { $sum: 1 },
            // $cond is CASE WHEN ... THEN 1 ELSE 0 END: count only the attempts with result OK.
            ok: { $sum: { $cond: [{ $eq: ['$attempts.result', 'OK'] }, 1, 0] } },
            timeouts: { $sum: { $cond: [{ $eq: ['$attempts.result', 'Timeout'] }, 1, 0] } },
        },
    },
    // A computed field: ok / attempts * 100, rounded to one decimal place.
    { $project: { attempts: 1, ok: 1, timeouts: 1, successRate: { $round: [{ $multiply: [{ $divide: ['$ok', '$attempts'] }, 100] }, 1] } } },
    { $sort: { successRate: -1 } },
]).toArray());
// Check: all three providers are about the same (~53%), because the seed picks providers at random.
// On real data this report would show which provider to prefer.

// =============================================================================
// Pipeline 4. $lookup: a LEFT OUTER JOIN
// =============================================================================
// Merchants are a separate collection, not embedded in payments: a merchant has its own life cycle and thousands of
// payments (referencing, not embedding). The payment keeps only merchantId, like a foreign key without a constraint.
// First create the small merchants collection. Here _id is a string: any type can be the key.
db.merchants.drop();
db.merchants.insertMany([
    { _id: 'm1', name: 'Nordic Shoes', country: 'SE' },
    { _id: 'm2', name: 'Fjord Travel', country: 'NO' },
    { _id: 'm3', name: 'Berlin Books', country: 'DE' },
    { _id: 'm4', name: 'Amsterdam Bikes', country: 'NL' },
    { _id: 'm5', name: 'Vienna Coffee', country: 'AT' },
]);

// SQL: SELECT TOP 3 p.MerchantId, m.Name, m.Country, SUM(p.Amount) AS Total
//      FROM Payments p LEFT JOIN Merchants m ON m.Id = p.MerchantId
//      WHERE p.Status = 'Captured' AND p.Currency = 'EUR'
//      GROUP BY p.MerchantId, m.Name, m.Country ORDER BY Total DESC
//
// The stage order matters for performance. The SQL Server optimizer reorders a JOIN and a GROUP BY for you;
// MongoDB runs the stages in the order you write them. Here we group first: 120 000 payments become 5 rows,
// and $lookup runs 3 times (after $limit), not 120 000 times.
show('top merchants by captured EUR, with merchant names', db.payments.aggregate([
    { $match: { status: 'Captured', currency: 'EUR' } },
    { $group: { _id: '$merchantId', total: { $sum: '$amount' } } },
    { $sort: { total: -1 } },
    { $limit: 3 },
    // For each row, find documents in `merchants` where merchants._id = this row's _id (the merchantId).
    // The matches are put into a new ARRAY field `merchant` (empty if none, like LEFT JOIN with NULLs).
    { $lookup: { from: 'merchants', localField: '_id', foreignField: '_id', as: 'merchant' } },
    // The array has exactly one element; $unwind turns it into an object, so we can read merchant.name.
    { $unwind: '$merchant' },
    { $project: { _id: 0, merchantId: '$_id', name: '$merchant.name', country: '$merchant.country', total: 1 } },
]).toArray());
// Check: three rows with merchant names. Use $lookup rarely: if you need the merchant name in every payment read,
// copy it into the payment instead (the Extended Reference pattern).

// =============================================================================
// Pipeline 5. $facet: several reports in one pass
// =============================================================================
// A dashboard for merchant m2 needs two groupings of the same payments. $facet runs several sub-pipelines on the same
// input and returns their results in one document. The $match before it runs once for both.
show('m2 dashboard: status counts and amount buckets', db.payments.aggregate([
    { $match: { merchantId: 'm2' } },
    {
        $facet: {
            // $sortByCount = $group by the value + count + sort by count descending.
            byStatus: [{ $sortByCount: '$status' }],
            // $bucket groups by ranges: [0, 10), [10, 100), [100, 500), [500, 1000).
            // SQL: GROUP BY CASE WHEN Amount < 10 THEN 0 WHEN Amount < 100 THEN 10 ... END
            // _id of each bucket is its lower boundary.
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
// Check: one document with two arrays. In byAmount the bucket 500-1000 is the largest: it covers the widest range.

// =============================================================================
// Exercises
// =============================================================================
// 1. Refund rate per merchant: Refunded / (Captured + Refunded), in percent, sorted descending.
// 2. Top 5 customers of m1 by captured EUR amount in the last 90 days. Which index helps the $match?
//    Check with db.payments.explain('executionStats').aggregate([...]).
// 3. Average number of attempts per payment by status ($size).
// 4. Put $lookup BEFORE $group in pipeline 4 and compare the execution time.
// 5. Write the result of pipeline 1 to a collection with $merge. When is a pre-computed collection
//    better than running the pipeline on every request? (Computed pattern.)
