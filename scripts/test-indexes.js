/**
 * scripts/test-indexes.js
 *
 * Demonstrates each index by running representative queries and
 * printing the winning execution plan from MongoDB's explain output.
 *
 * HOW TO READ THE OUTPUT
 * ----------------------
 * "IXSCAN"  → index scan (good — the index was used)
 * "COLLSCAN" → full collection scan (index NOT used — investigate)
 * "FETCH"    → reads matching documents from disk after the index scan
 *
 * Run:  node scripts/test-indexes.js
 */

"use strict";

const { getDb, closeDb } = require("./db");

function extractStage(plan) {
  // Walk the winning plan tree to find the innermost stage name
  let node = plan.queryPlanner.winningPlan;
  const stages = [];
  while (node) {
    stages.push(node.stage);
    node = node.inputStage || null;
  }
  return stages.join(" → ");
}

function indexUsed(plan) {
  let node = plan.queryPlanner.winningPlan;
  while (node) {
    if (node.indexName) return node.indexName;
    node = node.inputStage || null;
  }
  return "(none)";
}

async function runTest(label, collection, queryFn) {
  const plan = await queryFn(collection).explain("queryPlanner");
  const stages = extractStage(plan);
  const idx    = indexUsed(plan);
  const icon   = stages.includes("IXSCAN") ? "✅" : "⚠️ ";
  console.log(`\n  ${icon} ${label}`);
  console.log(`     Plan:  ${stages}`);
  console.log(`     Index: ${idx}`);
}

async function main() {
  console.log("=== Index Query Plan Tests ===\n");

  let db;
  try {
    db = await getDb();
  } catch (err) {
    console.error("❌  Cannot connect to MongoDB:", err.message);
    process.exit(1);
  }

  const tickets = db.collection("tickets");
  const agents  = db.collection("agents");

  // ── INDEX 1: idx_tickets_status_priority_createdAt ──────────────────────
  console.log("── Index 1: idx_tickets_status_priority_createdAt");
  console.log("   Covers the agent work-queue dashboard.\n");

  await runTest(
    "Work queue — open+critical tickets sorted by age",
    tickets,
    (col) => col.find({ status: "open", priority: "critical" }).sort({ createdAt: 1 })
  );

  await runTest(
    "Prefix use — all open tickets (partial key)",
    tickets,
    (col) => col.find({ status: "open" })
  );

  await runTest(
    "COLLSCAN control — query on description (no index)",
    tickets,
    (col) => col.find({ description: /data/ })
  );

  // ── INDEX 2: idx_tickets_assignedAgentId_status ──────────────────────────
  console.log("\n── Index 2: idx_tickets_assignedAgentId_status");
  console.log("   Covers per-agent queue and SLA monitoring.\n");

  // Grab a real agent ObjectId from seeded data
  const sampleAgent = await agents.findOne({ status: "active" });
  const agentId = sampleAgent?._id ?? null;

  await runTest(
    "Agent's open/in-progress queue (GOOD — both fields in filter)",
    tickets,
    (col) => col.find({
      assignedAgentId: agentId,
      status: { $in: ["open", "in_progress"] }
    })
  );

  await runTest(
    "FAILURE CASE — assignedAgentId:null without status filter (less selective)",
    tickets,
    (col) => col.find({ assignedAgentId: null })
  );

  await runTest(
    "FIXED PATTERN — assignedAgentId:null WITH status filter (selective)",
    tickets,
    (col) => col.find({ assignedAgentId: null, status: "open" })
  );

  // ── INDEX 3: idx_tickets_sla_deadline_breached ───────────────────────────
  console.log("\n── Index 3: idx_tickets_sla_deadline_breached");
  console.log("   Covers the SLA monitor poller.\n");

  const soon = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes from now
  await runTest(
    "SLA monitor — tickets approaching deadline",
    tickets,
    (col) => col.find({ "sla.breached": false, "sla.deadline": { $lte: soon } })
  );

  // ── Agent indexes ────────────────────────────────────────────────────────
  console.log("\n── Agent indexes");

  await runTest(
    "uq_agents_email — lookup by email",
    agents,
    (col) => col.find({ email: "alice@support.example.com" })
  );

  await runTest(
    "idx_agents_department_status — active technical agents",
    agents,
    (col) => col.find({ department: "technical", status: "active" })
  );

  console.log("\n" + "─".repeat(55));
  console.log("✅ done index tests\n");
}

main().finally(closeDb);
