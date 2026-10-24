/**
 * Loads a MongoDB database for the CRM — the hosted one (MONGODB_URI, e.g. Atlas)
 * or, without MONGODB_URI, the local one in .data/mongo.
 *
 *   npm run db:setup -- --yes --uri "mongodb+srv://…"           copy the existing data (old local database, .data/pglite) into Atlas
 *   npm run db:setup -- --yes --uri "mongodb+srv://…" --seed    load the fresh deterministic demo data instead
 *   npm run db:setup -- --yes --local                            load the local database (.data/mongo)
 *   (MONGODB_URI in the environment works instead of --uri.)
 *
 * 1. Creates every collection's indexes.
 * 2. Refuses to continue if the target already holds users — it never
 *    overwrites or deletes data. Use a new, empty database.
 * 3. Copies every table (login sessions excluded) into its collection inside one
 *    transaction, keeping ids, money values and dates exactly, and continues the
 *    numbered ids after the copied ones.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { connectMongo, DATA_DIR, DB_NAME, mongoHost, usingLocalMongo } from "../lib/db/client";
import { collectionName, makeCollections, runTransaction, TABLES, type Collections, type TableKey } from "../lib/db/collections";
import { ensureIndexes } from "../lib/db/indexes";
import { seedDatabase } from "../lib/db/seed";

const PGLITE_DIR = process.env.CRM_PGLITE_DIR ? path.resolve(process.env.CRM_PGLITE_DIR) : path.join(process.cwd(), ".data", "pglite");
const SKIP = new Set<TableKey>(["sessions"]);
const SERIAL: TableKey[] = ["activityLogs", "chargebackEvents"];

async function main() {
  // `--uri <connection string>` works in any terminal (no environment variable syntax to get wrong).
  const uriArg = process.argv[process.argv.indexOf("--uri") + 1];
  if (process.argv.includes("--uri")) {
    if (!uriArg || !/^mongodb(\+srv)?:\/\//.test(uriArg)) throw new Error('--uri needs a connection string starting with "mongodb+srv://" (in quotes).');
    process.env.MONGODB_URI = uriArg;
  }
  // Loading the local database must be asked for explicitly, so a missing
  // connection string never silently fills the wrong database.
  if (usingLocalMongo() && !process.argv.includes("--local")) {
    throw new Error(
      'No hosted database given. Run:  npm run db:setup -- --yes --uri "mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/"\n(or add --local to load the local database in .data/mongo instead).',
    );
  }
  const target = usingLocalMongo() ? `the local database (${path.relative(process.cwd(), DATA_DIR)})` : `${mongoHost(process.env.MONGODB_URI!)} / ${DB_NAME}`;
  if (!process.argv.includes("--yes")) {
    console.log(`Target: ${target}\nThis must be a new, empty DEMO database (never production). Re-run with --yes to continue.`);
    process.exit(1);
  }
  const seedOnly = process.argv.includes("--seed");
  if (!seedOnly && !existsSync(PGLITE_DIR)) throw new Error(`No existing data at ${PGLITE_DIR}. Use --seed for the demo data.`);

  const conn = await connectMongo();
  try {
    console.log(`Preparing ${target}…`);
    await ensureIndexes(conn.db);
    const C = makeCollections(conn.db);
    const users = await C.users.countDocuments();
    if (users > 0) throw new Error(`${target} already has ${users} users — nothing changed. Use an empty database.`);

    if (seedOnly) {
      await runTransaction(conn.client, () => seedDatabase(C));
      console.log("Loaded the deterministic demo seed.");
    } else {
      const rows = await readPglite();
      await runTransaction(conn.client, () => copyAll(C, rows));
    }
    const counts = await Promise.all((["users", "customers", "invoices", "chargebackCases"] as const).map(async (k) => `${collectionName(k)}=${await C[k].countDocuments()}`));
    console.log(counts.join("  "));
  } finally {
    await conn.close();
  }
  console.log(usingLocalMongo() ? "Done." : "Done. Set the same MONGODB_URI in Netlify's environment variables.");
}

/** Reads every table through Drizzle, which maps columns and types to the document shape. */
async function readPglite() {
  const client = await PGlite.create(PGLITE_DIR);
  const db = drizzle({ client, casing: "snake_case" });
  const out = new Map<TableKey, Record<string, unknown>[]>();
  try {
    for (const k of Object.keys(TABLES) as TableKey[]) {
      if (SKIP.has(k)) continue;
      out.set(k, (await db.select().from(TABLES[k] as never)) as Record<string, unknown>[]);
    }
  } finally {
    await client.close();
  }
  return out;
}

async function copyAll(C: Collections, rows: Map<TableKey, Record<string, unknown>[]>) {
  for (const [k, list] of rows) {
    if (!list.length) continue;
    await (C[k] as unknown as { insertMany(d: object[]): Promise<unknown> }).insertMany(list);
    console.log(`${collectionName(k).padEnd(30)} ${list.length}`);
  }
  // Numbered rows (audit log, case events) continue after the copied ids.
  for (const k of SERIAL) {
    const max = Math.max(0, ...(rows.get(k) ?? []).map((r) => Number(r.id)));
    await C.idCounters.updateOne({ name: `seq:${collectionName(k)}` }, { $set: { value: max } }, { upsert: true });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
