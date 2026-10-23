/**
 * Database bootstrap shared by the Next.js server and CLI scripts.
 *
 * Demo mode uses PGlite (PostgreSQL compiled to WASM) persisted to ./.data,
 * so the demo never needs — or touches — any production database.
 * For production, replace `createPgliteDb` with drizzle-orm/node-postgres
 * pointed at DATABASE_URL; schema and migrations are unchanged.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";

export type DB = PgliteDatabase<typeof schema>;
/** A transaction handle; same query API as DB. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type DbOrTx = DB | Tx;

/** Override with CRM_DATA_DIR (e.g. a separate copy for tests); defaults to ./.data/pglite. */
export const DATA_DIR = process.env.CRM_DATA_DIR ? path.resolve(process.env.CRM_DATA_DIR) : path.join(process.cwd(), ".data", "pglite");

export async function createPgliteDb(dataDir: string = DATA_DIR) {
  mkdirSync(dataDir, { recursive: true });
  const client = await PGlite.create(dataDir);
  const db = drizzle({ client, schema, casing: "snake_case" });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return { client, db };
}
