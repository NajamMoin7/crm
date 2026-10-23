import "server-only";
import type { Document, Filter } from "mongodb";
import { format as fmtD, subMonths } from "date-fns";
import { getDb, type RowOf } from "@/lib/db";
import { decStr, ids, sumDec } from "@/lib/db/query";
import { brandFilter, resolveBrand, scopeCases, scopeCustomers, scopeInvoices, scopeSales, scopeTransactions } from "@/lib/auth/scope";
import { can, canAccessEntity, type Viewer } from "@/lib/auth/viewer";
import { parseFilters, type ListFilters, type RawSearchParams } from "@/lib/filters";
import { toCents } from "@/lib/money";
import { CASE_OPEN_STATUSES } from "@/lib/domain/vocab";
import { getAgents } from "@/lib/data/reference";

/**
 * Executive metrics. Every number is computed in the database from the
 * underlying records and composed with the record-level scope filters, so a
 * user only ever aggregates data they are allowed to see.
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

/** `{ field: { $gte: from, $lte: to } }`, or `{}` for an open range. */
export function inRange(field: string, f: Pick<MetricFilters, "from" | "to">): Document {
  if (!f.from && !f.to) return {};
  return { [field]: { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) } };
}

/** `$and` of the non-empty conditions. */
export function all<T>(...conds: (Filter<T> | Document | undefined | null | false)[]): Filter<T> {
  const list = conds.filter((c): c is Document => !!c && Object.keys(c).length > 0);
  return (list.length ? { $and: list } : {}) as Filter<T>;
}

async function invoiceIdsWhere(filter: Filter<RowOf<"invoices">>) {
  const C = await getDb();
  return ids(await C.invoices.distinct("id", filter));
}

/* ------------------------------------------------------- condition builders */

export async function saleConds(viewer: Viewer, f: MetricFilters, opts: { range?: boolean; status?: boolean } = {}): Promise<Filter<RowOf<"sales">>> {
  const C = await getDb();
  return all<RowOf<"sales">>(
    scopeSales(viewer, f.brand),
    { status: { $ne: "cancelled" } },
    f.agent ? { agentId: f.agent } : undefined,
    f.entity ? { legalEntityId: f.entity } : undefined,
    f.customer ? { customerId: f.customer } : undefined,
    opts.status !== false && isInvoiceStatus(f.status) ? { id: { $in: ids(await C.invoices.distinct("saleId", { status: f.status })) } } : undefined,
    opts.range === false ? undefined : inRange("saleDate", f),
  );
}

export function invoiceConds(viewer: Viewer, f: MetricFilters, opts: { range?: boolean; status?: boolean } = {}): Filter<RowOf<"invoices">> {
  return all<RowOf<"invoices">>(
    scopeInvoices(viewer, f.brand),
    f.agent ? { agentId: f.agent } : undefined,
    f.entity ? { legalEntityId: f.entity } : undefined,
    f.customer ? { customerId: f.customer } : undefined,
    opts.status !== false && isInvoiceStatus(f.status) ? { status: f.status } : undefined,
    opts.range === false ? undefined : inRange("billingDate", f),
  );
}

/** Ledger rows. Agent / invoice-status filters (and own-only billing scope) apply through the linked invoice. */
export async function txnConds(viewer: Viewer, f: MetricFilters, opts: { range?: boolean } = {}): Promise<Filter<RowOf<"transactions">>> {
  return all<RowOf<"transactions">>(
    scopeTransactions(viewer, f.brand),
    f.entity ? { legalEntityId: f.entity } : undefined,
    f.customer ? { customerId: f.customer } : undefined,
    f.agent ? { invoiceId: { $in: await invoiceIdsWhere({ agentId: f.agent }) } } : undefined,
    !can(viewer, "billing.view_all") ? { invoiceId: { $in: await invoiceIdsWhere({ agentId: viewer.id }) } } : undefined,
    isInvoiceStatus(f.status) ? { invoiceId: { $in: await invoiceIdsWhere({ status: f.status }) } } : undefined,
    opts.range === false ? undefined : inRange("occurredAt", f),
  );
}

/** Customer chargeback cases only (intercompany recharges are a separate type and never counted here). */
export async function caseConds(
  viewer: Viewer,
  f: MetricFilters,
  opts: { range?: boolean; type?: "chargeback" | "intercompany_recharge" | "any" } = {},
): Promise<Filter<RowOf<"chargebackCases">>> {
  const type = opts.type ?? "chargeback";
  return all<RowOf<"chargebackCases">>(
    scopeCases(viewer, f.brand),
    type === "any" ? undefined : { caseType: type },
    f.entity ? { $or: [{ originalLegalEntityId: f.entity }, { responsibleLegalEntityId: f.entity }] } : undefined,
    f.customer ? { customerId: f.customer } : undefined,
    f.agent ? { invoiceId: { $in: await invoiceIdsWhere({ agentId: f.agent }) } } : undefined,
    isInvoiceStatus(f.status) ? { invoiceId: { $in: await invoiceIdsWhere({ status: f.status }) } } : undefined,
    opts.range === false ? undefined : inRange("requestDate", f),
  );
}

export async function customerConds(viewer: Viewer, f: MetricFilters): Promise<Filter<RowOf<"customers">>> {
  const C = await getDb();
  return all<RowOf<"customers">>(
    await scopeCustomers(viewer, f.brand),
    f.agent ? { assignedAgentId: f.agent } : undefined,
    f.customer ? { id: f.customer } : undefined,
    f.entity ? { id: { $in: ids(await C.sales.distinct("customerId", { legalEntityId: f.entity })) } } : undefined,
  );
}

/**
 * Pipeline stages adding `balance` (Decimal128) to invoice documents:
 * greatest(total − amount paid − approved adjustments, 0).
 */
export function invoiceBalanceStages(): Document[] {
  return [
    {
      $lookup: {
        from: "financial_adjustments",
        let: { inv: "$id" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$invoiceId", "$$inv"] }, { $eq: ["$status", "approved"] }] } } },
          { $group: { _id: null, v: sumDec("$amount") } },
        ],
        as: "_adj",
      },
    },
    {
      $addFields: {
        adjusted: { $ifNull: [{ $first: "$_adj.v" }, { $toDecimal: "0" }] },
      },
    },
    {
      $addFields: {
        balance: {
          $max: [{ $subtract: [{ $subtract: [{ $toDecimal: "$total" }, { $toDecimal: "$amountPaid" }] }, "$adjusted"] }, { $toDecimal: "0" }],
        },
      },
    },
    { $project: { _adj: 0 } },
  ];
}

const c = (v: unknown) => toCents(decStr(v));

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

type Agg = { _id: unknown; n: number; v?: unknown };
const first = <T>(rows: T[]) => rows[0];

export async function getKpis(viewer: Viewer, f: MetricFilters): Promise<Kpis> {
  const C = await getDb();
  const [cust, sc, tc0, cc] = await Promise.all([customerConds(viewer, f), saleConds(viewer, f), txnConds(viewer, f), caseConds(viewer, f)]);
  const ic = invoiceConds(viewer, f);
  const open = [...CASE_OPEN_STATUSES] as string[];
  const [tc, nc, s, p, o, pend, cb, agentIds, agents, bl] = await Promise.all([
    C.customers.countDocuments(cust),
    C.customers.countDocuments(all(cust, inRange("createdAt", f))),
    C.sales.aggregate<Agg>([{ $match: sc }, { $group: { _id: null, n: { $sum: 1 }, v: sumDec("$total") } }]).toArray().then(first),
    C.transactions
      .aggregate<Agg>([{ $match: all(tc0, { type: "payment", status: "succeeded" }) }, { $group: { _id: null, n: { $sum: 1 }, v: sumDec("$amount") } }])
      .toArray()
      .then(first),
    C.invoices
      .aggregate<Agg>([
        { $match: all(ic, { status: { $in: [...OPEN_INVOICE_STATUSES] } }) },
        ...invoiceBalanceStages(),
        { $group: { _id: null, n: { $sum: 1 }, v: { $sum: "$balance" } } },
      ])
      .toArray()
      .then(first),
    C.invoices.aggregate<Agg>([{ $match: all(ic, { status: { $in: ["draft", "pending"] } }) }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    C.chargebackCases
      .aggregate<{ n: number; open: number; completed: number; completedAmt: unknown; openAmt: unknown }>([
        { $match: cc },
        {
          $group: {
            _id: null,
            n: { $sum: 1 },
            open: { $sum: { $cond: [{ $in: ["$status", open] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            completedAmt: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, { $toDecimal: "$amount" }, { $toDecimal: "0" }] } },
            openAmt: { $sum: { $cond: [{ $in: ["$status", open] }, { $toDecimal: "$amount" }, { $toDecimal: "0" }] } },
          },
        },
      ])
      .toArray()
      .then(first),
    C.sales.distinct("agentId", sc),
    getAgents(),
    // Billed = issued invoices (not draft, not cancelled) billed in range.
    C.invoices
      .aggregate<Agg>([{ $match: all(ic, { status: { $nin: ["draft", "cancelled"] } }) }, { $group: { _id: null, n: { $sum: 1 }, v: sumDec("$total") } }])
      .toArray()
      .then(first),
  ]);
  const brands = brandFilter(viewer, f.brand);
  const pool = agents.filter((a) => a.status === "active" && a.brandIds.some((b) => brands.includes(b)) && (!f.agent || a.id === f.agent));
  const pd = pend.find((r) => r._id === "draft")?.n ?? 0;
  const pp = pend.find((r) => r._id === "pending")?.n ?? 0;
  return {
    totalCustomers: tc,
    newCustomers: nc,
    salesCount: s?.n ?? 0,
    grossCents: c(s?.v),
    collectedCents: c(p?.v),
    paymentsCount: p?.n ?? 0,
    outstandingCents: c(o?.v),
    outstandingCount: o?.n ?? 0,
    pendingBilling: pd + pp,
    billedCents: c(bl?.v),
    invoiceCount: bl?.n ?? 0,
    pendingDraft: pd,
    pendingPending: pp,
    cbCases: cb?.n ?? 0,
    cbOpen: cb?.open ?? 0,
    cbCompleted: cb?.completed ?? 0,
    cbCompletedCents: c(cb?.completedAmt),
    cbOpenCents: c(cb?.openAmt),
    activeAgents: agentIds.length,
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

/** Bucket key (YYYY-MM-DD of the UTC period start; weeks start on Monday) — matches `bucketExpr`. */
function truncUtc(d: Date, unit: Unit) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), unit === "month" ? 1 : d.getUTCDate()));
  if (unit === "week") t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t;
}

const bucketExpr = (unit: Unit, field: string) => ({
  $dateToString: {
    format: "%Y-%m-%d",
    date: { $dateTrunc: { date: `$${field}`, unit, timezone: "UTC", ...(unit === "week" ? { startOfWeek: "monday" } : {}) } },
    timezone: "UTC",
  },
});

function labelFor(key: string, unit: Unit) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return unit === "month" ? fmtD(date, "MMM yy") : fmtD(date, "MMM d");
}

function makeBuckets(unit: Unit, from: Date, to: Date): Bucket[] {
  const out: Bucket[] = [];
  for (let b = truncUtc(from, unit); b <= to && out.length < 1000; ) {
    const key = b.toISOString().slice(0, 10);
    out.push({ key, label: labelFor(key, unit) });
    b = new Date(b);
    if (unit === "day") b.setUTCDate(b.getUTCDate() + 1);
    else if (unit === "week") b.setUTCDate(b.getUTCDate() + 7);
    else b.setUTCMonth(b.getUTCMonth() + 1);
  }
  return out;
}

/** Effective window for trend charts: for "All time" start at the earliest scoped sale. */
async function trendWindow(viewer: Viewer, f: MetricFilters, now: Date) {
  let from = f.from;
  if (!from) {
    const C = await getDb();
    const firstSale = await C.sales.findOne(await saleConds(viewer, f, { range: false }), { sort: { saleDate: 1 }, projection: { saleDate: 1 } });
    from = firstSale?.saleDate ? new Date(firstSale.saleDate) : subMonths(now, 12);
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
  const C = await getDb();
  const { from, to, unit } = await trendWindow(viewer, f, now);
  const buckets = makeBuckets(unit, from, to);
  const data = await C.sales
    .aggregate<{ _id: { bucket: string; brandId: string }; v: unknown }>([
      { $match: all(await saleConds(viewer, f, { range: false }), inRange("saleDate", { from, to })) },
      { $group: { _id: { bucket: bucketExpr(unit, "saleDate"), brandId: "$brandId" }, v: sumDec("$total") } },
    ])
    .toArray();
  const brandIds = brandFilter(viewer, f.brand).filter((x) => x !== "__none__");
  return { unit, buckets, brandIds, rows: pivot(buckets, data.map((d) => ({ bucket: d._id.bucket, brandId: d._id.brandId, v: c(d.v) / 100 })), brandIds) };
}

/* ---------------------------------------------------------- breakdowns */

export async function revenueByBrand(viewer: Viewer, f: MetricFilters) {
  const C = await getDb();
  const [sc, tc] = await Promise.all([saleConds(viewer, f), txnConds(viewer, f)]);
  const [gross, coll, out] = await Promise.all([
    C.sales.aggregate<Agg>([{ $match: sc }, { $group: { _id: "$brandId", v: sumDec("$total"), n: { $sum: 1 } } }]).toArray(),
    C.transactions
      .aggregate<Agg>([{ $match: all(tc, { type: "payment", status: "succeeded" }) }, { $group: { _id: "$brandId", v: sumDec("$amount"), n: { $sum: 1 } } }])
      .toArray(),
    C.invoices
      .aggregate<Agg>([
        { $match: all(invoiceConds(viewer, f), { status: { $in: [...OPEN_INVOICE_STATUSES] } }) },
        ...invoiceBalanceStages(),
        { $group: { _id: "$brandId", v: { $sum: "$balance" }, n: { $sum: 1 } } },
      ])
      .toArray(),
  ]);
  return brandFilter(viewer, f.brand)
    .filter((x) => x !== "__none__")
    .map((brandId) => ({
      brandId,
      grossCents: c(gross.find((g) => g._id === brandId)?.v),
      salesCount: gross.find((g) => g._id === brandId)?.n ?? 0,
      collectedCents: c(coll.find((g) => g._id === brandId)?.v),
      outstandingCents: c(out.find((g) => g._id === brandId)?.v),
    }));
}

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
