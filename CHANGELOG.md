# Changelog

## [Unreleased] — 2026-05-18

### Added
- **Animated WebGL shader background** on the home page (`src/components/ShaderBackground.jsx`)
  - DPR-capped, pauses on tab hide, full RAF teardown on unmount
  - Mounted only on the `about` tab so it never runs on Mint / Marketplace / My Inscriptions
- **`localStorage` portfolio cache** (`src/App.jsx`)
  - `mon20_total_minted_<TICK>` persists global supply across refreshes
  - `mon20_recent_activity_<TICK>` persists the live mint feed
  - `mon20_balance_<address>_<TICK>` persists per-wallet balance — eliminates the 0-flash on reload while the indexer responds
  - All caches converge upward only (`Math.max`) so backend truth never ratchets the UI backwards

### Changed
- **Marketplace layout** is now full-width
  - `.mp` no longer capped at 1680px; uses `align-self: stretch` and `clamp(20px, 2.5vw, 44px)` padding
  - Filter sidebar removed; listings grid spans the full viewport
  - Card grid scales: 220px min ≥default, 232px ≥1400px, 248px ≥1800px
- **Listing modal** no longer falsely blocks freshly-minted users
  - Frontend treats `owned === 0` as "indexer still syncing" rather than a hard block
  - Backend `createListing` no longer re-validates off-chain holders balance when an `onchain_id + list_tx_hash` are supplied — the on-chain `Listed` event is the source of truth

### Fixed
- Refresh no longer resets balances, mint history, or progress bar to 0 while the indexer catches up
- Marketplace listing flow now succeeds within seconds of a confirmed mint instead of requiring a wait for the next indexer poll cycle

### Architecture (already in place — documented for clarity)
- Backend indexer (`backend/src/indexer.js`) polls Monad RPC every 4s, parses `mon-20` inscription txs, persists to SQLite (`backend/data/inscriptions.db`, WAL mode)
- Marketplace event indexer (`backend/src/marketIndexer.js`) listens to `Listed` / `Sold` / `Cancelled` logs from the marketplace contract
- WebSocket realtime push (`backend/src/index.js`) broadcasts new mints + market events to all connected clients
- Frontend WS subscriber (`src/api.js`) auto-reconnects and merges live events into UI state
- All ownership data is read from indexed blockchain events — no mock or temporary state remains
