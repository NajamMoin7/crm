/**
 * Recreates the local demo database from scratch.
 * Stop `next dev` first — PGlite holds an exclusive lock on .data/pglite.
 *
 *   npm run db:reset
 */
import { rmSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createPgliteDb, DATA_DIR } from "../lib/db/client";
import { seedDatabase } from "../lib/db/seed";

async function main() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const started = Date.now();
  const { db, client } = await createPgliteDb();
  await seedDatabase(db);
  const tables = [
    "users", "brands", "legal_entities", "brand_legal_entities", "customers", "customer_brand_relationships",
    "duplicate_candidates", "leads", "sales", "invoices", "transactions", "chargeback_cases", "chargeback_events",
    "financial_adjustments", "reconciliation_records", "integration_runs", "activity_logs", "notifications",
  ];
  for (const t of tables) {
    const r = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${t}`));
    console.log(`${t.padEnd(30)} ${r.rows[0].n}`);
  }
  await client.close();
  console.log(`\nDemo database ready in ${((Date.now() - started) / 1000).toFixed(1)}s at ${DATA_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
