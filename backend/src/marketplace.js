import { db, balanceFor, transferBalance } from './db.js';

// Schema
// Base table (columns added later are applied via the migration step below)
db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    seller       TEXT NOT NULL,
    tick         TEXT NOT NULL,
    amount       TEXT NOT NULL,
    price_mon    TEXT NOT NULL,
    unit_price   REAL NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active',
    buyer        TEXT,
    buy_tx_hash  TEXT,
    signature    TEXT,
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
`);

// Lightweight migration — additive, idempotent
const cols = db.prepare(`PRAGMA table_info(listings)`).all().map(c => c.name);
if (!cols.includes('onchain_id')) {
  db.exec(`ALTER TABLE listings ADD COLUMN onchain_id INTEGER`);
}
if (!cols.includes('list_tx_hash')) {
  db.exec(`ALTER TABLE listings ADD COLUMN list_tx_hash TEXT`);
}

// Indexes (after migration so onchain_id column exists)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
  CREATE INDEX IF NOT EXISTS idx_listings_tick ON listings(tick);
  CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller);
  CREATE INDEX IF NOT EXISTS idx_listings_unit_price ON listings(unit_price);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_onchain_unique ON listings(onchain_id);
`);

const stmts = {
  insert: db.prepare(`
    INSERT INTO listings (seller, tick, amount, price_mon, unit_price, signature, onchain_id, list_tx_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  byId: db.prepare(`SELECT * FROM listings WHERE id = ?`),
  byOnchainId: db.prepare(`SELECT * FROM listings WHERE onchain_id = ?`),
  cancel: db.prepare(`
    UPDATE listings SET status = 'cancelled', updated_at = strftime('%s','now')
    WHERE id = ? AND status = 'active' AND seller = ?
  `),
  markSold: db.prepare(`
    UPDATE listings
    SET status = 'sold', buyer = ?, buy_tx_hash = ?, updated_at = strftime('%s','now')
    WHERE id = ? AND status = 'active'
  `),
  active: db.prepare(`
    SELECT * FROM listings
    WHERE status = 'active' AND tick = ?
    ORDER BY unit_price ASC, created_at DESC
    LIMIT ? OFFSET ?
  `),
  bySeller: db.prepare(`
    SELECT * FROM listings WHERE seller = ?
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `),
  stats: db.prepare(`
    SELECT
      COUNT(*) AS active_count,
      COALESCE(MIN(unit_price), 0) AS floor_unit_price,
      COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS active_supply
    FROM listings
    WHERE tick = ? AND status = 'active'
  `),
  volume: db.prepare(`
    SELECT
      COUNT(*) AS sales_count,
      COALESCE(SUM(CAST(price_mon AS REAL)), 0) AS volume_mon
    FROM listings
    WHERE tick = ? AND status = 'sold'
  `),
  activeLockedForSeller: db.prepare(`
    SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS locked
    FROM listings
    WHERE seller = ? AND tick = ? AND status = 'active'
  `),
  insertFromEvent: db.prepare(`
    INSERT INTO listings (onchain_id, list_tx_hash, seller, tick, amount, price_mon, unit_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `),
  cancelByOnchain: db.prepare(`
    UPDATE listings
    SET status = 'cancelled', updated_at = strftime('%s','now')
    WHERE onchain_id = ? AND status = 'active'
  `),
  soldByOnchain: db.prepare(`
    UPDATE listings
    SET status = 'sold', buyer = ?, buy_tx_hash = ?, updated_at = strftime('%s','now')
    WHERE onchain_id = ? AND status = 'active'
  `),
};

/**
 * Idempotent upsert called by the on-chain event indexer when a `Listed`
 * event is observed. Skips silently if the onchain_id is already known.
 */
export function upsertListingFromEvent({
  onchain_id, list_tx_hash, seller, tick, amount, price_wei,
}) {
  if (onchain_id == null) throw new Error('upsert: onchain_id required');
  const existing = stmts.byOnchainId.get(Number(onchain_id));
  if (existing) return existing;

  const priceMon = Number(price_wei) / 1e18;
  const amt = Number(amount);
  const unit = amt > 0 ? priceMon / amt : 0;

  stmts.insertFromEvent.run(
    Number(onchain_id),
    list_tx_hash,
    String(seller).toLowerCase(),
    String(tick).toUpperCase(),
    String(amount),
    String(priceMon),
    unit,
  );
  return stmts.byOnchainId.get(Number(onchain_id));
}

export function cancelListingByOnchainId(onchain_id) {
  return stmts.cancelByOnchain.run(Number(onchain_id)).changes > 0;
}

export function markListingSoldByOnchainId(onchain_id, buyer, tx_hash) {
  const listing = stmts.byOnchainId.get(Number(onchain_id));
  const changed = stmts.soldByOnchain.run(
    String(buyer).toLowerCase(),
    String(tx_hash),
    Number(onchain_id),
  ).changes > 0;
  if (changed && listing) {
    try {
      transferBalance(listing.seller, buyer, listing.tick, listing.amount);
    } catch (err) {
      console.error('[marketplace] balance transfer failed (onchain sale):', err);
    }
  }
  return changed;
}

/**
 * Get the seller's on-chain balance for a tick (from holders table).
 * Returns 0 if the seller has never minted / received the tick.
 */
function ownedBalance(seller, tick) {
  const rows = balanceFor(seller);
  const row = rows.find(r => r.tick === tick);
  return row ? Number(row.balance) : 0;
}

/** Amount already committed to active listings by this seller for this tick. */
function lockedForActiveListings(seller, tick) {
  const r = stmts.activeLockedForSeller.get(seller.toLowerCase(), tick.toUpperCase());
  return Number(r?.locked ?? 0);
}

export function createListing({ seller, tick, amount, price_mon, signature, onchain_id, list_tx_hash }) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(seller)) throw new Error('invalid seller');
  if (!tick || typeof tick !== 'string') throw new Error('invalid tick');
  if (!/^\d+$/.test(String(amount))) throw new Error('amount must be a positive integer');
  const price = Number(price_mon);
  if (!isFinite(price) || price <= 0) throw new Error('price_mon must be > 0');
  const amt = Number(amount);
  if (amt <= 0) throw new Error('amount must be > 0');
  if (onchain_id != null && !Number.isInteger(Number(onchain_id))) {
    throw new Error('invalid onchain_id');
  }
  if (list_tx_hash && !/^0x[a-fA-F0-9]{64}$/.test(list_tx_hash)) {
    throw new Error('invalid list_tx_hash');
  }

  // Strict on-chain-only marketplace: every listing must reference an
  // on-chain `Listed` event id and the tx hash that emitted it.
  if (onchain_id == null || !list_tx_hash) {
    throw new Error('on-chain listing required (onchain_id + list_tx_hash)');
  }

  // De-dupe: if a row with this onchain_id already exists, return it.
  const existing = stmts.byOnchainId.get(Number(onchain_id));
  if (existing) return existing;

  // NOTE: We intentionally do NOT re-validate the seller's off-chain holders
  // balance here. The presence of `onchain_id + list_tx_hash` means the
  // marketplace contract already accepted the listing on-chain, which is the
  // source of truth. The local `holders` table is only an indexer mirror and
  // can lag behind a freshly-confirmed mint by a poll cycle, which would
  // otherwise spuriously reject a perfectly valid listing.

  const unit = price / amt;
  const result = stmts.insert.run(
    seller.toLowerCase(), tick.toUpperCase(), String(amount),
    String(price_mon), unit, signature || null,
    onchain_id != null ? Number(onchain_id) : null,
    list_tx_hash || null,
  );
  return stmts.byId.get(result.lastInsertRowid);
}

export function getListing(id) {
  return stmts.byId.get(Number(id));
}

export function cancelListing(id, seller) {
  const r = stmts.cancel.run(Number(id), seller.toLowerCase());
  return r.changes > 0;
}

export function markListingSold(id, buyer, tx_hash) {
  const listing = stmts.byId.get(Number(id));
  if (!listing || listing.status !== 'active') return false;
  const r = stmts.markSold.run(buyer.toLowerCase(), tx_hash, Number(id));
  if (r.changes > 0) {
    try {
      transferBalance(listing.seller, buyer, listing.tick, listing.amount);
    } catch (err) {
      console.error('[marketplace] balance transfer failed (api sale):', err);
    }
    return true;
  }
  return false;
}

export function listActive(tick, limit = 50, offset = 0) {
  return stmts.active.all(
    tick.toUpperCase(),
    Math.min(Number(limit) || 50, 200),
    Number(offset) || 0,
  );
}

export function listingsBySeller(seller, limit = 50, offset = 0) {
  return stmts.bySeller.all(
    seller.toLowerCase(),
    Math.min(Number(limit) || 50, 200),
    Number(offset) || 0,
  );
}

export function listableBalance(seller, tick) {
  const owned = ownedBalance(seller.toLowerCase(), tick.toUpperCase());
  const locked = lockedForActiveListings(seller, tick);
  return {
    tick: tick.toUpperCase(),
    owned,
    locked,
    available: Math.max(0, owned - locked),
  };
}

const stmtActivity = db.prepare(`
  SELECT id, onchain_id, seller, buyer, tick, amount, price_mon, unit_price,
         status, list_tx_hash, buy_tx_hash, created_at, updated_at
  FROM listings
  WHERE tick = ?
  ORDER BY MAX(created_at, updated_at) DESC
  LIMIT ?
`);

/**
 * Unified activity feed for a tick: every listing emits a `list` event at
 * created_at, plus a `sold` or `cancelled` event at updated_at when applicable.
 * Sorted newest-first.
 */
export function marketplaceActivity(tick, limit = 50) {
  const cap = Math.min(Number(limit) || 50, 200);
  const rows = stmtActivity.all(String(tick).toUpperCase(), cap);
  const events = [];
  for (const r of rows) {
    events.push({
      kind: 'list', ts: r.created_at, listing_id: r.id, onchain_id: r.onchain_id,
      tick: r.tick, amount: r.amount, price_mon: r.price_mon, unit_price: r.unit_price,
      from: r.seller, to: null, tx_hash: r.list_tx_hash,
    });
    if (r.status === 'sold') {
      events.push({
        kind: 'sold', ts: r.updated_at, listing_id: r.id, onchain_id: r.onchain_id,
        tick: r.tick, amount: r.amount, price_mon: r.price_mon, unit_price: r.unit_price,
        from: r.seller, to: r.buyer, tx_hash: r.buy_tx_hash,
      });
    } else if (r.status === 'cancelled') {
      events.push({
        kind: 'cancelled', ts: r.updated_at, listing_id: r.id, onchain_id: r.onchain_id,
        tick: r.tick, amount: r.amount, price_mon: r.price_mon, unit_price: r.unit_price,
        from: r.seller, to: null, tx_hash: null,
      });
    }
  }
  events.sort((a, b) => b.ts - a.ts);
  return events.slice(0, cap);
}

export function marketplaceStats(tick) {
  const t = tick.toUpperCase();
  const a = stmts.stats.get(t);
  const v = stmts.volume.get(t);
  return {
    tick: t,
    active_listings: a.active_count,
    floor_unit_price: a.floor_unit_price,
    active_supply: String(a.active_supply),
    sales_count: v.sales_count,
    volume_mon: v.volume_mon,
  };
}
