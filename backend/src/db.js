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

  /* ── Admin dashboard tables ───────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS analytics_visits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    ip_hash     TEXT NOT NULL,
    path        TEXT NOT NULL,
    wallet      TEXT,
    user_agent  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_visits_ts      ON analytics_visits(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_visits_session ON analytics_visits(session_id);
  CREATE INDEX IF NOT EXISTS idx_visits_wallet  ON analytics_visits(wallet);

  CREATE TABLE IF NOT EXISTS feature_flags (
    key         TEXT PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 1,
    value       TEXT NOT NULL DEFAULT '',
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_by  TEXT
  );
`);

// Seed default feature flags (idempotent)
const DEFAULT_FLAGS = [
  { key: 'mint_enabled',         enabled: 1, value: '' },
  { key: 'marketplace_enabled',  enabled: 1, value: '' },
  { key: 'listing_enabled',      enabled: 1, value: '' },
  { key: 'maintenance_mode',     enabled: 0, value: 'We are performing scheduled maintenance. Please check back soon.' },
  { key: 'announcement',         enabled: 0, value: '' },
];
const seedFlag = db.prepare(`INSERT OR IGNORE INTO feature_flags (key, enabled, value) VALUES (?, ?, ?)`);
for (const f of DEFAULT_FLAGS) seedFlag.run(f.key, f.enabled, f.value);

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

/* ── Admin dashboard helpers ─────────────────────────────────────────── */

const adminStmts = {
  insertVisit: db.prepare(`
    INSERT INTO analytics_visits (ts, session_id, ip_hash, path, wallet, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  totalVisits: db.prepare(`SELECT COUNT(*) AS n FROM analytics_visits`),
  uniqueSessions: db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM analytics_visits`),
  uniqueIps: db.prepare(`SELECT COUNT(DISTINCT ip_hash) AS n FROM analytics_visits`),
  uniqueWallets: db.prepare(`SELECT COUNT(DISTINCT wallet) AS n FROM analytics_visits WHERE wallet IS NOT NULL AND wallet != ''`),
  onlineNow: db.prepare(`
    SELECT COUNT(DISTINCT session_id) AS n
    FROM analytics_visits
    WHERE ts >= ?
  `),
  todayVisits: db.prepare(`
    SELECT COUNT(*) AS n FROM analytics_visits WHERE ts >= ?
  `),
  byPath: db.prepare(`
    SELECT path, COUNT(*) AS visits, COUNT(DISTINCT session_id) AS uniques
    FROM analytics_visits
    WHERE ts >= ?
    GROUP BY path
    ORDER BY visits DESC
    LIMIT 20
  `),
  daily: db.prepare(`
    SELECT
      (ts / 86400) * 86400 AS day,
      COUNT(*) AS visits,
      COUNT(DISTINCT session_id) AS uniques
    FROM analytics_visits
    WHERE ts >= ?
    GROUP BY day
    ORDER BY day ASC
  `),
  recentVisits: db.prepare(`
    SELECT ts, session_id, path, wallet, user_agent
    FROM analytics_visits
    ORDER BY ts DESC
    LIMIT ?
  `),
  topWallets: db.prepare(`
    SELECT wallet, COUNT(*) AS visits, MAX(ts) AS last_seen
    FROM analytics_visits
    WHERE wallet IS NOT NULL AND wallet != ''
    GROUP BY wallet
    ORDER BY last_seen DESC
    LIMIT ?
  `),
  getAllFlags: db.prepare(`SELECT key, enabled, value, updated_at, updated_by FROM feature_flags`),
  upsertFlag: db.prepare(`
    INSERT INTO feature_flags (key, enabled, value, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      enabled    = excluded.enabled,
      value      = excluded.value,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `),
};

export function recordVisit({ sessionId, ipHash, path, wallet, userAgent }) {
  const ts = Math.floor(Date.now() / 1000);
  adminStmts.insertVisit.run(
    ts,
    String(sessionId || '').slice(0, 64),
    String(ipHash || '').slice(0, 64),
    String(path || '/').slice(0, 128),
    wallet ? String(wallet).toLowerCase() : null,
    String(userAgent || '').slice(0, 256),
  );
}

export function getAdminStats() {
  const now = Math.floor(Date.now() / 1000);
  const fiveMinAgo = now - 300;
  const todayStart = now - (now % 86400);
  const lastWeek   = now - 7 * 86400;
  const last30Days = now - 30 * 86400;

  return {
    totals: {
      visits:         adminStmts.totalVisits.get().n,
      sessions:       adminStmts.uniqueSessions.get().n,
      unique_ips:     adminStmts.uniqueIps.get().n,
      unique_wallets: adminStmts.uniqueWallets.get().n,
    },
    realtime: {
      online_now:   adminStmts.onlineNow.get(fiveMinAgo).n,
      today_visits: adminStmts.todayVisits.get(todayStart).n,
    },
    by_path:       adminStmts.byPath.all(lastWeek),
    daily:         adminStmts.daily.all(last30Days),
    recent_visits: adminStmts.recentVisits.all(50),
    top_wallets:   adminStmts.topWallets.all(20),
    ts: now,
  };
}

export function getAllFlags() {
  const rows = adminStmts.getAllFlags.all();
  const map = {};
  for (const r of rows) {
    map[r.key] = {
      enabled: Boolean(r.enabled),
      value: r.value || '',
      updated_at: r.updated_at,
      updated_by: r.updated_by,
    };
  }
  return map;
}

export function upsertFlag({ key, enabled, value, updatedBy }) {
  if (!key || typeof key !== 'string') throw new Error('flag key required');
  adminStmts.upsertFlag.run(
    key,
    enabled ? 1 : 0,
    String(value ?? ''),
    Math.floor(Date.now() / 1000),
    updatedBy ? String(updatedBy).toLowerCase() : null,
  );
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
