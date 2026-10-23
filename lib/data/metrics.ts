import "server-only";
import { and, count, countDistinct, eq, exists, gte, inArray, lte, ne, or, sql, sum, type SQL, notInArray } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { format as fmtD, subMonths } from "date-fns";
import { getDb } from "@/lib/db";
import {
  chargebackCases,
  customers,
  financialAdjustments,
  invoices,
  sales,
  transactions } from "@/lib/db/schema";
import { brandFilter, resolveBrand, scopeCases, scopeCustomers, scopeInvoices, scopeSales, scopeTransactions } from "@/lib/auth/scope";
import { can, canAccessEntity, type Viewer } from "@/lib/auth/viewer";
import { parseFilters, type ListFilters, type RawSearchParams } from "@/lib/filters";
import { toCents } from "@/lib/money";
import { CASE_OPEN_STATUSES } from "@/lib/domain/vocab";
import { getAgents } from "@/lib/data/reference";

/**
 * Executive metrics. Every number is computed in SQL from the underlying
 * records and composed with the row-level scope helpers, so a user only ever
 * aggregates data they are allowed to see.
 *
 * Definitions (kept in one place so the dashboard, brand page and reports agree):
 * - Gross sales     = Σ sales.total of non-cancelled sales, by sale date.
 * - Collected       = Σ succeeded `payment` ledger rows, by occurred date.
 * - Outstanding     = Σ (invoice total − amount paid − approved adjustments) of
 *                     pending / partially-paid / overdue invoices, by billing date.
 * - Chargebacks     = cases of type `chargeback` (intercompany recharges excluded);
 *                     amounts count COMPLETED cases only.
 * Refunds, chargebacks and intercompany transfers are never netted into gross.
 */

export type MetricFilters = ListFilters;

const INVOICE_STATUSES = ["draft", "pending", "paid", "partially_paid", "overdue", "cancelled", "refunded"] as const;
export const OPEN_INVOICE_STATUSES = ["pending", "partially_paid", "overdue"] as const;

/** Legal-entity filter is only honoured for users who may see entities, and only for entities they can access. */
export function canFilterEntity(viewer: Viewer) {
  return can(viewer, "entities.view") || can(viewer, "transactions.view");
}

export function resolveEntity(viewer: Viewer, entity: string | null): string | null {
  if (!entity || !canFilterEntity(viewer)) return null;
  return canAccessEntity(viewer, entity) ? entity : null;
}

/** Parses + validates the shared filter vocabulary for dashboards / reports / exports. */
export async function resolveMetricFilters(viewer: Viewer, sp: RawSearchParams, now: Date, defaultRange = "30d"): Promise<MetricFilters> {
  const f = parseFilters(sp, now, { range: defaultRange });
  f.brand = await resolveBrand(viewer, f.brand);
  f.entity = resolveEntity(viewer, f.entity);
  if (f.customer && !/^[A-Za-z0-9-]{3,40}$/.test(f.customer)) f.customer = null;
  return f;
}

export function isInvoiceStatus(s: string | null): s is (typeof INVOICE_STATUSES)[number] {
  return !!s && (INVOICE_STATUSES as readonly string[]).includes(s);
}

export function inRange(col: AnyPgColumn, f: Pick<MetricFilters, "from" | "to">): SQL | undefined {
  return and(f.from ? gte(col, f.from) : undefined, f.to ? lte(col, f.to) : undefined);
}

const invoiceHasStatus = (idCol: AnyPgColumn, status: string) =>
  exists(sql`(select 1 from ${invoices} where ${invoices.id} = ${idCol} and ${invoices.status} = ${status})`);
const invoiceHasAgent = (idCol: AnyPgColumn, agent: string) =>
  exists(sql`(select 1 from ${invoices} where ${invoices.id} = ${idCol} and ${invoices.agentId} = ${agent})`);

/* ------------------------------------------------------- condition builders */

export function saleConds(viewer: Viewer, f: MetricFilters, opts: { range?: boolean; status?: boolean } = {}) {
  return and(
    scopeSales(viewer, f.brand),
    ne(sales.status, "cancelled"),
    f.agent ? eq(sales.agentId, f.agent) : undefined,
    f.entity ? eq(sales.legalEntityId, f.entity) : undefined,
    f.customer ? eq(sales.customerId, f.customer) : undefined,
    opts.status !== false && isInvoiceStatus(f.status)
      ? exists(sql`(select 1 from ${invoices} where ${invoices.saleId} = ${sales.id} and ${invoices.status} = ${f.status})`)
      : undefined,
    opts.range === false ? undefined : inRange(sales.saleDate, f),
  )!;
}

export function invoiceConds(viewer: Viewer, f: MetricFilters, opts: { range?: boolean; status?: boolean } = {}) {
  return and(
    scopeInvoices(viewer, f.brand),
    f.agent ? eq(invoices.agentId, f.agent) : undefined,
    f.entity ? eq(invoices.legalEntityId, f.entity) : undefined,
    f.customer ? eq(invoices.customerId, f.customer) : undefined,
    opts.status !== false && isInvoiceStatus(f.status) ? eq(invoices.status, f.status) : undefined,
    opts.range === false ? undefined : inRange(invoices.billingDate, f),
  )!;
}

/** Ledger rows. Agent / invoice-status filters (and own-only billing scope) apply through the linked invoice. */
export function txnConds(viewer: Viewer, f: MetricFilters, opts: { range?: boolean } = {}) {
  return and(
    scopeTransactions(viewer, f.brand),
    f.entity ? eq(transactions.legalEntityId, f.entity) : undefined,
    f.customer ? eq(transactions.customerId, f.customer) : undefined,
    f.agent ? invoiceHasAgent(transactions.invoiceId, f.agent) : undefined,
    !can(viewer, "billing.view_all") ? invoiceHasAgent(transactions.invoiceId, viewer.id) : undefined,
    isInvoiceStatus(f.status) ? invoiceHasStatus(transactions.invoiceId, f.status) : undefined,
    opts.range === false ? undefined : inRange(transactions.occurredAt, f),
  )!;
}

/** Customer chargeback cases only (intercompany recharges are a separate type and never counted here). */
export function caseConds(viewer: Viewer, f: MetricFilters, opts: { range?: boolean; type?: "chargeback" | "intercompany_recharge" | "any" } = {}) {
  const type = opts.type ?? "chargeback";
  return and(
    scopeCases(viewer, f.brand),
    type === "any" ? undefined : eq(chargebackCases.caseType, type),
    f.entity ? or(eq(chargebackCases.originalLegalEntityId, f.entity), eq(chargebackCases.responsibleLegalEntityId, f.entity)) : undefined,
    f.customer ? eq(chargebackCases.customerId, f.customer) : undefined,
    f.agent ? invoiceHasAgent(chargebackCases.invoiceId, f.agent) : undefined,
    isInvoiceStatus(f.status) ? invoiceHasStatus(chargebackCases.invoiceId, f.status) : undefined,
    opts.range === false ? undefined : inRange(chargebackCases.requestDate, f),
  )!;
}

export function customerConds(viewer: Viewer, f: MetricFilters) {
  return and(
    scopeCustomers(viewer, f.brand),
    f.agent ? eq(customers.assignedAgentId, f.agent) : undefined,
    f.customer ? eq(customers.id, f.customer) : undefined,
    f.entity ? exists(sql`(select 1 from ${sales} where ${sales.customerId} = ${customers.id} and ${sales.legalEntityId} = ${f.entity})`) : undefined,
  )!;
}

/** Sum of approved adjustments for the current invoice row (correlated subquery). */
const approvedAdjustments = sql`coalesce((select sum(${financialAdjustments.amount}) from ${financialAdjustments} where ${financialAdjustments.invoiceId} = ${invoices.id} and ${financialAdjustments.status} = 'approved'), 0)`;
export const invoiceBalance = sql<string>`greatest(${invoices.total} - ${invoices.amountPaid} - ${approvedAdjustments}, 0)`;

const c = (v: string | number | null | undefined) => toCents(v ?? 0);

/* -------------------------------------------------------------------- KPIs */

export type Kpis = {
  totalCustomers: number;
  newCustomers: number;
  salesCount: number;
  grossCents: number;
  collectedCents: number;
  paymentsCount: number;
  outstandingCents: number;
  outstandingCount: number;
  pendingBilling: number;
  billedCents: number;
  invoiceCount: number;
  pendingDraft: number;
  pendingPending: number;
  cbCases: number;
  cbOpen: number;
  cbCompleted: number;
  cbCompletedCents: number;
  cbOpenCents: number;
  activeAgents: number;
  totalAgents: number;
};

export async function getKpis(viewer: Viewer, f: MetricFilters): Promise<Kpis> {
  const db = await getDb();
  const cust = customerConds(viewer, f);
  const [[tc], [nc], [s], [p], [o], pend, [cb], [ag], agents, [bl]] = await Promise.all([
    db.select({ n: count() }).from(customers).where(cust),
    db.select({ n: count() }).from(customers).where(and(cust, inRange(customers.createdAt, f))),
    db.select({ n: count(), gross: sum(sales.total) }).from(sales).where(saleConds(viewer, f)),
    db
      .select({ n: count(), amt: sum(transactions.amount) })
      .from(transactions)
      .where(and(txnConds(viewer, f), eq(transactions.type, "payment"), eq(transactions.status, "succeeded"))),
    db
      .select({ n: count(), amt: sql<string>`sum(${invoiceBalance})` })
      .from(invoices)
      .where(and(invoiceConds(viewer, f), inArray(invoices.status, [...OPEN_INVOICE_STATUSES]))),
    db
      .select({ status: invoices.status, n: count() })
      .from(invoices)
      .where(and(invoiceConds(viewer, f), inArray(invoices.status, ["draft", "pending"])))
      .groupBy(invoices.status),
    db
      .select({
        n: count(),
        open: sql<number>`count(*) filter (where ${inArray(chargebackCases.status, [...CASE_OPEN_STATUSES])})`.mapWith(Number),
        completed: sql<number>`count(*) filter (where ${chargebackCases.status} = 'completed')`.mapWith(Number),
        completedAmt: sql<string>`coalesce(sum(${chargebackCases.amount}) filter (where ${chargebackCases.status} = 'completed'), 0)`,
        openAmt: sql<string>`coalesce(sum(${chargebackCases.amount}) filter (where ${inArray(chargebackCases.status, [...CASE_OPEN_STATUSES])}), 0)`,
      })
      .from(chargebackCases)
      .where(caseConds(viewer, f)),
    db.select({ n: countDistinct(sales.agentId) }).from(sales).where(saleConds(viewer, f)),
    getAgents(),
    // Billed = issued invoices (not draft, not cancelled) billed in range.
    db
      .select({ n: count(), amt: sum(invoices.total) })
      .from(invoices)
      .where(and(invoiceConds(viewer, f), notInArray(invoices.status, ["draft", "cancelled"]))),
  ]);
  const brands = brandFilter(viewer, f.brand);
  const pool = agents.filter((a) => a.status === "active" && a.brandIds.some((b) => brands.includes(b)) && (!f.agent || a.id === f.agent));
  const pd = pend.find((r) => r.status === "draft")?.n ?? 0;
  const pp = pend.find((r) => r.status === "pending")?.n ?? 0;
  return {
    totalCustomers: tc.n,
    newCustomers: nc.n,
    salesCount: s.n,
    grossCents: c(s.gross),
    collectedCents: c(p.amt),
    paymentsCount: p.n,
    outstandingCents: c(o.amt),
    outstandingCount: o.n,
    pendingBilling: pd + pp,
    billedCents: c(bl.amt),
    invoiceCount: bl.n,
    pendingDraft: pd,
    pendingPending: pp,
    cbCases: cb.n,
    cbOpen: cb.open,
    cbCompleted: cb.completed,
    cbCompletedCents: c(cb.completedAmt),
    cbOpenCents: c(cb.openAmt),
    activeAgents: ag.n,
    totalAgents: pool.length,
  };
}

/* ---------------------------------------------------------- time buckets */

export type Unit = "day" | "week" | "month";
export type Bucket = { key: string; label: string };

export function pickUnit(from: Date, to: Date): Unit {
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  return days <= 35 ? "day" : days <= 190 ? "week" : "month";
}

const bucketExpr = (unit: Unit, col: AnyPgColumn) => sql<string>`to_char(date_trunc(${sql.raw(`'${unit}'`)}, ${col}), 'YYYY-MM-DD')`;

function labelFor(key: string, unit: Unit) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return unit === "month" ? fmtD(date, "MMM yy") : fmtD(date, "MMM d");
}

/** Buckets generated in the database so they match `date_trunc` exactly (same session time zone). */
async function makeBuckets(unit: Unit, from: Date, to: Date): Promise<Bucket[]> {
  const db = await getDb();
  const res = await db.execute<{ key: string }>(
    sql`select to_char(b, 'YYYY-MM-DD') as key from generate_series(date_trunc(${sql.raw(`'${unit}'`)}, ${from.toISOString()}::timestamptz), ${to.toISOString()}::timestamptz, ${sql.raw(`'1 ${unit}'`)}::interval) as b`,
  );
  return (res.rows as { key: string }[]).map((r) => ({ key: r.key, label: labelFor(r.key, unit) }));
}

/** Effective window for trend charts: for "All time" start at the earliest scoped sale. */
async function trendWindow(viewer: Viewer, f: MetricFilters, now: Date) {
  let from = f.from;
  if (!from) {
    const db = await getDb();
    const [r] = await db.select({ min: sql<string | null>`min(${sales.saleDate})` }).from(sales).where(saleConds(viewer, f, { range: false }));
    from = r?.min ? new Date(r.min) : subMonths(now, 12);
  }
  const to = f.to ?? now;
  return { from, to, unit: pickUnit(from, to) };
}

export type TrendResult = { unit: Unit; buckets: Bucket[]; rows: Record<string, string | number>[]; brandIds: string[] };

function pivot(buckets: Bucket[], data: { bucket: string; brandId: string; v: number }[], brandIds: string[]) {
  return buckets.map((b) => {
    const row: Record<string, string | number> = { key: b.key, label: b.label };
    for (const id of brandIds) row[id] = 0;
    for (const d of data) if (d.bucket === b.key) row[d.brandId] = (Number(row[d.brandId]) || 0) + d.v;
    return row;
  });
}

/** Gross sales per brand over time (dollars). */
export async function salesTrend(viewer: Viewer, f: MetricFilters, now: Date): Promise<TrendResult> {
  const db = await getDb();
  const { from, to, unit } = await trendWindow(viewer, f, now);
  const b = bucketExpr(unit, sales.saleDate);
  const [buckets, data] = await Promise.all([
    makeBuckets(unit, from, to),
    db.select({ bucket: b, brandId: sales.brandId, v: sum(sales.total) }).from(sales).where(and(saleConds(viewer, f, { range: false }), inRange(sales.saleDate, { from, to }))).groupBy(b, sales.brandId),
  ]);
  const brandIds = brandFilter(viewer, f.brand).filter((x) => x !== "__none__");
  return { unit, buckets, brandIds, rows: pivot(buckets, data.map((d) => ({ bucket: d.bucket, brandId: d.brandId, v: c(d.v) / 100 })), brandIds) };
}

/* ---------------------------------------------------------- breakdowns */

export async function revenueByBrand(viewer: Viewer, f: MetricFilters) {
  const db = await getDb();
  const [gross, coll, out] = await Promise.all([
    db.select({ brandId: sales.brandId, v: sum(sales.total), n: count() }).from(sales).where(saleConds(viewer, f)).groupBy(sales.brandId),
    db
      .select({ brandId: transactions.brandId, v: sum(transactions.amount) })
      .from(transactions)
      .where(and(txnConds(viewer, f), eq(transactions.type, "payment"), eq(transactions.status, "succeeded")))
      .groupBy(transactions.brandId),
    db
      .select({ brandId: invoices.brandId, v: sql<string>`sum(${invoiceBalance})` })
      .from(invoices)
      .where(and(invoiceConds(viewer, f), inArray(invoices.status, [...OPEN_INVOICE_STATUSES])))
      .groupBy(invoices.brandId),
  ]);
  return brandFilter(viewer, f.brand)
    .filter((x) => x !== "__none__")
    .map((brandId) => ({
      brandId,
      grossCents: c(gross.find((g) => g.brandId === brandId)?.v),
      salesCount: gross.find((g) => g.brandId === brandId)?.n ?? 0,
      collectedCents: c(coll.find((g) => g.brandId === brandId)?.v),
      outstandingCents: c(out.find((g) => g.brandId === brandId)?.v),
    }));
}


/* ------------------------------------------------------- brand performance */

/* ------------------------------------------------------------ link helpers */

/** Query string reproducing the dashboard filters on a list page (ranges are always explicit). */
export function filterQuery(f: MetricFilters, extra: Record<string, string | null | undefined> = {}) {
  const p = new URLSearchParams();
  p.set("range", f.range);
  if (f.range === "custom") {
    if (f.from) p.set("from", fmtD(f.from, "yyyy-MM-dd"));
    if (f.to) p.set("to", fmtD(f.to, "yyyy-MM-dd"));
  }
  if (f.brand) p.set("brand", f.brand);
  if (f.agent) p.set("agent", f.agent);
  if (f.entity) p.set("entity", f.entity);
  for (const [k, v] of Object.entries(extra)) {
    if (v) p.set(k, v);
    else p.delete(k);
  }
  return `?${p.toString()}`;
}
