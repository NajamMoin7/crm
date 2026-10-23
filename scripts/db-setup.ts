/**
 * Prepares a hosted PostgreSQL demo database for the online deployment.
 *
 *   DATABASE_URL=postgres://… npm run db:setup -- --yes            copy the local demo data (.data/pglite)
 *   DATABASE_URL=postgres://… npm run db:setup -- --yes --seed     load the fresh deterministic seed instead
 *
 * 1. Applies the migrations in drizzle/ (schema + append-only triggers).
 * 2. Refuses to continue if the target already holds users — it never
 *    overwrites or deletes data. Use a new, empty database.
 * 3. Copies every table from the local PGlite demo database in foreign-key
 *    order (login sessions excluded) inside one transaction, then advances
 *    the serial sequences. Stop the local server first (PGlite is single-process).
 */
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { createPgliteDb, createPostgresDb, migratePostgres, DATA_DIR } from "../lib/db/client";
import { seedDatabase } from "../lib/db/seed";

const SKIP = new Set(["sessions"]);

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL to the hosted demo database first.");
  const host = new URL(url).host;
  if (!process.argv.includes("--yes")) {
    console.log(`Target: ${host}\nThis must be a new, empty DEMO database (never production). Re-run with --yes to continue.`);
    process.exit(1);
  }
  const seedOnly = process.argv.includes("--seed");

  const { db, client: pool } = await createPostgresDb(url, { max: 2 });
  console.log(`Migrating ${host}…`);
  await migratePostgres(db);
  const existing = await db.execute<{ n: number }>(sql`select count(*)::int as n from users`);
  if (existing.rows[0].n > 0) {
    await pool.end();
    throw new Error(`${host} already has ${existing.rows[0].n} users — nothing changed. Use an empty database.`);
  }

  if (seedOnly) {
    await seedDatabase(db);
    console.log("Loaded the deterministic demo seed.");
  } else {
    const { client: local } = await createPgliteDb(DATA_DIR);
    const conn = await pool.connect();
    try {
      await copyAll(local, conn);
    } finally {
      conn.release();
      await local.close();
    }
  }
  const counts = await db.execute<{ t: string; n: number }>(
    sql`select 'users' t, count(*)::int n from users union all select 'customers', count(*)::int from customers union all select 'invoices', count(*)::int from invoices union all select 'chargeback_cases', count(*)::int from chargeback_cases`,
  );
  console.log(counts.rows.map((r) => `${r.t}=${r.n}`).join("  "));
  await pool.end();
  console.log("Done. Set the same DATABASE_URL in the hosting provider's environment variables.");
}

type Local = Awaited<ReturnType<typeof createPgliteDb>>["client"];

async function copyAll(local: Local, remote: PoolClient) {
  const tables = (await local.query<{ t: string }>(`select table_name t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)).rows
    .map((r) => r.t)
    .filter((t) => !SKIP.has(t));
  const fks = (
    await local.query<{ child: string; col: string; parent: string }>(`
      select tc.table_name child, kcu.column_name col, ccu.table_name parent
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
      join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
      where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`)
  ).rows;

  // Parents before children; self-references are handled row by row below.
  const order: string[] = [];
  const pending = new Set(tables);
  while (pending.size) {
    const ready = [...pending].filter((t) => fks.every((f) => f.child !== t || f.parent === t || !pending.has(f.parent)));
    if (!ready.length) throw new Error(`Foreign-key cycle between: ${[...pending].join(", ")}`);
    for (const t of ready.sort()) {
      order.push(t);
      pending.delete(t);
    }
  }

  await remote.query("begin");
  try {
    for (const t of order) {
      const cols = (
        await local.query<{ c: string; type: string }>(
          `select column_name c, data_type type from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`,
          [t],
        )
      ).rows;
      let rows = (await local.query<Record<string, unknown>>(`select * from "${t}"`)).rows;
      const selfCols = fks.filter((f) => f.child === t && f.parent === t).map((f) => f.col);
      if (selfCols.length) rows = selfFirst(rows, selfCols);
      const names = cols.map((c) => `"${c.c}"`).join(", ");
      for (const row of rows) {
        const values = cols.map(({ c, type }) => (row[c] != null && (type === "json" || type === "jsonb") ? JSON.stringify(row[c]) : row[c]));
        await remote.query(`insert into "${t}" (${names}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, values);
      }
      console.log(`${t.padEnd(30)} ${rows.length}`);
    }
    // Serial columns: continue after the copied ids.
    const serials = (
      await local.query<{ t: string; c: string }>(
        `select table_name t, column_name c from information_schema.columns where table_schema = 'public' and column_default like 'nextval(%'`,
      )
    ).rows.filter((s) => !SKIP.has(s.t));
    for (const s of serials) {
      await remote.query(`select setval(pg_get_serial_sequence('"${s.t}"', '${s.c}'), coalesce((select max("${s.c}") from "${s.t}"), 0) + 1, false)`);
    }
    await remote.query("commit");
  } catch (e) {
    await remote.query("rollback");
    throw e;
  }
}

/** Orders rows so a row referencing another row of the same table comes after it. */
function selfFirst(rows: Record<string, unknown>[], cols: string[]) {
  const ids = new Set(rows.map((r) => r.id));
  const done = new Set<unknown>();
  const out: Record<string, unknown>[] = [];
  let left = rows;
  while (left.length) {
    const next = left.filter((r) => cols.every((c) => r[c] == null || done.has(r[c]) || !ids.has(r[c])));
    if (!next.length) throw new Error("Self-reference cycle in copied rows");
    for (const r of next) {
      out.push(r);
      done.add(r.id);
    }
    left = left.filter((r) => !next.includes(r));
  }
  return out;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
