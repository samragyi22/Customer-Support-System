/**
 * schemas/agent.schema.js
 *
 * MongoDB JSON-Schema validator for the `agents` collection.
 *
 * ENTITY: Agent
 * -------------
 * Represents a support-team member who can be assigned tickets.
 * Acts as the "parent" side of the Ticket → Agent relationship.
 *
 * ASSUMPTIONS
 * -----------
 * - An agent belongs to exactly one `department` (e.g. "billing", "technical").
 * - `maxConcurrentTickets` caps how many open tickets an agent can hold at once;
 *   enforcement is done at the application layer (not via a MongoDB trigger)
 *   because it requires counting live documents.
 * - Email is the natural business key; `_id` (ObjectId) is the surrogate key.
 * - `skills` helps the routing engine match tickets to specialised agents.
 */

"use strict";

const agentSchema = {
  $jsonSchema: {
    bsonType: "object",

    // Every field that MUST be present
    required: ["name", "email", "department", "status", "maxConcurrentTickets", "skills", "createdAt"],

    // No extra fields silently accepted
    additionalProperties: false,

    properties: {
      _id: {
        bsonType: "objectId",
        description: "Auto-generated MongoDB surrogate key."
      },

      name: {
        bsonType: "string",
        minLength: 2,
        maxLength: 100,
        description: "Full display name of the agent. Required, 2–100 chars."
      },

      email: {
        bsonType: "string",
        // Basic RFC-5322-ish pattern — good enough for a school-grade validator
        pattern: "^[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}$",
        description: "Unique work email. Used as the business key for lookups."
      },

      department: {
        bsonType: "string",
        // Only these departments exist; enforced at schema level
        enum: ["technical", "billing", "general", "escalations"],
        description: "Team the agent belongs to. Must be one of the four known departments."
      },

      status: {
        bsonType: "string",
        enum: ["active", "inactive", "on_leave"],
        description: "Current availability. Inactive/on-leave agents must NOT receive new tickets."
      },

      maxConcurrentTickets: {
        bsonType: "int",
        minimum: 1,
        maximum: 50,
        description: "Hard cap on simultaneous open tickets (application-enforced). Min 1, max 50."
      },

      skills: {
        bsonType: "array",
        minItems: 1,
        items: {
          bsonType: "string",
          minLength: 2
        },
        description: "Non-empty list of skill tags used by the auto-assignment engine."
      },

      createdAt: {
        bsonType: "date",
        description: "ISO date when the agent account was created. Set once, never updated."
      },

      updatedAt: {
        bsonType: "date",
        description: "ISO date of the last profile change. Optional; set by application on updates."
      }
    }
  }
};

// Indexes for the agents collection
const agentIndexes = [
  {
    // Unique index — enforces one account per email address.
    // The validator only checks the *format*; this index ensures *uniqueness*.
    // Trade-off: extra 1–2 ms on inserts/updates to maintain the B-tree;
    //            eliminates the need for a separate "check then insert" query.
    key:     { email: 1 },
    options: { unique: true, name: "uq_agents_email" }
  },
  {
    // Compound index — supports the roster query:
    //   "Find all ACTIVE agents in the TECHNICAL department"
    // used by the auto-assignment engine on every new ticket.
    // Trade-off: slightly larger index size (two fields) but
    //            far cheaper than a full collection scan at scale.
    key:     { department: 1, status: 1 },
    options: { name: "idx_agents_department_status" }
  }
];

module.exports = { agentSchema, agentIndexes };
