/**
 * schemas/ticket.schema.js
 *
 * MongoDB JSON-Schema validator for the `tickets` collection.
 *
 * ENTITY: Ticket
 * --------------
 * Core unit of work in the support desk. Tracks customer issues
 * from creation through resolution, including SLA deadlines and
 * the full audit trail of status changes.
 *
 * RELATIONSHIP STRATEGY  (Reference / Normalised)
 * ------------------------------------------------
 * `assignedAgentId` stores the ObjectId of a document in `agents`.
 * WHY reference instead of embed?
 *   - Agent data changes independently (status, skills, department).
 *   - Many tickets share one agent → embedding would duplicate agent data.
 *   - Application performs a $lookup / two-query join only when it needs
 *     the agent's full profile (e.g. the ticket detail page).
 *   - For list views, the denormalised `assignedAgentName` snapshot
 *     avoids the join entirely for the 95 % read path.
 *
 * ASSUMPTIONS
 * -----------
 * - `priority` is set by a triage rule engine when a ticket is created
 *   and may be overridden by a supervisor.
 * - SLA deadlines are stored as absolute UTC dates computed from priority
 *   at creation time (critical=4h, high=8h, medium=24h, low=72h).
 * - `statusHistory` is append-only; it is never trimmed.
 * - A ticket starts as "open" and can only close via "resolved" or "closed".
 */

"use strict";

const ticketSchema = {
  $jsonSchema: {
    bsonType: "object",

    required: [
      "customerId",
      "customerEmail",
      "subject",
      "description",
      "priority",
      "status",
      "category",
      "sla",
      "statusHistory",
      "createdAt"
    ],

    additionalProperties: false,

    properties: {
      _id: {
        bsonType: "objectId",
        description: "Auto-generated surrogate key."
      },

      // ── Customer identity ───────────────────────────────────────────────
      customerId: {
        bsonType: "string",
        minLength: 1,
        description: "External customer identifier from the CRM / auth system."
      },

      customerEmail: {
        bsonType: "string",
        pattern: "^[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}$",
        description: "Customer contact email. Validated against a basic RFC pattern."
      },

      // ── Ticket content ──────────────────────────────────────────────────
      subject: {
        bsonType: "string",
        minLength: 5,
        maxLength: 200,
        description: "One-line summary of the issue. 5–200 characters."
      },

      description: {
        bsonType: "string",
        minLength: 10,
        description: "Full problem description. At least 10 characters required."
      },

      category: {
        bsonType: "string",
        enum: ["bug", "billing", "feature_request", "account", "general"],
        description: "Issue category, used for routing and reporting."
      },

      tags: {
        bsonType: "array",
        items: { bsonType: "string", minLength: 1 },
        description: "Free-form labels added by triage (optional)."
      },

      // ── Priority & SLA ──────────────────────────────────────────────────
      priority: {
        bsonType: "string",
        enum: ["critical", "high", "medium", "low"],
        description: "Triage priority. Drives SLA deadline and routing order."
      },

      sla: {
        bsonType: "object",
        required: ["deadline", "breached"],
        additionalProperties: false,
        properties: {
          deadline: {
            bsonType: "date",
            description: "Absolute UTC datetime by which the ticket must be resolved."
          },
          breached: {
            bsonType: "bool",
            description: "True once the deadline passes without resolution. Polled / event-driven."
          },
          resolvedAt: {
            bsonType: "date",
            description: "When the ticket was actually resolved. Used to compute actual handle time."
          }
        },
        description: "SLA tracking sub-document."
      },

      // ── Assignment (relationship to Agent) ──────────────────────────────
      assignedAgentId: {
        bsonType: ["objectId", "null"],
        description: "Foreign key → agents._id. Null when unassigned (new tickets)."
      },

      assignedAgentName: {
        bsonType: ["string", "null"],
        description: "Denormalised snapshot of agent name at assignment time — avoids joins on list views."
      },

      // ── Lifecycle ───────────────────────────────────────────────────────
      status: {
        bsonType: "string",
        enum: ["open", "in_progress", "pending_customer", "resolved", "closed"],
        description: "Current lifecycle state. Transitions enforced at application layer."
      },

      statusHistory: {
        bsonType: "array",
        minItems: 1,          // at least the initial "open" entry
        items: {
          bsonType: "object",
          required: ["status", "changedAt", "changedBy"],
          additionalProperties: false,
          properties: {
            status: {
              bsonType: "string",
              enum: ["open", "in_progress", "pending_customer", "resolved", "closed"]
            },
            changedAt: { bsonType: "date" },
            changedBy: {
              bsonType: "string",
              description: "Agent ID or 'system' for automated transitions."
            },
            note: {
              bsonType: "string",
              description: "Optional free-text reason for the transition."
            }
          }
        },
        description: "Immutable audit trail of every status change."
      },

      createdAt: {
        bsonType: "date",
        description: "UTC timestamp of ticket creation. Immutable."
      },

      updatedAt: {
        bsonType: "date",
        description: "UTC timestamp of the last write. Updated on every mutation."
      }
    }
  }
};

// ── Indexes ─────────────────────────────────────────────────────────────────
const ticketIndexes = [
  {
    /**
     * INDEX 1 — Compound: { status, priority, createdAt }
     *
     * QUERY IT IMPROVES
     * -----------------
     * The agent dashboard loads the work queue:
     *   db.tickets.find({ status: "open", priority: "critical" })
     *               .sort({ createdAt: 1 })
     * Without this index MongoDB scans every ticket document.
     * With it, only the matching B-tree leaf pages are read.
     *
     * DESIGN NOTES
     * ------------
     * - ESR rule applied: Equality fields first (status, priority),
     *   Sort field last (createdAt).
     * - Works for narrower queries too: { status: "open" } alone
     *   uses a prefix of the index.
     *
     * TRADE-OFF
     * ---------
     * + Dramatically faster reads for the high-traffic work-queue page.
     * - Every INSERT and status UPDATE must maintain this B-tree.
     *   At ticket-volume scale the write overhead is negligible (<1 ms),
     *   but on a write-heavy ingest pipeline it should be monitored.
     */
    key:     { status: 1, priority: 1, createdAt: 1 },
    options: { name: "idx_tickets_status_priority_createdAt" }
  },

  {
    /**
     * INDEX 2 — Compound: { assignedAgentId, status }
     *
     * QUERY IT IMPROVES
     * -----------------
     * The agent's personal queue and the SLA monitor both run:
     *   db.tickets.find({ assignedAgentId: <ObjectId>, status: { $in: ["open","in_progress"] } })
     * This index turns that into a targeted range scan vs. a full collection scan.
     *
     * DESIGN NOTES
     * ------------
     * - Partial index alternative: could add `partialFilterExpression:
     *   { status: { $in: ["open","in_progress"] } }` to exclude resolved/closed
     *   tickets and reduce index size by ~40 %. Not done here to keep the index
     *   general-purpose (also serves history queries for a given agent).
     *
     * TRADE-OFF
     * ---------
     * + Fast per-agent queue lookups — O(k) where k = tickets for that agent.
     * - Null assignedAgentId (unassigned tickets) all share one index entry;
     *   FAILURE CASE: a query filtering ONLY on { assignedAgentId: null } skips
     *   the status field and reads every unassigned-ticket entry — still faster
     *   than a collection scan, but callers should always include a status filter.
     */
    key:     { assignedAgentId: 1, status: 1 },
    options: { name: "idx_tickets_assignedAgentId_status" }
  },

  {
    /**
     * INDEX 3 — SLA breach TTL-style support index
     *
     * QUERY IT IMPROVES
     * -----------------
     * The SLA monitor polls for tickets approaching their deadline:
     *   db.tickets.find({ "sla.breached": false, "sla.deadline": { $lte: <now+15min> } })
     * Allows fast identification of tickets about to breach SLA.
     *
     * TRADE-OFF
     * ---------
     * + Keeps the SLA monitor cheap even with millions of tickets.
     * - Dotted-path index on a sub-document field; if the sla field is ever
     *   renamed the index name must be updated or it becomes unused.
     */
    key:     { "sla.deadline": 1, "sla.breached": 1 },
    options: { name: "idx_tickets_sla_deadline_breached" }
  }
];

module.exports = { ticketSchema, ticketIndexes };
