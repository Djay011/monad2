// Thin API client + WebSocket helper for the indexer backend.

const RAW_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';
export const API_BASE = RAW_BASE.replace(/\/+$/, '');

async function request(path, options = {}) {
  // Cache-busting: append timestamp to prevent stale browser/CDN caches
  const separator = path.includes('?') ? '&' : '?';
  const url = `${API_BASE}${path}${separator}_t=${Date.now()}`;
  const res = await fetch(url, {
    ...options,
    cache: 'no-store',
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch {}
    throw new Error(detail || `API ${path} failed: ${res.status}`);
  }
  return res.json();
}

const post = (path, body) => request(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

export const api = {
  health: () => request('/api/health'),
  syncStatus: () => request('/api/sync-status'),
  recentMints: (limit = 50) => request(`/api/recent-mints?limit=${limit}`),
  balance: (address) => request(`/api/balance/${address}`),
  token: (tick) => request(`/api/token/${tick}`),
  holders: (tick, limit = 100) => request(`/api/holders/${tick}?limit=${limit}`),
  userMints: (address, limit = 100, offset = 0) =>
    request(`/api/user/${address}/mints?limit=${limit}&offset=${offset}`),

  // Full wallet portfolio: balances + mint history in one call
  walletPortfolio: (address) => request(`/api/wallet/${address}/portfolio`),

  // Marketplace
  listings: (tick = 'BOB', limit = 50, offset = 0) =>
    request(`/api/marketplace/listings?tick=${tick}&limit=${limit}&offset=${offset}`),
  marketStats: (tick = 'BOB') => request(`/api/marketplace/stats/${tick}`),
  marketActivity: (tick = 'BOB', limit = 50) =>
    request(`/api/marketplace/activity?tick=${tick}&limit=${limit}`),
  sellerListings: (address) => request(`/api/marketplace/seller/${address}`),
  listableBalance: (address, tick) =>
    request(`/api/marketplace/listable/${address}/${tick}`),
  createListing: (payload) => post('/api/marketplace/listings', payload),
  cancelListing: (id, seller) => post(`/api/marketplace/listings/${id}/cancel`, { seller }),
  confirmBuy: (id, buyer, tx_hash) =>
    post(`/api/marketplace/listings/${id}/buy`, { buyer, tx_hash }),

  // ── Admin / analytics ───────────────────────────────────────────────
  trackVisit: (payload) => post('/api/track', payload),
  flags: () => request('/api/flags'),
  adminStats: () => request('/api/admin/stats'),
  adminWallets: () => request('/api/admin/wallets'),
  setFlag: (payload) => post('/api/admin/flags', payload),
};

/**
 * Subscribe to ALL live events via WebSocket (inscriptions + marketplace + balance).
 * Accepts a handlers object with optional callbacks:
 *   onMints(items)        — new inscription events
 *   onBalanceUpdate(data) — seller/buyer balance changed (marketplace sale)
 *   onMarketEvent(data)   — listing/sale/cancel events
 *
 * Falls back gracefully if WS is unsupported. Returns an unsubscribe fn.
 */
export function subscribeEvents(handlers = {}) {
  if (typeof WebSocket === 'undefined') return () => {};
  const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws';
  let ws;
  let closed = false;
  let reconnectTimer;

  const connect = () => {
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return;
    }
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (!msg || !msg.type) return;

        switch (msg.type) {
          case 'new_inscriptions':
            handlers.onMints?.(msg.items || []);
            break;
          case 'balance_update':
            handlers.onBalanceUpdate?.(msg);
            break;
          case 'market_listed':
          case 'market_sold':
          case 'market_cancelled':
            handlers.onMarketEvent?.(msg);
            break;
          case 'flags_updated':
            handlers.onFlagsUpdated?.(msg.flags || {});
            break;
        }
      } catch {}
    };
    ws.onclose = () => {
      if (closed) return;
      reconnectTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  };

  connect();
  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) try { ws.close(); } catch {}
  };
}

/**
 * Legacy subscribe — kept for backward compat, wraps subscribeEvents.
 */
export function subscribeMints(onEvent) {
  return subscribeEvents({ onMints: onEvent });
}

// Map a backend inscription row to the shape the UI expects.
export function rowToActivity(row) {
  return {
    hash: row.tx_hash,
    from: row.from_address,
    amount: Number(row.amount) || 0,
    block: row.block_number,
    timestamp: row.timestamp,
    time: new Date(row.timestamp * 1000).toLocaleString(),
    tick: row.tick,
  };
}
