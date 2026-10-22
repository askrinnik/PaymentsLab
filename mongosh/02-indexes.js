// Lesson 2. Indexes and explain().
// Run from src/:  docker compose exec mongo mongosh /mongosh/02-indexes.js
// Needs 00-seed.js. Safe to re-run: all indexes except _id are dropped first.
//
// What to read in each report (like an execution plan in SQL Server):
//   plan               stages from top to bottom. COLLSCAN = table scan, IXSCAN = index seek/scan,
//                      FETCH = key lookup, SORT = in-memory sort, PROJECTION_COVERED = covering index.
//   nReturned          documents returned.
//   totalKeysExamined  index entries read.
//   totalDocsExamined  documents read. The ideal is totalKeysExamined ≈ totalDocsExamined ≈ nReturned.

db = db.getSiblingDB('lab');

function planStages(explain) {
    const winningPlan = explain.queryPlanner.winningPlan;
    let node = winningPlan.queryPlan ?? winningPlan; // the SBE engine nests the plan in queryPlan
    const stages = [];
    while (node) {
        stages.push(node.indexName ? `${node.stage}(${node.indexName})` : node.stage);
        node = node.inputStage ?? node.inputStages?.[0];
    }
    return stages.join(' -> ');
}

function report(title, cursor) {
    const e = cursor.explain('executionStats');
    const s = e.executionStats;
    print(`\n=== ${title}`);
    print(`  plan:              ${planStages(e)}`);
    print(`  nReturned:         ${s.nReturned}`);
    print(`  totalKeysExamined: ${s.totalKeysExamined}`);
    print(`  totalDocsExamined: ${s.totalDocsExamined}`);
    print(`  executionTimeMs:   ${s.executionTimeMillis}`);
}

db.payments.dropIndexes(); // keeps the mandatory unique index on _id

// --- A. Equality filter ------------------------------------------------------
// Every collection has a unique index on _id, like a clustered primary key.
// MongoDB 8.0 shows EXPRESS_IXSCAN here: a fast path for simple equality lookups on a unique index.
const anyId = db.payments.findOne()._id;
report('A1. by _id', db.payments.find({ _id: anyId }));

// Without an index MongoDB reads all 200 000 documents.
const byCustomer = () => db.payments.find({ customerId: 'c42' });
report('A2. by customerId, no index', byCustomer());

db.payments.createIndex({ customerId: 1 });
report('A3. by customerId, index { customerId: 1 }', byCustomer());

// --- B. Filter + sort: merchant history --------------------------------------
// SQL: SELECT TOP 20 * FROM Payments WHERE MerchantId = 'm3' ORDER BY CreatedAt DESC
const history = () => db.payments.find({ merchantId: 'm3' }).sort({ createdAt: -1 }).limit(20);
report('B1. merchant history, no index (scan + in-memory SORT)', history());

// The index order matches the sort, so MongoDB reads the first 20 entries and stops.
db.payments.createIndex({ merchantId: 1, createdAt: -1 });
report('B2. merchant history, index { merchantId: 1, createdAt: -1 }', history());

// --- C. The ESR rule: Equality, Sort, Range ---------------------------------
// Payments of merchant m1 above some amount, newest first:
//   merchantId = 'm1'    -> Equality
//   ORDER BY createdAt   -> Sort
//   amount >= minAmount  -> Range
const aboveAmountNewest = minAmount => db.payments
    .find({ merchantId: 'm1', amount: { $gte: NumberDecimal(minAmount) } })
    .sort({ createdAt: -1 })
    .limit(20);

db.payments.createIndex({ merchantId: 1, amount: 1, createdAt: -1 }, { name: 'ix_ERS' });
db.payments.createIndex({ merchantId: 1, createdAt: -1, amount: 1 }, { name: 'ix_ESR' });

// A wide range (amount >= 100 matches ~90% of m1).
// E-R-S: the range comes before the sort field, so the keys are not ordered by createdAt. MongoDB reads every
// matching key and sorts them in memory (SORT stage).
report('C1. wide range, E-R-S index (hint ix_ERS)', aboveAmountNewest('100').hint('ix_ERS'));
// E-S-R: the keys are already ordered by createdAt -> no SORT. The amount filter is checked on the index keys,
// and MongoDB stops after 20 matches.
report('C2. wide range, E-S-R index (hint ix_ESR)', aboveAmountNewest('100').hint('ix_ESR'));

// A very selective range (amount >= 990 matches ~1% of m1).
// Now E-R-S reads fewer keys: it jumps straight to the few large amounts and sorts a small set.
// E-S-R walks many recent keys to find 20 large ones. ESR is a guideline, not a law: check with explain().
report('C3. narrow range, E-R-S index (hint ix_ERS)', aboveAmountNewest('990').hint('ix_ERS'));
report('C4. narrow range, E-S-R index (hint ix_ESR)', aboveAmountNewest('990').hint('ix_ESR'));

// Without a hint the query planner races the candidate plans and caches the winner per query shape.
report('C5. wide range, no hint: the planner chooses', aboveAmountNewest('100'));
report('C6. narrow range, no hint: the planner chooses', aboveAmountNewest('990'));

// --- D. Covered query --------------------------------------------------------
// When the filter, sort and projection use only index fields, MongoDB does not read documents at all.
// Exclude _id: it is not in the index.
report('D1. covered query (totalDocsExamined = 0)', db.payments
    .find({ merchantId: 'm3' }, { _id: 0, merchantId: 1, createdAt: 1 })
    .sort({ createdAt: -1 })
    .limit(20));

// --- E. Multikey index: an index on an array field ---------------------------
// MongoDB adds one index entry per array element.
const byProvider = () => db.payments.find({ 'attempts.provider': 'Klarna', 'attempts.result': 'Timeout' }).limit(20);
db.payments.createIndex({ 'attempts.provider': 1, 'attempts.result': 1 });
report('E1. multikey index on attempts', byProvider());

// --- F. What indexes cost ----------------------------------------------------
// Every index takes space and slows down every insert and update, as in SQL Server.
print('\n=== F. index sizes (bytes)');
printjson(db.payments.aggregate([{ $collStats: { storageStats: {} } }]).next().storageStats.indexSizes);
print('\n=== F. indexes');
db.payments.getIndexes().forEach(ix => print(`  ${ix.name.padEnd(42)} ${JSON.stringify(ix.key)}`));

// --- Exercises ---------------------------------------------------------------
// 1. C5 usually chooses merchantId_1_createdAt_-1, not ix_ESR. Compare totalDocsExamined of C2 and C5: why are they
//    different? Then drop ix_ERS and run C6 again. Which index wins now?
// 2. Find failed EUR payments of m2 in the last 30 days, newest first. Design an index by the ESR rule
//    and prove with explain() that there is no SORT stage and totalDocsExamined ≈ nReturned.
// 3. Make query D1 not covered by adding `amount: 1` to the projection. What changes in the plan?
// 4. Run db.payments.find({ status: 'Pending' }).explain('allPlansExecution') with two indexes that start
//    with status. Look at rejectedPlans.
// 5. Delete index { customerId: 1 } with db.payments.dropIndex(...). Hide one index instead with
//    db.payments.hideIndex(...) and check that the planner ignores it. Why is hiding safer in production?
