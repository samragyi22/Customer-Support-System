/**
 * scripts/init-db.js
 *
 * Creates (or reconfigures) the `agents` and `tickets` collections with:
 *   - JSON Schema validators (enforcing field types, required fields, enums)
 *   - All indexes defined in the schema files
 *
 * Run:  node scripts/init-db.js
 *
 * Safe to re-run: uses createCollection only when the collection does not exist,
 * and createIndex with { background: true } which is idempotent.
 */

"use strict";

const { getDb, closeDb } = require("./db");
const { agentSchema, agentIndexes }   = require("../schemas/agent.schema");
const { ticketSchema, ticketIndexes } = require("../schemas/ticket.schema");

// ── Helper ──────────────────────────────────────────────────────────────────

async function ensureCollection(db, collName, validator) {
  const existing = await db.listCollections({ name: collName }).toArray();

  if (existing.length === 0) {
    // Collection does not exist → create it with the validator
    await db.createCollection(collName, {
      validator,
      validationLevel:  "strict",   // validate ALL inserts and updates
      validationAction: "error",    // reject (not warn) invalid documents
    });
    console.log(`  ✓ Created collection: ${collName}`);
  } else {
    // Collection exists → update its validator (schema evolution)
    await db.command({
      collMod:          collName,
      validator,
      validationLevel:  "strict",
      validationAction: "error",
    });
    console.log(`  ↻ Updated validator on existing collection: ${collName}`);
  }
}

async function ensureIndexes(db, collName, indexDefs) {
  const coll = db.collection(collName);
  for (const { key, options } of indexDefs) {
    await coll.createIndex(key, options);
    console.log(`  ✓ Index ready: ${options.name} on ${collName}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Customer Support System — DB Initialisation ===\n");

  let db;
  try {
    db = await getDb();
    console.log(`Connected to: ${db.databaseName}\n`);
  } catch (err) {
    console.error("❌  Could not connect to MongoDB. Is it running?");
    console.error("    Start it with:  docker-compose up -d");
    console.error(`    Error: ${err.message}`);
    process.exit(1);
  }

  // ── agents ─────────────────────────────────────────────────────────────
  console.log("── agents ──────────────────────────────────────────");
  await ensureCollection(db, "agents", agentSchema);
  await ensureIndexes(db, "agents", agentIndexes);

  // ── tickets ────────────────────────────────────────────────────────────
  console.log("\n── tickets ─────────────────────────────────────────");
  await ensureCollection(db, "tickets", ticketSchema);
  await ensureIndexes(db, "tickets", ticketIndexes);

  console.log("\n✅  Database initialisation complete.");
  console.log(`    Run 'npm run seed' to load sample data.\n`);
}

main().finally(closeDb);
