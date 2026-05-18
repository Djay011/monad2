import { db } from '../src/db.js';

const r = db
  .prepare(`DELETE FROM listings WHERE onchain_id IS NULL`)
  .run();

console.log(`removed ${r.changes} orphan (off-chain-only) listings`);
