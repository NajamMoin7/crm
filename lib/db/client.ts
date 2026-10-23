/**
 * Database bootstrap shared by the Next.js server and CLI scripts.
 *
 * - DATABASE_URL set   → a real PostgreSQL server (e.g. a hosted demo database),
 *   used for the online deployment. Migrations are applied by `npm run db:setup`,
 *   never on request.
 * - DATABASE_URL unset → PGlite (PostgreSQL compiled to WASM) persisted to ./.data,
 *   for local development; migrated and seeded automatically.
 *
 * Both run the same schema and migrations and return the same result shapes.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema";

/**
 * The query-builder API is identical for both drivers; the PGlite type is used
 * as the common shape (`execute` returns `{ rows }` in both).
 */
export type DB = PgliteDatabase<typeof schema>;
/** A transaction handle; same query API as DB. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type DbOrTx = DB | Tx;

/** Override with CRM_DATA_DIR (e.g. a separate copy for tests); defaults to ./.data/pglite. */
export const DATA_DIR = process.env.CRM_DATA_DIR ? path.resolve(process.env.CRM_DATA_DIR) : path.join(process.cwd(), ".data", "pglite");
export const MIGRATIONS = path.join(process.cwd(), "drizzle");

export const usingPostgres = () => !!process.env.DATABASE_URL;

export async function createPgliteDb(dataDir: string = DATA_DIR) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  mkdirSync(dataDir, { recursive: true });
  const client = await PGlite.create(dataDir);
  const db = drizzle({ client, schema, casing: "snake_case" });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { client, db };
}

export async function createPostgresDb(url: string = process.env.DATABASE_URL!, opts: { max?: number } = {}) {
  const pg = await import("pg");
  const Pool = pg.Pool ?? pg.default.Pool; // CommonJS package: named export only under some loaders
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new Pool({
    connectionString: url,
    // Serverless functions run many small instances: keep each pool tiny.
    max: opts.max ?? 3,
    idleTimeoutMillis: 10_000,
    ssl: local || /sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: true },
  });
  const db = drizzle({ client: pool, schema, casing: "snake_case" }) as unknown as DB;
  return { client: pool, db };
}

export async function migratePostgres(db: DB) {
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  await migrate(db as never, { migrationsFolder: MIGRATIONS });
}
