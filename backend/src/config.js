import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 4000),
  corsOrigin: process.env.CORS_ORIGIN || '*',

  rpcUrl: process.env.RPC_URL || 'https://rpc.monad.xyz',
  chainId: Number(process.env.CHAIN_ID || 143),

  receiverWallet: (process.env.RECEIVER_WALLET || '').toLowerCase(),

  startBlock: Number(process.env.START_BLOCK || 0),
  initialLookback: Number(process.env.INITIAL_LOOKBACK || 2000),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 4000),
  batchSize: Number(process.env.BATCH_SIZE || 8),
  maxBlocksPerPass: Number(process.env.MAX_BLOCKS_PER_PASS || 80),
  batchDelayMs: Number(process.env.BATCH_DELAY_MS || 400),

  dbPath: process.env.DB_PATH || './data/inscriptions.db',

  // Marketplace contract event indexer
  marketAddress: (process.env.MARKET_CONTRACT || '0xA8a17eBB904FA125c9745Ca8762c208E75058363'),
  marketStartBlock: Number(process.env.MARKET_START_BLOCK || 0), // 0 = use deploy block discovery, or fall back to head - lookback
  marketLookback: Number(process.env.MARKET_LOOKBACK || 1500),
  marketPollIntervalMs: Number(process.env.MARKET_POLL_INTERVAL_MS || 6000),
  marketLogRange: Number(process.env.MARKET_LOG_RANGE || 100),
  marketBatchDelayMs: Number(process.env.MARKET_BATCH_DELAY_MS || 250),

  // Admin dashboard — comma-separated list of allowed wallet addresses (lowercased)
  adminWallets: (process.env.ADMIN_WALLETS || '0x6fC09727F83Ef23782cF80Cd11e1bda534532267')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
};

if (!config.receiverWallet || !config.receiverWallet.startsWith('0x')) {
  throw new Error('RECEIVER_WALLET env is required and must be a 0x address');
}
