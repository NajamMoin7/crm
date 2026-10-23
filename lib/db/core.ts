/** Connection, collections and transactions (no server-only marker, so CLI scripts can use it). */
import { connectMongo, usingLocalMongo, type Connection } from "./client";
import { makeCollections, runTransaction, type Collections } from "./collections";
import { ensureIndexes } from "./indexes";
import { seedDatabase } from "./seed";

export type { Collections, RowOf, InsertOf, TableKey } from "./collections";
export { currentSession, ImmutableRecordError } from "./collections";

// One connection per server process (Turbopack may evaluate this module more than once).
const g = globalThis as unknown as { __crmDb?: Promise<{ conn: Connection; C: Collections }> };

async function init() {
  const conn = await connectMongo();
  const C = makeCollections(conn.db);
  if (usingLocalMongo()) {
    // The hosted database is prepared once by `npm run db:setup`; the local one on first use.
    await ensureIndexes(conn.db);
    if ((await C.users.countDocuments()) === 0) {
      console.log("[crm] Empty demo database — seeding fictional demo data…");
      await runTransaction(conn.client, () => seedDatabase(C));
      console.log("[crm] Demo data ready.");
    }
  } else if ((await C.users.countDocuments()) === 0) {
    throw new Error("The database has no users. Run `npm run db:setup` against MONGODB_URI first.");
  }
  return { conn, C };
}

function ready() {
  if (!g.__crmDb) {
    g.__crmDb = init().catch((err) => {
      g.__crmDb = undefined;
      throw err;
    });
  }
  return g.__crmDb;
}

/** Typed collections. Calls made inside `withTransaction` join that transaction automatically. */
export async function getDb(): Promise<Collections> {
  return (await ready()).C;
}

/** All-or-nothing unit of work; nested calls join the outer transaction. */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const { conn } = await ready();
  return runTransaction(conn.client, fn);
}
