import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { createRoutes } from './routes.js';
import Indexer from './indexer.js';
import MarketIndexer from './marketIndexer.js';

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const broadcast = (payload) => {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try { client.send(msg); } catch {}
    }
  }
};

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', ts: Math.floor(Date.now() / 1000) }));
});

const indexer = new Indexer({
  onNewInscriptions: (events) => {
    broadcast({ type: 'new_inscriptions', items: events });
  },
});

const marketIndexer = new MarketIndexer({ broadcast });

app.use('/api', createRoutes({ indexer, marketIndexer, broadcast }));

app.use((err, _req, res, _next) => {
  console.error('[api] error:', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

server.listen(config.port, () => {
  console.log(`[api] listening on :${config.port}`);
  indexer.start().catch((e) => {
    console.error('[indexer] failed to start:', e);
    process.exit(1);
  });
  marketIndexer.start().catch((e) => {
    console.error('[market-indexer] failed to start:', e);
  });
});

const shutdown = () => {
  console.log('\n[server] shutting down…');
  indexer.stop();
  marketIndexer.stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
