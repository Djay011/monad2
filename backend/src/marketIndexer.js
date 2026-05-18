import { ethers } from 'ethers';
import { config } from './config.js';
import { db } from './db.js';
import {
  upsertListingFromEvent,
  cancelListingByOnchainId,
  markListingSoldByOnchainId,
} from './marketplace.js';

// ABI matching contracts/MonadInscriptionMarket.sol — events only is enough
// for the indexer.
const MARKET_ABI = [
  'event Listed(uint256 indexed id, address indexed seller, bytes32 indexed tick, uint256 amount, uint96 priceWei)',
  'event Sold(uint256 indexed id, address indexed buyer, address indexed seller, bytes32 tick, uint256 amount, uint96 priceWei, uint256 feePaid)',
  'event Cancelled(uint256 indexed id, address indexed seller)',
];

const STATE_KEY = 'market_last_block';

const getState = db.prepare('SELECT value FROM indexer_state WHERE key = ?');
const setState = db.prepare(`
  INSERT INTO indexer_state (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function readLastBlock() {
  const row = getState.get(STATE_KEY);
  return row ? Number(row.value) : null;
}
function writeLastBlock(n) {
  setState.run(STATE_KEY, String(n));
}

/**
 * Polls the deployed MonadInscriptionMarket contract for Listed/Sold/Cancelled
 * events and mirrors them into the local DB. Idempotent: re-running over the
 * same range never produces duplicates because rows are keyed by `onchain_id`.
 */
export default class MarketIndexer {
  constructor({ broadcast } = {}) {
    this.broadcast = broadcast || (() => {});
    this.running = false;
    this.timer = null;
    this.lastBlock = readLastBlock();
    this.address = config.marketAddress;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId, {
      staticNetwork: true,
    });
    this.iface = new ethers.Interface(MARKET_ABI);
    this.contract = new ethers.Contract(this.address, MARKET_ABI, this.provider);
  }

  async start() {
    if (!this.address || !/^0x[a-fA-F0-9]{40}$/.test(this.address)) {
      console.warn('[market-indexer] disabled: MARKET_CONTRACT not configured');
      return;
    }
    if (this.running) return;
    this.running = true;
    console.log(`[market-indexer] started for ${this.address}`);

    if (this.lastBlock == null) {
      const head = await this.provider.getBlockNumber();
      this.lastBlock = Math.max(0, head - config.marketLookback);
      writeLastBlock(this.lastBlock);
      console.log(`[market-indexer] cold start at block ${this.lastBlock} (head ${head})`);
    }

    const tick = async () => {
      if (!this.running) return;
      try {
        await this.scan();
      } catch (e) {
        console.error('[market-indexer] scan error:', e?.shortMessage || e?.message || e);
      } finally {
        if (this.running) {
          this.timer = setTimeout(tick, config.marketPollIntervalMs);
        }
      }
    };
    tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async scan() {
    const head = await this.provider.getBlockNumber();
    if (this.lastBlock >= head) return;

    let range = config.marketLogRange;
    let from = this.lastBlock + 1;
    while (from <= head && this.running) {
      const to = Math.min(from + range - 1, head);
      let logs;
      try {
        logs = await this.provider.getLogs({
          address: this.address,
          fromBlock: from,
          toBlock: to,
        });
      } catch (e) {
        const msg = String(e?.shortMessage || e?.message || e);
        // Common RPC-side limits — shrink the window and retry without losing progress
        if (/413|too large|exceed|range|limit/i.test(msg) && range > 5) {
          range = Math.max(5, Math.floor(range / 2));
          console.warn(`[market-indexer] shrinking range to ${range} (${msg})`);
          continue;
        }
        throw e;
      }

      for (const log of logs) {
        try {
          await this.handleLog(log);
        } catch (e) {
          console.error('[market-indexer] log handler error:', e?.message || e);
        }
      }

      this.lastBlock = to;
      writeLastBlock(to);
      from = to + 1;
      if (config.marketBatchDelayMs > 0 && from <= head) {
        await new Promise((r) => setTimeout(r, config.marketBatchDelayMs));
      }
    }
  }

  async handleLog(log) {
    let parsed;
    try {
      parsed = this.iface.parseLog({ topics: log.topics, data: log.data });
    } catch {
      return; // not one of ours
    }
    const txHash = log.transactionHash;

    if (parsed.name === 'Listed') {
      const { id, seller, tick, amount, priceWei } = parsed.args;
      const tickStr = ethers.decodeBytes32String(tick);
      const row = upsertListingFromEvent({
        onchain_id: Number(id),
        list_tx_hash: txHash,
        seller,
        tick: tickStr,
        amount: amount.toString(),
        price_wei: priceWei.toString(),
      });
      console.log(
        `[market-indexer] Listed #${id} ${tickStr} ${amount} @ ${ethers.formatEther(priceWei)} MON by ${seller}`
      );
      this.broadcast({ type: 'market_listed', listing: row });
    } else if (parsed.name === 'Sold') {
      const { id, buyer } = parsed.args;
      markListingSoldByOnchainId(Number(id), buyer, txHash);
      console.log(`[market-indexer] Sold #${id} -> ${buyer}`);
      this.broadcast({ type: 'market_sold', onchain_id: Number(id), buyer, tx_hash: txHash });
    } else if (parsed.name === 'Cancelled') {
      const { id } = parsed.args;
      cancelListingByOnchainId(Number(id));
      console.log(`[market-indexer] Cancelled #${id}`);
      this.broadcast({ type: 'market_cancelled', onchain_id: Number(id) });
    }
  }

  status() {
    return {
      address: this.address,
      running: this.running,
      lastBlock: this.lastBlock,
    };
  }
}
