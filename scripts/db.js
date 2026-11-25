/**
 * scripts/db.js
 *
 * Shared database connection helper.
 * All scripts import { getDb, closeDb } from this module.
 */

"use strict";

const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017";
const DB_NAME   = process.env.DB_NAME   || "customer_support";

let _client = null;

/**
 * Returns an authenticated Db instance (opens the connection once).
 */
async function getDb() {
  if (!_client) {
    _client = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 5000, // fail fast if Mongo is not running
    });
    await _client.connect();
  }
  return _client.db(DB_NAME);
}

/**
 * Cleanly closes the shared connection.
 */
async function closeDb() {
  if (_client) {
    await _client.close();
    _client = null;
  }
}

module.exports = { getDb, closeDb, DB_NAME };
