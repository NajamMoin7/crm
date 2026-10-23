/**
 * Recreates the LOCAL demo database from the deterministic seed.
 * Works while `npm run dev` is running (it re-uses that local MongoDB).
 * Refuses to touch a hosted database (MONGODB_URI) — use `npm run db:setup` for that.
 *
 *   npm run db:reset
 */
import { connectMongo, DATA_DIR, usingLocalMongo } from "../lib/db/client";
import { collectionName, makeCollections, runTransaction, TABLES, type TableKey } from "../lib/db/collections";
import { ensureIndexes } from "../lib/db/indexes";
import { seedDatabase } from "../lib/db/seed";

async function main() {
  if (!usingLocalMongo()) throw new Error("db:reset only resets the local demo database. Unset MONGODB_URI.");
  const started = Date.now();
  const conn = await connectMongo();
  try {
    await conn.db.dropDatabase();
    await ensureIndexes(conn.db);
    const C = makeCollections(conn.db);
    await runTransaction(conn.client, () => seedDatabase(C));
    for (const k of Object.keys(TABLES) as TableKey[]) {
      const n = await C[k].countDocuments();
      if (n) console.log(`${collectionName(k).padEnd(30)} ${n}`);
    }
  } finally {
    await conn.close();
  }
  console.log(`\nDemo database ready in ${((Date.now() - started) / 1000).toFixed(1)}s at ${DATA_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
