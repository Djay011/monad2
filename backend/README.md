# Monad Inscriptions Indexer + API

Production-ready Node.js backend that:

- Continuously scans Monad blocks for inscription transactions
- Parses `mon-20` JSON inscriptions from tx calldata
- Persists everything to a database (SQLite by default; portable schema)
- Exposes a REST API and WebSocket for the frontend
- Recomputes balances and supply purely from on-chain data
- Survives restarts; resumes from `last_indexed_block`

## Architecture

```
backend/
├── src/
│   ├── index.js     # Express + WebSocket entry
│   ├── config.js    # env loader
│   ├── db.js        # SQLite + schema + prepared statements
│   ├── parser.js    # inscription JSON parser (mon-20)
│   ├── indexer.js   # block scanner / poller
│   └── routes.js    # REST endpoints
└── data/
    └── inscriptions.db  # auto-created
```

## Run

```bash
cd backend
cp .env.example .env       # edit RECEIVER_WALLET if needed
npm install
npm run dev                # auto-reload
# or
npm start
```

Server starts on `http://localhost:4000`.

## Inscription protocol parsed

```json
{ "p": "mon-20", "op": "mint", "tick": "BOB", "amt": "1000" }
```

The indexer accepts `op` of `deploy`, `mint`, or `transfer`. Calldata is parsed
when prefixed with `data:application/json,` or `data:application/json;utf8,`.

## REST API

| Method | Path                          | Description                            |
| ------ | ----------------------------- | -------------------------------------- |
| GET    | `/api/health`                 | Liveness probe                          |
| GET    | `/api/sync-status`            | Indexer head, chain tip, blocks behind  |
| GET    | `/api/recent-mints?limit=50`  | Latest mint events                      |
| GET    | `/api/balance/:address`       | All token balances for an address       |
| GET    | `/api/token/:tick`            | Total minted / mint count / holders     |
| GET    | `/api/holders/:tick?limit=100`| Top holders of a tick                   |
| GET    | `/api/user/:address/mints`    | Mint history for an address             |

## WebSocket

Connect to `ws://localhost:4000/ws`. Messages:

```json
{ "type": "hello", "ts": 1715000000 }
{ "type": "new_inscriptions", "items": [ /* inscription rows */ ] }
```

## Database schema

`inscriptions` table stores every inscription event with a unique constraint on
`tx_hash` so re-indexing is idempotent. `holders` keeps running balances per
`(address, tick)`. `indexer_state` persists `last_indexed_block`.

## Resync

Stop the server and either:

- Set `START_BLOCK` in `.env` to a specific block and delete the row in
  `indexer_state` (or just delete `data/inscriptions.db`).
- Or update `last_indexed_block` directly via SQLite CLI to force a re-scan
  of an earlier range. Inserts are idempotent (`INSERT OR IGNORE`).

## Migrating to PostgreSQL

The schema uses ANSI SQL primitives. To swap:

1. Replace `better-sqlite3` with `pg` and use `node-postgres` prepared queries.
2. Convert `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`.
3. Convert `INSERT OR IGNORE` → `INSERT ... ON CONFLICT (tx_hash) DO NOTHING`.
4. The `applyInscription` transaction wrapper translates 1:1 to `BEGIN/COMMIT`.

## Production notes

- Run behind a reverse proxy (nginx / Caddy) with TLS.
- Use a dedicated RPC provider for higher throughput.
- Increase `MAX_BLOCKS_PER_PASS` only if your RPC tolerates batch loads.
- Monitor `/api/sync-status.blocks_behind`; alert if it grows.
