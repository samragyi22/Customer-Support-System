/**
 * scripts/seed.js
 *
 * Inserts representative sample data into `agents` and `tickets`.
 *
 * - 4 agents (one per department, various statuses)
 * - 6 tickets (covering all priorities, some assigned, one SLA-breached)
 *
 * Run:  node scripts/seed.js
 *
 * NOTE: The script is NOT idempotent — running it twice creates duplicates
 *       (except for agents, which will fail on the unique email index).
 *       Drop the collections first if you need a clean slate:
 *         docker exec -it css_mongo mongosh customer_support --eval "db.agents.drop(); db.tickets.drop()"
 *       Then re-run init-db.js and seed.js.
 */

"use strict";

const { ObjectId } = require("mongodb");
const { getDb, closeDb } = require("./db");

// ── Helpers ─────────────────────────────────────────────────────────────────

function slaDeadline(priority, from = new Date()) {
  const hours = { critical: 4, high: 8, medium: 24, low: 72 };
  return new Date(from.getTime() + hours[priority] * 60 * 60 * 1000);
}

function pastDate(hoursAgo) {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
}

// ── Agent fixtures ──────────────────────────────────────────────────────────

function buildAgents() {
  const now = new Date();

  // Pre-assign ObjectIds so we can reference them from tickets
  const ids = {
    alice:   new ObjectId(),
    bob:     new ObjectId(),
    carol:   new ObjectId(),
    dave:    new ObjectId(),
  };

  const agents = [
    {
      _id:                   ids.alice,
      name:                  "Alice Sharma",
      email:                 "alice@support.example.com",
      department:            "technical",
      status:                "active",
      maxConcurrentTickets:  10,
      skills:                ["networking", "linux", "api"],
      createdAt:             now,
    },
    {
      _id:                   ids.bob,
      name:                  "Bob Verma",
      email:                 "bob@support.example.com",
      department:            "billing",
      status:                "active",
      maxConcurrentTickets:  15,
      skills:                ["refunds", "invoices", "subscriptions"],
      createdAt:             now,
    },
    {
      _id:                   ids.carol,
      name:                  "Carol Singh",
      email:                 "carol@support.example.com",
      department:            "escalations",
      status:                "active",
      maxConcurrentTickets:  5,
      skills:                ["legal", "retention", "executive"],
      createdAt:             now,
    },
    {
      _id:                   ids.dave,
      name:                  "Dave Patel",
      email:                 "dave@support.example.com",
      department:            "general",
      status:                "on_leave",          // cannot receive new tickets
      maxConcurrentTickets:  12,
      skills:                ["onboarding", "general"],
      createdAt:             now,
    },
  ];

  return { agents, ids };
}

// ── Ticket fixtures ─────────────────────────────────────────────────────────

function buildTickets(agentIds) {
  const now = new Date();

  return [
    // T-1  Critical, assigned to Alice, NOT yet breached
    {
      customerId:        "cust-001",
      customerEmail:     "john.doe@example.com",
      subject:           "Production API returning 503 on all endpoints",
      description:       "Since 10:30 UTC our integration with your API returns 503. Affecting 5000 users.",
      category:          "bug",
      tags:              ["api", "production", "outage"],
      priority:          "critical",
      status:            "in_progress",
      sla: {
        deadline:   slaDeadline("critical", now),
        breached:   false,
      },
      assignedAgentId:   agentIds.alice,
      assignedAgentName: "Alice Sharma",
      statusHistory: [
        { status: "open",        changedAt: pastDate(2), changedBy: "system",    note: "Auto-opened on submission" },
        { status: "in_progress", changedAt: pastDate(1), changedBy: agentIds.alice.toHexString(), note: "Investigating logs" },
      ],
      createdAt:  pastDate(2),
      updatedAt:  pastDate(1),
    },

    // T-2  High, assigned to Bob, billing category
    {
      customerId:        "cust-002",
      customerEmail:     "jane.smith@example.com",
      subject:           "Charged twice for June invoice",
      description:       "My credit card shows two charges of $99 on June 1st. Order #INV-9988.",
      category:          "billing",
      tags:              ["duplicate-charge", "invoice"],
      priority:          "high",
      status:            "open",
      sla: {
        deadline:   slaDeadline("high", pastDate(10)),   // created 10h ago → already past 8h SLA
        breached:   true,
        resolvedAt: null,
      },
      assignedAgentId:   agentIds.bob,
      assignedAgentName: "Bob Verma",
      statusHistory: [
        { status: "open", changedAt: pastDate(10), changedBy: "system", note: "Auto-opened on submission" },
      ],
      createdAt:  pastDate(10),
      updatedAt:  pastDate(10),
    },

    // T-3  Medium, unassigned (new ticket in queue)
    {
      customerId:        "cust-003",
      customerEmail:     "alex.jones@example.com",
      subject:           "Cannot update billing address in account settings",
      description:       "The Save button on the billing address form does nothing when I click it.",
      category:          "account",
      priority:          "medium",
      status:            "open",
      sla: {
        deadline:   slaDeadline("medium", now),
        breached:   false,
      },
      assignedAgentId:   null,
      assignedAgentName: null,
      statusHistory: [
        { status: "open", changedAt: now, changedBy: "system" },
      ],
      createdAt:  now,
      updatedAt:  now,
    },

    // T-4  Low, resolved, SLA met
    {
      customerId:        "cust-004",
      customerEmail:     "sara.lee@example.com",
      subject:           "Request for monthly usage report",
      description:       "Please send me the usage report for October 2026.",
      category:          "general",
      priority:          "low",
      status:            "resolved",
      sla: {
        deadline:   slaDeadline("low", pastDate(80)),
        breached:   false,
        resolvedAt: pastDate(5),
      },
      assignedAgentId:   agentIds.alice,
      assignedAgentName: "Alice Sharma",
      statusHistory: [
        { status: "open",     changedAt: pastDate(80), changedBy: "system" },
        { status: "resolved", changedAt: pastDate(5),  changedBy: agentIds.alice.toHexString(), note: "Report emailed" },
      ],
      createdAt:  pastDate(80),
      updatedAt:  pastDate(5),
    },

    // T-5  Critical, escalated to Carol
    {
      customerId:        "cust-005",
      customerEmail:     "tom.hardy@enterprise.com",
      subject:           "Data export failed — potential data loss",
      description:       "Automated nightly export job failed. We suspect records are being dropped. Contract ref: ENT-2200.",
      category:          "bug",
      tags:              ["enterprise", "data-loss", "escalation"],
      priority:          "critical",
      status:            "in_progress",
      sla: {
        deadline:   slaDeadline("critical", pastDate(3)),  // 3h old → 1h remaining
        breached:   false,
      },
      assignedAgentId:   agentIds.carol,
      assignedAgentName: "Carol Singh",
      statusHistory: [
        { status: "open",        changedAt: pastDate(3), changedBy: "system" },
        { status: "in_progress", changedAt: pastDate(2), changedBy: agentIds.carol.toHexString(), note: "Escalated to senior team" },
      ],
      createdAt:  pastDate(3),
      updatedAt:  pastDate(2),
    },

    // T-6  Medium, pending customer reply
    {
      customerId:        "cust-006",
      customerEmail:     "priya.nair@example.com",
      subject:           "Feature request: dark mode for dashboard",
      description:       "It would be great to have a dark mode option. Many of our team work late hours.",
      category:          "feature_request",
      tags:              ["ui", "dashboard"],
      priority:          "medium",
      status:            "pending_customer",
      sla: {
        deadline:   slaDeadline("medium", pastDate(20)),
        breached:   false,
      },
      assignedAgentId:   agentIds.bob,
      assignedAgentName: "Bob Verma",
      statusHistory: [
        { status: "open",             changedAt: pastDate(20), changedBy: "system" },
        { status: "in_progress",      changedAt: pastDate(18), changedBy: agentIds.bob.toHexString() },
        { status: "pending_customer", changedAt: pastDate(5),  changedBy: agentIds.bob.toHexString(), note: "Sent clarification questions" },
      ],
      createdAt:  pastDate(20),
      updatedAt:  pastDate(5),
    },
  ];
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Seeding Customer Support Database ===\n");

  let db;
  try {
    db = await getDb();
  } catch (err) {
    console.error("❌  Cannot connect to MongoDB:", err.message);
    process.exit(1);
  }

  const { agents, ids } = buildAgents();
  const tickets = buildTickets(ids);

  // ── Insert agents ─────────────────────────────────────────────────────
  console.log("── Inserting agents…");
  try {
    const res = await db.collection("agents").insertMany(agents, { ordered: false });
    console.log(`  ✓ Inserted ${res.insertedCount} agents\n`);
  } catch (err) {
    if (err.code === 11000) {
      console.warn("  ⚠  Some agents already exist (duplicate email). Skipping duplicates.\n");
    } else {
      throw err;
    }
  }

  // ── Insert tickets ────────────────────────────────────────────────────
  console.log("── Inserting tickets…");
  const res = await db.collection("tickets").insertMany(tickets);
  console.log(`  ✓ Inserted ${res.insertedCount} tickets\n`);

  // ── Summary ───────────────────────────────────────────────────────────
  const agentCount  = await db.collection("agents").countDocuments();
  const ticketCount = await db.collection("tickets").countDocuments();
  console.log(`📊  Database totals — agents: ${agentCount}, tickets: ${ticketCount}`);
  console.log("\n✅  Seeding complete. Run 'npm test' to verify schemas and indexes.\n");
}

main().finally(closeDb);
