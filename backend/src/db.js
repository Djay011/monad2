import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Ensure directory exists
const dir = path.dirname(config.dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);

db.exec(`
  CREATE TABLE IF NOT EXISTS inscriptions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash       TEXT NOT NULL UNIQUE,
    block_number  INTEGER NOT NULL,
    timestamp     INTEGER NOT NULL,
    from_address  TEXT NOT NULL,
    to_address    TEXT NOT NULL,
    protocol      TEXT NOT NULL,
    operation     TEXT NOT NULL,
    tick          TEXT NOT NULL,
    amount        TEXT NOT NULL,
    raw_json      TEXT NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_inscriptions_tick ON inscriptions(tick);
  CREATE INDEX IF NOT EXISTS idx_inscriptions_from ON inscriptions(from_address);
  CREATE INDEX IF NOT EXISTS idx_inscriptions_block ON inscriptions(block_number);
  CREATE INDEX IF NOT EXISTS idx_inscriptions_op ON inscriptions(operation);
  CREATE INDEX IF NOT EXISTS idx_inscriptions_ts ON inscriptions(timestamp DESC);

  CREATE TABLE IF NOT EXISTS holders (
    address  TEXT NOT NULL,
    tick     TEXT NOT NULL,
    balance  TEXT NOT NULL DEFAULT '0',
    PRIMARY KEY (address, tick)
  );

  CREATE INDEX IF NOT EXISTS idx_holders_tick ON holders(tick);

  CREATE TABLE IF NOT EXISTS indexer_state (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
`);

// Prepared statements (node:sqlite uses positional `?` for run/get/all)
const stmts = {
  insertInscription: db.prepare(`
    INSERT OR IGNORE INTO inscriptions
      (tx_hash, block_number, timestamp, from_address, to_address,
       protocol, operation, tick, amount, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  upsertHolderAdd: db.prepare(`
    INSERT INTO holders (address, tick, balance)
    VALUES (?, ?, ?)
    ON CONFLICT(address, tick) DO UPDATE SET
      balance = CAST(CAST(balance AS INTEGER) + CAST(excluded.balance AS INTEGER) AS TEXT)
  `),
  getState: db.prepare(`SELECT value FROM indexer_state WHERE key = ?`),
  setState: db.prepare(`
    INSERT INTO indexer_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  recentMints: db.prepare(`
    SELECT tx_hash, block_number, timestamp, from_address, tick, amount
    FROM inscriptions
    WHERE operation = 'mint'
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `),
  userMints: db.prepare(`
    SELECT tx_hash, block_number, timestamp, from_address, tick, amount
    FROM inscriptions
    WHERE operation = 'mint' AND from_address = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT ? OFFSET ?
  `),
  tokenStats: db.prepare(`
    SELECT
      COUNT(*) AS mint_count,
      COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS total_minted
    FROM inscriptions
    WHERE operation = 'mint' AND tick = ?
  `),
  tokenHolderCount: db.prepare(`
    SELECT COUNT(*) AS holders FROM holders WHERE tick = ? AND CAST(balance AS INTEGER) > 0
  `),
  topHolders: db.prepare(`
    SELECT address, balance FROM holders
    WHERE tick = ? AND CAST(balance AS INTEGER) > 0
    ORDER BY CAST(balance AS INTEGER) DESC
    LIMIT ?
  `),
  balanceForAddress: db.prepare(`
    SELECT tick, balance FROM holders WHERE address = ? AND CAST(balance AS INTEGER) > 0
  `),
  balanceForAddressTick: db.prepare(`
    SELECT balance FROM holders WHERE address = ? AND tick = ?
  `),
  decrementHolder: db.prepare(`
    UPDATE holders SET balance = CAST(MAX(0, CAST(balance AS INTEGER) - ?) AS TEXT)
    WHERE address = ? AND tick = ?
  `),
  begin: db.prepare(`BEGIN`),
  commit: db.prepare(`COMMIT`),
  rollback: db.prepare(`ROLLBACK`),
};

export function getState(key) {
  const row = stmts.getState.get(key);
  return row ? row.value : null;
}

export function setState(key, value) {
  stmts.setState.run(key, String(value));
}

// Atomic apply of a parsed inscription event. Returns true if newly inserted.
export function applyInscription(evt) {
  stmts.begin.run();
  try {
    const result = stmts.insertInscription.run(
      evt.tx_hash, evt.block_number, evt.timestamp,
      evt.from_address, evt.to_address,
      evt.protocol, evt.operation, evt.tick, evt.amount, evt.raw_json,
    );
    if (result.changes === 0) {
      stmts.commit.run();
      return false;
    }
    if (evt.operation === 'mint') {
      stmts.upsertHolderAdd.run(evt.from_address, evt.tick, evt.amount);
    }
    stmts.commit.run();
    return true;
  } catch (err) {
    try { stmts.rollback.run(); } catch {}
    throw err;
  }
}

export function recentMints(limit = 50) {
  return stmts.recentMints.all(Math.min(Math.max(1, Number(limit) || 50), 500));
}

export function userMints(address, limit = 100, offset = 0) {
  return stmts.userMints.all(
    address.toLowerCase(),
    Math.min(Number(limit) || 100, 500),
    Number(offset) || 0,
  );
}

export function tokenStats(tick) {
  const stats = stmts.tokenStats.get(tick);
  const holders = stmts.tokenHolderCount.get(tick);
  return {
    tick,
    mint_count: stats.mint_count,
    total_minted: String(stats.total_minted),
    holders: holders.holders,
  };
}

export function topHolders(tick, limit = 100) {
  return stmts.topHolders.all(tick, Math.min(Number(limit) || 100, 500));
}

export function balanceFor(address) {
  return stmts.balanceForAddress.all(address.toLowerCase());
}

export function balanceForTick(address, tick) {
  const row = stmts.balanceForAddressTick.get(address.toLowerCase(), tick.toUpperCase());
  return row ? Number(row.balance) : 0;
}

/**
 * Transfer inscription balance from one holder to another.
 * Used by marketplace sales to keep the holders table in sync.
 */
export function transferBalance(from, to, tick, amount) {
  const tickUpper = tick.toUpperCase();
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const amt = Number(amount);
  if (amt <= 0) return;

  stmts.begin.run();
  try {
    stmts.decrementHolder.run(amt, fromLower, tickUpper);
    stmts.upsertHolderAdd.run(toLower, tickUpper, String(amt));
    stmts.commit.run();
  } catch (err) {
    try { stmts.rollback.run(); } catch {}
    throw err;
  }
}
