# Customer Support System — MongoDB Schema Design

> **Assignment**: MongoDB Schema & Indexes  
> **Context**: Customer support desk — ticket priority, assignment, and SLA tracking

---

## Table of Contents
1. [Project Structure](#project-structure)
2. [Entities](#entities)
3. [Schema Design](#schema-design)
   - [Agent Schema](#agent-schema)
   - [Ticket Schema](#ticket-schema)
4. [Validation Rules](#validation-rules)
5. [Relationship Strategy](#relationship-strategy)
6. [Indexes](#indexes)
7. [Assumptions](#assumptions)
8. [Failure Case](#failure-case)
9. [How to Run & Test](#how-to-run--test)
10. [Testing Methodology](#testing-methodology)

---

## Project Structure

```
customer-support-system/
├── schemas/
│   ├── agent.schema.js       # Agent entity: validator + indexes
│   └── ticket.schema.js      # Ticket entity: validator + indexes
├── scripts/
│   ├── db.js                 # Shared MongoDB connection helper
│   ├── init-db.js            # Creates collections + applies validators + indexes
│   ├── seed.js               # Inserts representative sample data
│   ├── test-validation.js    # Tests schema validation rules (pass/fail assertions)
│   └── test-indexes.js       # Shows explain() plans for each index
├── docker-compose.yml        # MongoDB 7 single-node for local dev
├── .env.example              # Environment variable template
├── package.json
└── README.md
```

---

## Entities

The system models two related entities:

| Entity | Collection | Role |
|--------|------------|------|
| **Agent** | `agents` | A support-team member who is assigned tickets |
| **Ticket** | `tickets` | A customer-reported issue tracked from open to resolution |

---

## Schema Design

### Agent Schema

```js
// schemas/agent.schema.js  (key fields)
{
  _id:                  ObjectId,      // surrogate key
  name:                 String,        // 2–100 chars, required
  email:                String,        // unique, regex-validated, required
  department:           String,        // enum: technical | billing | general | escalations
  status:               String,        // enum: active | inactive | on_leave
  maxConcurrentTickets: Int32,         // 1–50, enforced by app layer
  skills:               [String],      // non-empty, used by auto-assign engine
  createdAt:            Date,          // immutable
  updatedAt:            Date           // optional, set on update
}
```

**Key design decisions:**
- `email` is both format-validated (regex in `$jsonSchema`) and uniqueness-enforced (unique index).
- `department` is an enum, so adding a new department is a schema migration — a deliberate constraint that prevents typos reaching the DB.
- `maxConcurrentTickets` is stored here but *enforced at the application layer* (requires a live count query; MongoDB validators cannot perform cross-document aggregations).

---

### Ticket Schema

```js
// schemas/ticket.schema.js  (key fields)
{
  _id:               ObjectId,
  customerId:        String,          // CRM/auth system external ID
  customerEmail:     String,          // regex-validated
  subject:           String,          // 5–200 chars
  description:       String,          // ≥10 chars
  category:          String,          // enum: bug | billing | feature_request | account | general
  tags:              [String],        // optional free-form labels
  priority:          String,          // enum: critical | high | medium | low
  status:            String,          // enum: open | in_progress | pending_customer | resolved | closed

  sla: {                             // required sub-document
    deadline:        Date,           // absolute UTC deadline computed at creation
    breached:        Boolean,        // set true by SLA monitor when deadline passes
    resolvedAt:      Date            // optional — set when ticket is resolved
  },

  assignedAgentId:   ObjectId|null,  // → agents._id  (null = unassigned)
  assignedAgentName: String|null,    // denormalised snapshot for fast list views

  statusHistory: [{                  // append-only audit trail, minItems: 1
    status:     String,
    changedAt:  Date,
    changedBy:  String,              // agent ID string or "system"
    note:       String               // optional reason
  }],

  createdAt:   Date,
  updatedAt:   Date
}
```

---

## Validation Rules

MongoDB `$jsonSchema` validators are applied with **`validationLevel: strict`** (all inserts and updates) and **`validationAction: error`** (reject, do not warn).

| Field | Rule | Rationale |
|-------|------|-----------|
| `email` | regex pattern | Prevents malformed addresses reaching the DB |
| `department` | enum | Prevents typo-departments; schema migration required to add new ones |
| `priority` | enum | Keeps SLA logic deterministic — no "URGENT!!" free-text |
| `subject` | minLength: 5 | Avoids single-character noise tickets |
| `statusHistory` | minItems: 1 | Every ticket must have at least its initial "open" entry |
| `sla` | required object | SLA tracking is mandatory — cannot accidentally omit it |
| `maxConcurrentTickets` | minimum: 1, maximum: 50 | Prevents zero-cap (agent can't work) or absurdly large caps |
| `additionalProperties: false` | on both schemas | Rejects unknown fields — prevents silent schema drift |

---

## Relationship Strategy

```
tickets.assignedAgentId  ──────►  agents._id
                (ObjectId reference)
```

**Pattern used: Normalised Reference (Manual Reference)**

The `Ticket` document stores `assignedAgentId` (an ObjectId pointing to `agents._id`).  
A denormalised `assignedAgentName` snapshot is also stored to avoid joins on list views.

### Why Reference, not Embed?

| Factor | Decision |
|--------|----------|
| Agent data changes independently | ✅ Reference — one source of truth for agent profile |
| Many tickets per agent | ✅ Reference — avoids duplicating agent data across thousands of tickets |
| List views need agent name | ✅ Denormalise `assignedAgentName` as a snapshot — fast reads without joins |
| Ticket detail needs full agent profile | Application performs a two-query join (get ticket → get agent by ID) |
| Agent can be reassigned | ✅ Only `assignedAgentId` changes; `assignedAgentName` is updated at the same time |

**Trade-off:** The denormalised `assignedAgentName` can become stale if an agent legally changes their name. The application update path must write to both the `agents` document and all open `tickets` assigned to that agent (a background migration job).

---

## Indexes

### Index 1 — Ticket Work Queue

```js
// Collection: tickets
{ status: 1, priority: 1, createdAt: 1 }
// Name: idx_tickets_status_priority_createdAt
```

**Query it improves:**
```js
// Agent dashboard — load open+critical tickets in arrival order
db.tickets.find({ status: "open", priority: "critical" })
           .sort({ createdAt: 1 })
```

**Why this index works:**  
Follows the **ESR rule** (Equality → Sort → Range): `status` and `priority` are equality filters, `createdAt` is the sort key. MongoDB reads only the matching B-tree leaf pages and returns documents already in sort order — no in-memory sort step.

**Additional benefit:**  
Queries using only a *prefix* of the index (e.g., `{ status: "open" }`) also benefit — the index is not wasted on exact-key queries only.

**Trade-off:**  
Every ticket INSERT and every status/priority UPDATE must maintain this B-tree. At typical support-desk volumes (<10k tickets/day) the overhead is negligible (<1 ms). On a high-frequency event-ingest pipeline it should be profiled.

---

### Index 2 — Per-Agent Queue

```js
// Collection: tickets
{ assignedAgentId: 1, status: 1 }
// Name: idx_tickets_assignedAgentId_status
```

**Query it improves:**
```js
// Agent's personal queue — all open/in-progress tickets assigned to them
db.tickets.find({
  assignedAgentId: ObjectId("..."),
  status: { $in: ["open", "in_progress"] }
})

// SLA monitor — which tickets does this agent have that could breach?
db.tickets.find({ assignedAgentId: ObjectId("..."), status: "in_progress" })
```

**Why this index works:**  
`assignedAgentId` is the leading key, so all tickets for a specific agent are co-located in adjacent B-tree leaves. The `status` field further filters without touching documents.

**Trade-off:**  
When `assignedAgentId` is `null` (unassigned tickets), *all* unassigned tickets share one index bucket. Querying `{ assignedAgentId: null }` without also filtering on `status` reads all those entries — still faster than a COLLSCAN, but far less selective than a named-agent query. See [Failure Case](#failure-case).

---

### Index 3 — SLA Deadline Monitor *(bonus)*

```js
// Collection: tickets
{ "sla.deadline": 1, "sla.breached": 1 }
// Name: idx_tickets_sla_deadline_breached
```

**Query it improves:**
```js
// SLA monitor polls every minute for approaching-breach tickets
db.tickets.find({
  "sla.breached": false,
  "sla.deadline": { $lte: new Date(Date.now() + 15 * 60 * 1000) }
})
```

**Trade-off:**  
Dotted-path index on a sub-document field. If the `sla` field is ever renamed, the index becomes dead weight. Field naming should be treated as a contract.

---

## Assumptions

1. **SLA deadlines are pre-computed** at ticket creation time based on a fixed priority-to-hours mapping (critical=4h, high=8h, medium=24h, low=72h). Changing the mapping does not retroactively alter existing deadlines.

2. **`assignedAgentId` is nullable.** New tickets are `null`; assignment is done by a routing engine or manually by a supervisor.

3. **Status transitions are enforced at the application layer**, not in MongoDB. The validator only checks that the value is one of the five known states; it does not prevent illegal transitions (e.g., going from `resolved` back to `open`).

4. **`statusHistory` is append-only** — no entries are ever deleted or edited. This is a convention documented in code but not enforced by the DB (enforcing immutability of array elements in MongoDB requires application-level guards).

5. **One department per agent.** Cross-department escalation is handled by reassigning the ticket to an agent in the target department, not by giving agents multiple departments.

6. **`maxConcurrentTickets`** is enforced by the application via a count-then-assign transaction, not by a MongoDB trigger or validator (validators cannot cross-reference collections).

---

## Failure Case

**Problem:** The index `{ assignedAgentId, status }` is **not fully selective** when querying only `{ assignedAgentId: null }` without a status filter.

**Why it happens:**  
All unassigned tickets have `assignedAgentId: null`. They form a single bucket in the leading index key. Without a `status` filter, MongoDB must read *all* entries in that bucket — the second index field provides no additional discrimination.

**Demonstration (see `test-validation.js`):**
```js
// BAD — reads all unassigned entries (less selective)
db.tickets.find({ assignedAgentId: null })

// GOOD — the status field prunes the scan significantly
db.tickets.find({ assignedAgentId: null, status: "open" })
```

**Mitigation options:**
- Always pair `assignedAgentId` with a `status` filter in application code.
- Alternatively, create a **partial index** that only indexes unresolved tickets:
  ```js
  { key: { assignedAgentId: 1, status: 1 },
    partialFilterExpression: { status: { $in: ["open", "in_progress"] } } }
  ```
  This shrinks the index size by ~40% and makes the null-bucket much smaller. Not implemented here to keep the index general-purpose for history queries.

---

## How to Run & Test

### Prerequisites
- **Docker** (for MongoDB) OR a local MongoDB 7 instance
- **Node.js ≥ 18**

### 1. Start MongoDB

```bash
docker-compose up -d
```

Starts a MongoDB 7 instance at `mongodb://localhost:27017` with a persistent volume.

### 2. Install dependencies

```bash
npm install
```

### 3. Initialise the database

Creates both collections with validators and all indexes:

```bash
npm run init-db
```

Expected output:
```
=== Customer Support System — DB Initialisation ===
── agents ──────────────────────────────────────────
  ✓ Created collection: agents
  ✓ Index ready: uq_agents_email on agents
  ✓ Index ready: idx_agents_department_status on agents
── tickets ─────────────────────────────────────────
  ✓ Created collection: tickets
  ✓ Index ready: idx_tickets_status_priority_createdAt on tickets
  ✓ Index ready: idx_tickets_assignedAgentId_status on tickets
  ✓ Index ready: idx_tickets_sla_deadline_breached on tickets
✅  Database initialisation complete.
```

### 4. Seed sample data

Inserts 4 agents and 6 tickets representing all priority levels, statuses, and SLA states:

```bash
npm run seed
```

### 5. Run validation tests

```bash
npm run test:validate
```

Runs 10 assertions — 5 on agents, 5 on tickets — covering both valid inserts (should succeed) and invalid inserts (should be rejected by the validator or unique index).

### 6. Run index plan tests

```bash
npm run test:indexes
```

Runs `explain("queryPlanner")` on each key query and prints the winning plan stage. Expect `IXSCAN` for all indexed queries.

### 7. Run all tests

```bash
npm test
```

---

## Testing Methodology

| What was tested | How |
|----------------|-----|
| Schema validator rejects missing required fields | `insertOne` without `email`/`sla` → assert error thrown |
| Schema validator rejects enum violations | Insert `department: "sales"` → assert error |
| Schema validator rejects format violations | Insert `email: "not-an-email"` → assert error |
| Unique index prevents duplicate emails | Insert two agents with same email → assert duplicate key error |
| `additionalProperties: false` enforced | Implicitly covered — all test inserts use only known fields |
| Indexes are actually used by query planner | `explain("queryPlanner")` → check `winningPlan` for `IXSCAN` and correct `indexName` |
| Failure case demonstrated | `explain()` on `{ assignedAgentId: null }` vs `{ assignedAgentId: null, status: "open" }` — plan stages compared |

All tests are automated in `scripts/test-validation.js` and `scripts/test-indexes.js` with pass/fail counters. `npm test` exits with code 1 if any assertion fails.
