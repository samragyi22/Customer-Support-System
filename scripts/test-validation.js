/**
 * scripts/test-validation.js
 *
 * Tests MongoDB document validation for both collections.
 *
 * Strategy
 * --------
 * Each test attempts an insert that SHOULD FAIL (invalid document) or
 * SHOULD SUCCEED (valid document) and asserts the outcome.
 *
 * Covers
 * ------
 *  Agents:
 *    ✓ Valid agent insert
 *    ✗ Missing required field (email)
 *    ✗ Invalid enum value for department
 *    ✗ Email format violation
 *    ✗ Duplicate email (unique index)
 *
 *  Tickets:
 *    ✓ Valid ticket insert
 *    ✗ Missing required sub-document (sla)
 *    ✗ Subject too short (< 5 chars)
 *    ✗ Empty statusHistory array (minItems: 1)
 *    ✗ Invalid priority value
 *
 *  DOCUMENTED FAILURE CASE (from schema comments)
 *    The index on { assignedAgentId, status } has a known limitation:
 *    querying { assignedAgentId: null } without a status filter reads
 *    ALL unassigned tickets' index entries — still an index scan but
 *    not as selective as a query that includes status.
 *    This test demonstrates the issue and shows the correct query pattern.
 *
 * Run:  node scripts/test-validation.js
 */

"use strict";

const { ObjectId } = require("mongodb");
const { getDb, closeDb } = require("./db");

// ── Tiny test harness ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function expectReject(label, fn) {
  try {
    await fn();
    console.log(`  ❌ FAIL — ${label}`);
    console.log("     Expected an error but the operation succeeded.");
    failed++;
  } catch (err) {
    console.log(`  ✅ PASS — ${label}`);
    console.log(`     Rejected with: ${err.message.split("\n")[0].substring(0, 120)}`);
    passed++;
  }
}

async function expectSuccess(label, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS — ${label}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ FAIL — ${label}`);
    console.log(`     Unexpected error: ${err.message.split("\n")[0].substring(0, 120)}`);
    failed++;
  }
}

// ── Agent tests ──────────────────────────────────────────────────────────────

async function testAgents(db) {
  console.log("\n── Agent Validation Tests ──────────────────────────");
  const col = db.collection("agents");

  // Clean up test documents before and after
  const testEmail1 = "test.valid@support.example.com";
  const testEmail2 = "dupe@support.example.com";
  await col.deleteMany({ email: { $in: [testEmail1, testEmail2] } });

  // 1) Valid insert
  await expectSuccess("Valid agent document is accepted", async () => {
    await col.insertOne({
      name:                 "Test Agent",
      email:                testEmail1,
      department:           "technical",
      status:               "active",
      maxConcurrentTickets: 10,
      skills:               ["api"],
      createdAt:            new Date(),
    });
  });

  // 2) Missing required field — email
  await expectReject("Missing required field: email", async () => {
    await col.insertOne({
      name:                 "No Email Agent",
      department:           "general",
      status:               "active",
      maxConcurrentTickets: 5,
      skills:               ["chat"],
      createdAt:            new Date(),
    });
  });

  // 3) Invalid enum for department
  await expectReject("Invalid enum value for department: 'sales'", async () => {
    await col.insertOne({
      name:                 "Sales Agent",
      email:                "sales@support.example.com",
      department:           "sales",          // not in enum
      status:               "active",
      maxConcurrentTickets: 8,
      skills:               ["sales"],
      createdAt:            new Date(),
    });
  });

  // 4) Malformed email
  await expectReject("Email fails regex pattern: 'not-an-email'", async () => {
    await col.insertOne({
      name:                 "Bad Email Agent",
      email:                "not-an-email",   // fails pattern
      department:           "general",
      status:               "active",
      maxConcurrentTickets: 5,
      skills:               ["chat"],
      createdAt:            new Date(),
    });
  });

  // 5) Duplicate email (unique index)
  await col.deleteMany({ email: testEmail2 });
  await col.insertOne({
    name: "First Agent", email: testEmail2, department: "billing",
    status: "active", maxConcurrentTickets: 10, skills: ["invoices"], createdAt: new Date(),
  });

  await expectReject("Duplicate email rejected by unique index", async () => {
    await col.insertOne({
      name: "Second Agent", email: testEmail2, department: "general",
      status: "active", maxConcurrentTickets: 10, skills: ["chat"], createdAt: new Date(),
    });
  });

  // cleanup
  await col.deleteMany({ email: { $in: [testEmail1, testEmail2] } });
}

// ── Ticket tests ─────────────────────────────────────────────────────────────

async function testTickets(db) {
  console.log("\n── Ticket Validation Tests ─────────────────────────");
  const col = db.collection("tickets");

  const baseTicket = () => ({
    customerId:        "cust-test",
    customerEmail:     "test.customer@example.com",
    subject:           "Test ticket subject line",
    description:       "This is a detailed description of the test issue.",
    category:          "general",
    priority:          "medium",
    status:            "open",
    sla: {
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      breached:  false,
    },
    assignedAgentId:   null,
    assignedAgentName: null,
    statusHistory: [
      { status: "open", changedAt: new Date(), changedBy: "system" }
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  let inserted = [];

  // 1) Valid insert
  await expectSuccess("Valid ticket document is accepted", async () => {
    const r = await col.insertOne(baseTicket());
    inserted.push(r.insertedId);
  });

  // 2) Missing sla sub-document
  await expectReject("Missing required field: sla", async () => {
    const doc = baseTicket();
    delete doc.sla;
    await col.insertOne(doc);
  });

  // 3) Subject too short
  await expectReject("Subject under minLength (5 chars) rejected", async () => {
    const doc = baseTicket();
    doc.subject = "Hi";   // only 2 chars
    await col.insertOne(doc);
  });

  // 4) Empty statusHistory
  await expectReject("Empty statusHistory array rejected (minItems:1)", async () => {
    const doc = baseTicket();
    doc.statusHistory = [];
    await col.insertOne(doc);
  });

  // 5) Invalid priority
  await expectReject("Invalid priority value 'urgent' rejected", async () => {
    const doc = baseTicket();
    doc.priority = "urgent";   // not in enum
    await col.insertOne(doc);
  });

  // cleanup
  await col.deleteMany({ _id: { $in: inserted } });
}

// ── Documented failure-case test ─────────────────────────────────────────────

async function testKnownIndexLimitation(db) {
  console.log("\n── Documented Index Failure-Case ───────────────────");
  console.log("  Scenario: Querying { assignedAgentId: null } without a status filter");
  console.log("            reads ALL unassigned-ticket index entries (not selective).\n");

  const col = db.collection("tickets");

  // BAD pattern — noted in schema comments
  const badPlan = await col
    .find({ assignedAgentId: null })
    .explain("queryPlanner");

  const badStage = badPlan.queryPlanner.winningPlan.stage;
  console.log(`  BAD  query plan stage: ${badStage}`);

  // GOOD pattern — always pair assignedAgentId with status
  const goodPlan = await col
    .find({ assignedAgentId: null, status: "open" })
    .explain("queryPlanner");

  const goodStage = goodPlan.queryPlanner.winningPlan.stage
    || goodPlan.queryPlanner.winningPlan.inputStage?.stage;
  console.log(`  GOOD query plan stage: ${goodStage}`);

  console.log("\n  ℹ️  Takeaway: Always include status in the filter when querying by assignedAgentId.");
  console.log("     The compound index { assignedAgentId, status } is most effective with both fields.\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Validation & Schema Tests ===");

  let db;
  try {
    db = await getDb();
  } catch (err) {
    console.error("❌  Cannot connect to MongoDB:", err.message);
    process.exit(1);
  }

  await testAgents(db);
  await testTickets(db);
  await testKnownIndexLimitation(db);

  console.log("─".repeat(55));
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().finally(closeDb);
