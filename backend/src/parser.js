import { ethers } from 'ethers';

// Recognized inscription protocols
const SUPPORTED_PROTOCOLS = new Set(['mon-20']);
const VALID_OPS = new Set(['deploy', 'mint', 'transfer']);

const PREFIXES = [
  'data:application/json,',
  'data:application/json;utf8,',
];

/**
 * Parse a transaction's input data and return a normalized inscription event,
 * or null if the calldata isn't a recognized inscription.
 */
export function parseInscription(tx, block) {
  if (!tx || !tx.data || tx.data === '0x') return null;

  let utf8;
  try {
    utf8 = ethers.toUtf8String(tx.data);
  } catch {
    return null;
  }

  const trimmed = utf8.trim();
  let jsonPart = null;
  for (const p of PREFIXES) {
    if (trimmed.startsWith(p)) {
      jsonPart = trimmed.slice(p.length).trim();
      break;
    }
  }
  if (!jsonPart) return null;

  let json;
  try {
    json = JSON.parse(jsonPart);
  } catch {
    return null;
  }

  if (!json || typeof json !== 'object') return null;
  const protocol = String(json.p || '').toLowerCase();
  const operation = String(json.op || '').toLowerCase();
  const tick = String(json.tick || '').toUpperCase();
  const amount = json.amt != null ? String(json.amt) : '0';

  if (!SUPPORTED_PROTOCOLS.has(protocol)) return null;
  if (!VALID_OPS.has(operation)) return null;
  if (!tick) return null;
  if (!/^\d+$/.test(amount)) return null; // integer amounts only

  return {
    tx_hash: tx.hash,
    block_number: Number(block.number),
    timestamp: Number(block.timestamp),
    from_address: (tx.from || '').toLowerCase(),
    to_address: (tx.to || '').toLowerCase(),
    protocol,
    operation,
    tick,
    amount,
    raw_json: jsonPart,
  };
}
