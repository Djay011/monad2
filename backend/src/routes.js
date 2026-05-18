import express from 'express';
import {
  recentMints,
  userMints,
  tokenStats,
  topHolders,
  balanceFor,
} from './db.js';
import {
  createListing,
  getListing,
  cancelListing,
  markListingSold,
  listActive,
  listingsBySeller,
  marketplaceStats,
  marketplaceActivity,
  listableBalance,
} from './marketplace.js';

export function createRoutes({ indexer, marketIndexer, broadcast }) {
  const router = express.Router();

  // Prevent browser / CDN caching of API responses so wallets always see fresh data
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });

  router.get('/health', (_req, res) => {
    res.json({ ok: true, ts: Math.floor(Date.now() / 1000) });
  });

  router.get('/sync-status', async (_req, res) => {
    try {
      const status = await indexer.getStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/marketplace/indexer-status', (_req, res) => {
    res.json(marketIndexer ? marketIndexer.status() : { running: false });
  });

  router.get('/recent-mints', (req, res) => {
    const limit = Number(req.query.limit || 50);
    res.json({ items: recentMints(limit) });
  });

  router.get('/balance/:address', (req, res) => {
    const addr = String(req.params.address || '');
    if (!/^0x[a-fA-F0-9]{40}$/i.test(addr)) {
      return res.status(400).json({ error: 'invalid address' });
    }
    const balances = balanceFor(addr);
    res.json({ address: addr.toLowerCase(), balances });
  });

  // Full wallet portfolio: balances + mint history in one call
  router.get('/wallet/:address/portfolio', (req, res) => {
    const addr = String(req.params.address || '');
    if (!/^0x[a-fA-F0-9]{40}$/i.test(addr)) {
      return res.status(400).json({ error: 'invalid address' });
    }
    const balances = balanceFor(addr);
    const mints = userMints(addr, 500, 0);
    res.json({ address: addr.toLowerCase(), balances, mints });
  });

  router.get('/token/:tick', (req, res) => {
    const tick = String(req.params.tick || '').toUpperCase();
    const stats = tokenStats(tick);
    res.json(stats);
  });

  router.get('/holders/:tick', (req, res) => {
    const tick = String(req.params.tick || '').toUpperCase();
    const limit = Number(req.query.limit || 100);
    res.json({ tick, holders: topHolders(tick, limit) });
  });

  router.get('/user/:address/mints', (req, res) => {
    const addr = String(req.params.address || '');
    if (!/^0x[a-fA-F0-9]{40}$/i.test(addr)) {
      return res.status(400).json({ error: 'invalid address' });
    }
    const limit = Number(req.query.limit || 100);
    const offset = Number(req.query.offset || 0);
    res.json({ items: userMints(addr, limit, offset) });
  });

  // ─── Marketplace ──────────────────────────────────────────────────────────
  router.get('/marketplace/listings', (req, res) => {
    const tick = String(req.query.tick || 'BOB').toUpperCase();
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    res.json({ items: listActive(tick, limit, offset) });
  });

  router.get('/marketplace/stats/:tick', (req, res) => {
    res.json(marketplaceStats(req.params.tick));
  });

  router.get('/marketplace/activity', (req, res) => {
    const tick = String(req.query.tick || 'BOB');
    const limit = Number(req.query.limit || 50);
    res.json({ items: marketplaceActivity(tick, limit) });
  });

  router.get('/marketplace/listable/:address/:tick', (req, res) => {
    const addr = String(req.params.address || '');
    if (!/^0x[a-fA-F0-9]{40}$/i.test(addr)) {
      return res.status(400).json({ error: 'invalid address' });
    }
    res.json(listableBalance(addr, req.params.tick));
  });

  router.get('/marketplace/seller/:address', (req, res) => {
    const addr = String(req.params.address || '');
    if (!/^0x[a-fA-F0-9]{40}$/i.test(addr)) {
      return res.status(400).json({ error: 'invalid address' });
    }
    res.json({ items: listingsBySeller(addr) });
  });

  router.post('/marketplace/listings', (req, res) => {
    try {
      const {
        seller, tick, amount, price_mon, signature,
        onchain_id, list_tx_hash,
      } = req.body || {};
      const row = createListing({
        seller, tick, amount, price_mon, signature,
        onchain_id, list_tx_hash,
      });
      res.json(row);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/marketplace/listings/:id/cancel', (req, res) => {
    const { seller } = req.body || {};
    if (!seller) return res.status(400).json({ error: 'seller required' });
    const ok = cancelListing(req.params.id, seller);
    if (!ok) return res.status(404).json({ error: 'listing not found or already inactive' });
    res.json({ ok: true });
  });

  router.post('/marketplace/listings/:id/buy', (req, res) => {
    const { buyer, tx_hash } = req.body || {};
    if (!/^0x[a-fA-F0-9]{40}$/i.test(buyer || '')) {
      return res.status(400).json({ error: 'invalid buyer' });
    }
    if (!/^0x[a-fA-F0-9]{64}$/i.test(tx_hash || '')) {
      return res.status(400).json({ error: 'invalid tx_hash' });
    }
    const listing = getListing(req.params.id);
    if (!listing) return res.status(404).json({ error: 'not found' });
    if (listing.status !== 'active') {
      return res.status(409).json({ error: `listing is ${listing.status}` });
    }
    markListingSold(req.params.id, buyer, tx_hash);
    const updated = getListing(req.params.id);

    // Broadcast balance change so all connected clients update in realtime
    if (broadcast && updated) {
      broadcast({
        type: 'balance_update',
        seller: updated.seller,
        buyer: buyer.toLowerCase(),
        tick: updated.tick,
        amount: updated.amount,
      });
    }

    res.json({ ok: true, listing: updated });
  });

  return router;
}
