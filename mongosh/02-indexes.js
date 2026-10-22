// Lesson 2. Indexes and explain().
// Run from src/:  docker compose exec mongo mongosh /mongosh/02-indexes.js
// Better: open the shell, run `use lab`, paste the two helper functions below once, then the commands one by one.
// Needs 00-seed.js. Safe to re-run: all indexes except _id are dropped first.
//
// What you learn and why:
//   Part A. Why an index matters      - the same query without and with an index.
//   Part B. Filter + sort             - the merchant history query of the future API.
//   Part C. The ESR rule              - how to order fields in a compound index, and when the rule does not win.
//   Part D. Covered query             - a query answered from the index alone.
//   Part E. Index on an array         - how the embedded `attempts` array is indexed.
//   Part F. What indexes cost         - size and write overhead.
// In production, slow queries are almost always missing or wrong indexes. explain() is the tool to find them,
// like the execution plan in SQL Server Management Studio.
//
// How to read a report (the helper `report` prints these lines):
//   plan               the stages of the winning plan, from the last stage to the first:
//                        COLLSCAN            reads the whole collection (a table scan)
//                        IXSCAN(name)        reads a range of an index (an index seek/scan)
//                        EXPRESS_IXSCAN      MongoDB 8.0 fast path for an equality lookup on a unique index
//                        FETCH               reads the documents for the index entries (a key lookup)
//                        SORT                sorts in memory (expensive on many documents)
//                        LIMIT               stops after N documents
//                        PROJECTION_COVERED  builds the result from the index alone, no FETCH
//   nReturned          documents returned to the client.
//   totalKeysExamined  index entries read.
//   totalDocsExamined  documents read.
//   executionTimeMs    server time. On small data it is noisy; trust the counters more than the time.
// A good plan reads about as many keys and documents as it returns:
// totalKeysExamined ≈ totalDocsExamined ≈ nReturned. A plan that reads 200 000 documents to return 20 is bad.
//
// The data is random, so your numbers will differ a little from the numbers in these comments.

db = db.getSiblingDB('lab'); // in a script; in the shell `use lab` does the same

// --- Helpers: paste these two functions into the shell once ------------------

// explain() returns a large tree. This function walks it and returns the stage names in one line.
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

// Runs the query with explain('executionStats') - the query really runs and MongoDB counts what it read -
// and prints the five values described above.
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

// Start from a known state: remove the indexes of a previous run. The _id index cannot be dropped.
db.payments.dropIndexes();

// =============================================================================
// Part A. Why an index matters
// =============================================================================

// Every collection has a unique index on _id, like a clustered primary key in SQL Server.
// A lookup by _id reads one index entry and one document.
const anyId = db.payments.findOne()._id;
report('A1. by _id', db.payments.find({ _id: anyId }));
// Check: EXPRESS_IXSCAN(_id_), 1 key, 1 document.

// All payments of one customer. There is no index on customerId yet.
// The query is wrapped in a function so the same query can be run again after the index is created.
const byCustomer = () => db.payments.find({ customerId: 'c42' });
report('A2. by customerId, no index', byCustomer());
// Check: COLLSCAN, totalDocsExamined ≈ 200 000 to return about 40 documents. Every document was read.

// SQL: CREATE INDEX IX_Payments_CustomerId ON Payments (CustomerId)
// { customerId: 1 } means ascending. The default name is customerId_1.
db.payments.createIndex({ customerId: 1 });
report('A3. by customerId, index { customerId: 1 }', byCustomer());
// Check: FETCH -> IXSCAN(customerId_1). Keys = documents = returned. The time drops from tens of ms to ~1 ms.

// =============================================================================
// Part B. Filter + sort: the merchant history
// =============================================================================
// The future endpoint GET /merchants/{id}/payments shows the newest payments of a merchant, page by page.
// SQL: SELECT TOP 20 * FROM Payments WHERE MerchantId = 'm3' ORDER BY CreatedAt DESC
const history = () => db.payments.find({ merchantId: 'm3' }).sort({ createdAt: -1 }).limit(20);

report('B1. merchant history, no index (scan + in-memory SORT)', history());
// Check: SORT -> COLLSCAN. MongoDB reads every document, keeps the 20 newest of m3 in memory and sorts them.

// A compound index: entries are ordered by merchantId, and inside one merchantId by createdAt descending.
// The entries of m3 lie together and are already in the order of the sort.
db.payments.createIndex({ merchantId: 1, createdAt: -1 });
report('B2. merchant history, index { merchantId: 1, createdAt: -1 }', history());
// Check: LIMIT -> FETCH -> IXSCAN, no SORT stage, 20 keys and 20 documents. MongoDB reads the first 20 entries
// of m3 and stops. The API will create exactly this index at startup.

// =============================================================================
// Part C. The ESR rule: Equality, Sort, Range
// =============================================================================
// The order of fields in a compound index decides whether one index can serve both the filter and the sort.
// The ESR rule says: first the fields compared with equality, then the sort fields, then the range fields.
//
// Example query: payments of merchant m1 with amount >= X, newest first.
//   merchantId = 'm1'    -> Equality
//   ORDER BY createdAt   -> Sort
//   amount >= X          -> Range
const aboveAmountNewest = minAmount => db.payments
    .find({ merchantId: 'm1', amount: { $gte: NumberDecimal(minAmount) } })
    .sort({ createdAt: -1 })
    .limit(20);

// Two indexes with the same fields in a different order: E-R-S (range before sort) and E-S-R (by the rule).
db.payments.createIndex({ merchantId: 1, amount: 1, createdAt: -1 }, { name: 'ix_ERS' });
db.payments.createIndex({ merchantId: 1, createdAt: -1, amount: 1 }, { name: 'ix_ESR' });

// hint() forces a specific index, like WITH (INDEX(...)) in SQL Server. Here it lets us compare both indexes.

// --- A wide range: amount >= 100 matches about 90% of m1's payments ---
report('C1. wide range, E-R-S index (hint ix_ERS)', aboveAmountNewest('100').hint('ix_ERS'));
// Check: FETCH -> SORT -> IXSCAN(ix_ERS), about 72 000 keys.
// Why: inside m1 the entries are ordered by amount, not by date. MongoDB must read every entry with
// amount >= 100 and sort them all by date in memory to find the 20 newest.

report('C2. wide range, E-S-R index (hint ix_ESR)', aboveAmountNewest('100').hint('ix_ESR'));
// Check: LIMIT -> FETCH -> IXSCAN(ix_ESR), no SORT, about 20-25 keys.
// Why: inside m1 the entries are ordered by date. MongoDB walks from the newest, checks amount on the index entry
// itself and stops after 20 matches. This is why ESR is the default rule.

// --- A narrow range: amount >= 990 matches about 1% of m1's payments ---
report('C3. narrow range, E-R-S index (hint ix_ERS)', aboveAmountNewest('990').hint('ix_ERS'));
report('C4. narrow range, E-S-R index (hint ix_ESR)', aboveAmountNewest('990').hint('ix_ESR'));
// Check: now E-R-S reads fewer keys (several hundred) than E-S-R (one to two thousand).
// Why: E-R-S jumps straight to the few large amounts and sorts a small set. E-S-R walks many recent payments
// to find 20 large ones. ESR is a good default, not a law: always confirm with explain().

// --- Without hint: the query planner chooses ---
// The planner runs the candidate plans for a short time, picks the one that does the least work and caches the
// choice for this query shape. Like SQL Server, it does not always pick the index you expect.
report('C5. wide range, no hint: the planner chooses', aboveAmountNewest('100'));
report('C6. narrow range, no hint: the planner chooses', aboveAmountNewest('990'));
// Check: C5 usually picks merchantId_1_createdAt_-1 from Part B (also ordered by date), C6 picks ix_ERS.

// =============================================================================
// Part D. Covered query
// =============================================================================
// If the filter, the sort and the returned fields are all in one index, MongoDB builds the result from the index
// alone and does not read documents. Like a covering index with INCLUDE columns in SQL Server.
// _id must be excluded: it is not part of this index, and reading it would need the document.
report('D1. covered query (totalDocsExamined = 0)', db.payments
    .find({ merchantId: 'm3' }, { _id: 0, merchantId: 1, createdAt: 1 })
    .sort({ createdAt: -1 })
    .limit(20));
// Check: PROJECTION_COVERED instead of FETCH, totalDocsExamined 0.

// =============================================================================
// Part E. Index on an array field (multikey index)
// =============================================================================
// An index on 'attempts.provider' gets one entry per array element: a payment with 3 attempts has 3 entries.
// MongoDB makes such an index "multikey" automatically. This is how you index embedded data without a JOIN table.
const byProvider = () => db.payments.find({ 'attempts.provider': 'Klarna', 'attempts.result': 'Timeout' }).limit(20);
db.payments.createIndex({ 'attempts.provider': 1, 'attempts.result': 1 });
report('E1. multikey index on attempts', byProvider());
// Check: IXSCAN on the attempts index. More keys and documents are read than returned: without $elemMatch the two
// conditions may match different elements (see lesson 1, Part 3), so MongoDB must check each document.

// =============================================================================
// Part F. What indexes cost
// =============================================================================
// An index is a sorted copy of some fields. Every insert and update must change every index of the collection,
// and every index takes disk and memory. As in SQL Server: create indexes for real queries, not "just in case".
print('\n=== F. index sizes (bytes)');
printjson(db.payments.aggregate([{ $collStats: { storageStats: {} } }]).next().storageStats.indexSizes);
// Check: the three-field indexes ix_ERS and ix_ESR are the largest after _id.
print('\n=== F. indexes');
db.payments.getIndexes().forEach(ix => print(`  ${ix.name.padEnd(42)} ${JSON.stringify(ix.key)}`));

// =============================================================================
// Exercises
// =============================================================================
// 1. C5 usually chooses merchantId_1_createdAt_-1, not ix_ESR. Compare totalDocsExamined of C2 and C5: why are they
//    different? Then drop ix_ERS and run C6 again. Which index wins now?
// 2. Find failed EUR payments of m2 in the last 30 days, newest first. Design an index by the ESR rule
//    and prove with explain() that there is no SORT stage and totalDocsExamined ≈ nReturned.
// 3. Make query D1 not covered by adding `amount: 1` to the projection. What changes in the plan?
// 4. Run db.payments.find({ status: 'Pending' }).explain('allPlansExecution') with two indexes that start
//    with status. Look at rejectedPlans.
// 5. Delete index { customerId: 1 } with db.payments.dropIndex(...). Hide one index instead with
//    db.payments.hideIndex(...) and check that the planner ignores it. Why is hiding safer in production?
