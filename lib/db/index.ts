import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { count } from "drizzle-orm";
import { createPgliteDb, type DB } from "./client";
import { users } from "./schema";
import { seedDatabase } from "./seed";

export type { DB, Tx, DbOrTx } from "./client";

// PGlite holds an exclusive lock on its data directory, so the instance must be
// a true process-wide singleton (Turbopack may evaluate this module more than once).
const globalForDb = globalThis as unknown as {
  __crmDb?: Promise<DB>;
  __crmTxStore?: AsyncLocalStorage<DB>;
};

/**
 * PGlite has a single connection: while a transaction is open, any query sent
 * through the root `db` waits for the transaction to finish — which never
 * happens if the transaction itself is awaiting that query (deadlock).
 * We track the active transaction per async context so that `getDb()` called
 * from inside `db.transaction(...)` (e.g. a shared lookup helper) returns the
 * transaction handle and joins it instead of blocking.
 */
const txStore = (globalForDb.__crmTxStore ??= new AsyncLocalStorage<DB>());

async function init(): Promise<DB> {
  const { db } = await createPgliteDb();
  const [{ n }] = await db.select({ n: count() }).from(users);
  if (n === 0) {
    console.log("[crm] Empty demo database — seeding fictional demo data…");
    await seedDatabase(db);
    console.log("[crm] Demo data ready.");
  }
  const original = db.transaction.bind(db);
  db.transaction = ((fn, config) =>
    original((tx) => txStore.run(tx as unknown as DB, () => fn(tx)), config)) as DB["transaction"];
  return db;
}

export function getDb(): Promise<DB> {
  const activeTx = txStore.getStore();
  if (activeTx) return Promise.resolve(activeTx);
  if (!globalForDb.__crmDb) {
    globalForDb.__crmDb = init().catch((err) => {
      globalForDb.__crmDb = undefined;
      throw err;
    });
  }
  return globalForDb.__crmDb;
}
