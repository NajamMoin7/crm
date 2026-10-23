/**
 * Typed collection access: one MongoDB collection per schema table, documents
 * shaped exactly like the table rows (same field names, `id` keys, money as
 * decimal strings, Date timestamps). `_id` is never returned.
 *
 * Every call made inside `withTransaction()` automatically joins its session,
 * so services never pass a session around. Inserts apply the column defaults
 * declared in schema.ts (timestamps, default statuses, empty arrays, serial ids),
 * just as the database did before.
 *
 * Append-only rules (previously database triggers) are enforced here:
 * - activity_logs, chargeback_events, customer_merge_history: never updated or deleted.
 * - transactions (ledger): never deleted; only status / notes may change, and a
 *   settled row never returns to pending.
 * - chargeback_cases: once completed / rejected / cancelled, amount, currency,
 *   entities and status are frozen.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getTableColumns, getTableName, is, SQL, type Table } from "drizzle-orm";
import type {
  AggregateOptions,
  ClientSession,
  CountDocumentsOptions,
  Db,
  Document,
  Filter,
  FindOptions,
  MongoClient,
  UpdateFilter,
  UpdateOptions,
} from "mongodb";
import * as s from "./schema";

export const TABLES = {
  roles: s.roles,
  permissions: s.permissions,
  rolePermissions: s.rolePermissions,
  users: s.users,
  userRoles: s.userRoles,
  sessions: s.sessions,
  brands: s.brands,
  legalEntities: s.legalEntities,
  brandLegalEntities: s.brandLegalEntities,
  userBrandAccess: s.userBrandAccess,
  userLegalEntityAccess: s.userLegalEntityAccess,
  productsServices: s.productsServices,
  salesAgents: s.salesAgents,
  customers: s.customers,
  customerBrandRelationships: s.customerBrandRelationships,
  duplicateCandidates: s.duplicateCandidates,
  customerMergeHistory: s.customerMergeHistory,
  leads: s.leads,
  sales: s.sales,
  saleItems: s.saleItems,
  invoices: s.invoices,
  invoiceItems: s.invoiceItems,
  transactions: s.transactions,
  chargebackCases: s.chargebackCases,
  chargebackEvents: s.chargebackEvents,
  financialAdjustments: s.financialAdjustments,
  reconciliationRecords: s.reconciliationRecords,
  notes: s.notes,
  tasks: s.tasks,
  activityLogs: s.activityLogs,
  notifications: s.notifications,
  integrationSources: s.integrationSources,
  integrationRuns: s.integrationRuns,
  externalRecordMappings: s.externalRecordMappings,
  systemSettings: s.systemSettings,
  idCounters: s.idCounters,
} as const;

export type TableKey = keyof typeof TABLES;
export type RowOf<K extends TableKey> = (typeof TABLES)[K]["$inferSelect"];
export type InsertOf<K extends TableKey> = (typeof TABLES)[K]["$inferInsert"];

export const collectionName = (k: TableKey) => getTableName(TABLES[k] as Table);

/* ------------------------------------------------------------ sessions */

const g = globalThis as unknown as { __crmTxStore?: AsyncLocalStorage<ClientSession> };
const txStore = (g.__crmTxStore ??= new AsyncLocalStorage<ClientSession>());

/** The session of the transaction this async context is running in, if any. */
export const currentSession = () => txStore.getStore();

/**
 * Runs `fn` in a multi-document transaction (all or nothing). Nested calls join
 * the outer transaction. The driver may retry `fn` on transient errors, so keep
 * side effects (cookies, revalidation) outside. Inside a transaction, run
 * database calls one after another — not with Promise.all.
 */
export async function runTransaction<T>(client: MongoClient, fn: () => Promise<T>): Promise<T> {
  if (txStore.getStore()) return fn();
  const session = client.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await txStore.run(session, fn);
    });
    return result as T;
  } finally {
    await session.endSession();
  }
}

/* ------------------------------------------------------------ defaults */

const NOT_SET = Symbol("not-set");

function sqlText(v: SQL): string {
  return v.queryChunks
    .map((c) => {
      const chunk = c as { value?: unknown };
      return Array.isArray(chunk.value) ? chunk.value.join("") : "";
    })
    .join("");
}

type Col = { name: string; default?: unknown; defaultFn?: () => unknown; notNull: boolean; columnType: string };

function defaultFor(col: Col): unknown {
  if (col.defaultFn) return col.defaultFn();
  const d = col.default;
  if (d === undefined) return col.notNull ? NOT_SET : null;
  if (is(d, SQL)) {
    const text = sqlText(d);
    if (/now\(\)/i.test(text)) return new Date();
    if (/^ARRAY\[/i.test(text)) return [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    if (/'\[\]'::jsonb/.test(text)) return [];
    if (/'\{\}'::jsonb/.test(text)) return {};
    throw new Error(`Unsupported SQL default: ${text}`);
  }
  return d;
}

const columnsCache = new Map<TableKey, [string, Col][]>();
function columnsOf(k: TableKey): [string, Col][] {
  let cols = columnsCache.get(k);
  if (!cols) {
    cols = Object.entries(getTableColumns(TABLES[k] as Table)) as unknown as [string, Col][];
    columnsCache.set(k, cols);
  }
  return cols;
}

/* ------------------------------------------------------------ guards */

const APPEND_ONLY = new Set<TableKey>(["activityLogs", "chargebackEvents", "customerMergeHistory"]);
const LEDGER_MUTABLE = new Set(["status", "notes"]);
const CLOSED_CASE = ["completed", "rejected", "cancelled"];
const CASE_FROZEN = new Set(["amount", "currency", "originalLegalEntityId", "responsibleLegalEntityId", "status"]);

export class ImmutableRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImmutableRecordError";
  }
}

function setKeys(update: UpdateFilter<Document> | Document[]): { keys: string[]; set: Record<string, unknown> } {
  if (Array.isArray(update)) throw new ImmutableRecordError("Pipeline updates are not supported here.");
  const ops = Object.keys(update);
  const set = (update.$set ?? {}) as Record<string, unknown>;
  const keys = ops.flatMap((op) => Object.keys((update as Record<string, Record<string, unknown>>)[op] ?? {}));
  return { keys, set };
}

/* ------------------------------------------------------------ wrapper */

const NO_ID = { _id: 0 } as const;

export class Coll<K extends TableKey> {
  constructor(
    readonly key: K,
    private readonly db: Db,
  ) {}

  get raw() {
    return this.db.collection<RowOf<K>>(collectionName(this.key));
  }

  private opts<O extends object>(o?: O): O & { session?: ClientSession } {
    const session = currentSession();
    return { ...(o ?? ({} as O)), ...(session ? { session } : {}) };
  }

  /** Cursor over matching documents (without `_id`). */
  find(filter: Filter<RowOf<K>> = {}, options: FindOptions = {}) {
    return this.raw.find(filter, this.opts({ ...options, projection: { ...NO_ID, ...(options.projection ?? {}) } }));
  }

  async findOne(filter: Filter<RowOf<K>>, options: FindOptions = {}): Promise<RowOf<K> | null> {
    return (await this.raw.findOne(filter, this.opts({ ...options, projection: { ...NO_ID, ...(options.projection ?? {}) } }))) as RowOf<K> | null;
  }

  countDocuments(filter: Filter<RowOf<K>> = {}, options: CountDocumentsOptions = {}) {
    return this.raw.countDocuments(filter, this.opts(options));
  }

  distinct<F extends keyof RowOf<K> & string>(field: F, filter: Filter<RowOf<K>> = {}): Promise<RowOf<K>[F][]> {
    return this.raw.distinct(field, filter, this.opts({})) as Promise<RowOf<K>[F][]>;
  }

  aggregate<T extends Document = Document>(pipeline: Document[], options: AggregateOptions = {}) {
    return this.raw.aggregate<T>(pipeline, this.opts(options));
  }

  /** Builds a full document from the insert shape, applying schema defaults. */
  private async complete(doc: InsertOf<K>): Promise<RowOf<K>> {
    const out: Record<string, unknown> = { ...(doc as Record<string, unknown>) };
    for (const [field, col] of columnsOf(this.key)) {
      if (out[field] !== undefined) continue;
      if (col.columnType.includes("Serial")) {
        const { nextSequence } = await import("./ids");
        out[field] = await nextSequence(`seq:${collectionName(this.key)}`);
        continue;
      }
      const d = defaultFor(col);
      if (d === NOT_SET) throw new Error(`${collectionName(this.key)}.${field} is required`);
      out[field] = d;
    }
    return out as RowOf<K>;
  }

  async insertOne(doc: InsertOf<K>): Promise<RowOf<K>> {
    const full = await this.complete(doc);
    await this.raw.insertOne({ ...full } as never, this.opts({}));
    return full;
  }

  async insertMany(docs: InsertOf<K>[]): Promise<RowOf<K>[]> {
    if (!docs.length) return [];
    const full: RowOf<K>[] = [];
    for (const d of docs) full.push(await this.complete(d));
    await this.raw.insertMany(full.map((d) => ({ ...d })) as never[], this.opts({}));
    return full;
  }

  private guardUpdate(filter: Filter<RowOf<K>>, update: UpdateFilter<RowOf<K>>): Filter<RowOf<K>> {
    if (APPEND_ONLY.has(this.key)) throw new ImmutableRecordError(`${collectionName(this.key)} is append-only.`);
    const { keys, set } = setKeys(update as UpdateFilter<Document>);
    if (this.key === "transactions") {
      const bad = keys.filter((k) => !LEDGER_MUTABLE.has(k));
      if (bad.length) throw new ImmutableRecordError(`Ledger transactions are immutable (${bad.join(", ")}); record a reversal or adjustment instead.`);
      // Rows are created settled or pending; nothing ever moves back to pending.
      if (set.status === "pending") throw new ImmutableRecordError("A ledger transaction cannot return to pending.");
      return filter;
    }
    if (this.key === "chargebackCases" && keys.some((k) => CASE_FROZEN.has(k))) {
      return { $and: [filter, { status: { $nin: CLOSED_CASE } }] } as Filter<RowOf<K>>;
    }
    return filter;
  }

  /** A guarded update that matched nothing although the record exists hit a closed case. */
  private async checkGuarded(filter: Filter<RowOf<K>>, guarded: Filter<RowOf<K>>, matched: number) {
    if (matched > 0 || guarded === filter) return;
    if (await this.raw.countDocuments(filter, this.opts({}))) {
      throw new ImmutableRecordError("This chargeback case is closed; it cannot be modified.");
    }
  }

  async updateOne(filter: Filter<RowOf<K>>, update: UpdateFilter<RowOf<K>>, options: UpdateOptions = {}) {
    const guarded = this.guardUpdate(filter, update);
    const res = await this.raw.updateOne(guarded, update, this.opts(options));
    await this.checkGuarded(filter, guarded, res.matchedCount);
    return res;
  }

  async updateMany(filter: Filter<RowOf<K>>, update: UpdateFilter<RowOf<K>>, options: UpdateOptions = {}) {
    const guarded = this.guardUpdate(filter, update);
    const res = await this.raw.updateMany(guarded, update, this.opts(options));
    await this.checkGuarded(filter, guarded, res.matchedCount);
    return res;
  }

  async findOneAndUpdate(filter: Filter<RowOf<K>>, update: UpdateFilter<RowOf<K>>, options: { upsert?: boolean } = {}): Promise<RowOf<K> | null> {
    const guarded = this.guardUpdate(filter, update);
    const res = await this.raw.findOneAndUpdate(guarded, update, this.opts({ ...options, returnDocument: "after" as const, projection: NO_ID }));
    if (!res) await this.checkGuarded(filter, guarded, 0);
    return res as RowOf<K> | null;
  }

  async deleteOne(filter: Filter<RowOf<K>>) {
    this.guardDelete();
    return this.raw.deleteOne(filter, this.opts({}));
  }

  async deleteMany(filter: Filter<RowOf<K>>) {
    this.guardDelete();
    return this.raw.deleteMany(filter, this.opts({}));
  }

  private guardDelete() {
    if (APPEND_ONLY.has(this.key) || this.key === "transactions") {
      throw new ImmutableRecordError(`${collectionName(this.key)} rows are never deleted.`);
    }
  }
}

export type Collections = { [K in TableKey]: Coll<K> };

const reg = globalThis as unknown as { __crmCollections?: Collections };

export function makeCollections(db: Db): Collections {
  const C = Object.fromEntries((Object.keys(TABLES) as TableKey[]).map((k) => [k, new Coll(k, db)])) as Collections;
  reg.__crmCollections = C;
  return C;
}

/** The collections of the open connection (set as soon as it connects, before seeding). */
export function registeredCollections(): Collections {
  if (!reg.__crmCollections) throw new Error("Database not connected yet.");
  return reg.__crmCollections;
}
