import { ethers } from 'ethers';
import { config } from './config.js';
import { applyInscription, getState, setState } from './db.js';
import { parseInscription } from './parser.js';

const STATE_KEY = 'last_indexed_block';

class Indexer {
  constructor({ onNewInscriptions } = {}) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl, {
      chainId: config.chainId,
      name: 'monad',
    });
    this.onNewInscriptions = onNewInscriptions || (() => {});
    this.running = false;
    this.timer = null;
  }

  async start() {
    if (this.running) return;
    this.running = true;

    // Bootstrap last_indexed_block if absent
    let last = Number(getState(STATE_KEY));
    if (!Number.isFinite(last) || last <= 0) {
      const tip = await this.provider.getBlockNumber();
      const seed = config.startBlock > 0
        ? config.startBlock - 1
        : Math.max(0, tip - config.initialLookback - 1);
      setState(STATE_KEY, seed);
      console.log(`[indexer] seeded last_indexed_block=${seed} (tip=${tip})`);
    }

    console.log(`[indexer] started, polling every ${config.pollIntervalMs}ms`);
    this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  async tick() {
    if (!this.running) return;
    try {
      await this.runOnce();
    } catch (err) {
      console.error('[indexer] tick error:', err.message);
    } finally {
      if (this.running) {
        this.timer = setTimeout(() => this.tick(), config.pollIntervalMs);
      }
    }
  }

  // Fetch a single block with simple exponential backoff retry on rate-limit
  async fetchBlockWithRetry(num, attempts = 4) {
    let delay = 500;
    for (let i = 0; i < attempts; i++) {
      try {
        const block = await this.provider.getBlock(num, true);
        if (block) return block;
      } catch (err) {
        const msg = String(err && err.message || '');
        const rateLimited = msg.includes('limit reached') || msg.includes('-32007') || msg.includes('429');
        if (i === attempts - 1) {
          console.warn(`[indexer] block ${num} failed: ${msg.slice(0, 120)}`);
          return null;
        }
        await new Promise(r => setTimeout(r, rateLimited ? delay * 2 : delay));
        delay = Math.min(delay * 2, 4000);
      }
    }
    return null;
  }

  async runOnce() {
    const tip = await this.provider.getBlockNumber();
    const last = Number(getState(STATE_KEY));
    let from = last + 1;
    if (from > tip) return;

    const to = Math.min(tip, from + config.maxBlocksPerPass - 1);
    const newEvents = [];
    let lastSuccessfulBlock = last;

    for (let start = from; start <= to; start += config.batchSize) {
      const end = Math.min(start + config.batchSize - 1, to);
      const promises = [];
      for (let b = start; b <= end; b++) {
        promises.push(this.fetchBlockWithRetry(b));
      }
      const blocks = await Promise.all(promises);

      // Process only contiguous successful blocks; stop at first hole so we
      // don't advance the cursor past an unfetched block.
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const blockNum = start + i;
        if (!block) {
          // Persist progress up to lastSuccessfulBlock and bail this pass
          if (lastSuccessfulBlock > last) setState(STATE_KEY, lastSuccessfulBlock);
          if (newEvents.length > 0) this.onNewInscriptions(newEvents);
          throw new Error(`block ${blockNum} unavailable; will retry next pass`);
        }
        const txs = block.prefetchedTransactions || [];
        for (const tx of txs) {
          if (!tx || !tx.to) continue;
          if (tx.to.toLowerCase() !== config.receiverWallet) continue;
          const evt = parseInscription(tx, block);
          if (!evt) continue;
          const inserted = applyInscription(evt);
          if (inserted) newEvents.push(evt);
        }
        lastSuccessfulBlock = blockNum;
      }

      // Throttle between batches to respect RPC rate limits
      if (config.batchDelayMs > 0 && end < to) {
        await new Promise(r => setTimeout(r, config.batchDelayMs));
      }
    }

    setState(STATE_KEY, to);
    if (newEvents.length > 0) {
      console.log(`[indexer] +${newEvents.length} inscription(s) [blocks ${from}..${to}]`);
      this.onNewInscriptions(newEvents);
    }
  }

  async getStatus() {
    const last = Number(getState(STATE_KEY));
    let tip = null;
    try { tip = await this.provider.getBlockNumber(); } catch {}
    return {
      last_indexed_block: Number.isFinite(last) ? last : 0,
      chain_tip: tip,
      blocks_behind: tip != null ? Math.max(0, tip - last) : null,
      receiver_wallet: config.receiverWallet,
      chain_id: config.chainId,
    };
  }
}

export default Indexer;
