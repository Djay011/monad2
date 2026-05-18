// Fast-forward the indexer cursor close to the current chain tip.
// Useful when the indexer falls way behind (e.g. dev was offline for hours)
// and you don't care about back-filling the historical gap.
import { ethers } from 'ethers';
import { config } from '../src/config.js';
import { setState, getState } from '../src/db.js';

const LOOKBACK = Number(process.env.FF_LOOKBACK || 200);

const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId, {
  staticNetwork: true,
});

const head = await provider.getBlockNumber();
const target = Math.max(0, head - LOOKBACK);
const previous = Number(getState('last_indexed_block') || 0);

setState('last_indexed_block', target);
console.log(`[fast-forward] chain head = ${head}`);
console.log(`[fast-forward] last_indexed_block: ${previous} -> ${target} (lookback ${LOOKBACK})`);
process.exit(0);
