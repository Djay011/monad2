import { db } from '../src/db.js';

const before = db.prepare(`SELECT COUNT(*) AS n FROM listings`).get().n;
db.exec(`DELETE FROM listings;`);
db.exec(`DELETE FROM sqlite_sequence WHERE name='listings';`);
console.log(`reset listings table — removed ${before} rows, autoincrement reset to 0`);
