import "server-only";
import type { Filter } from "mongodb";
import { getDb, type RowOf } from "@/lib/db";
import { contains, decStr, ids, sumDec, uniq } from "@/lib/db/query";
import { brandFilter, scopeSales } from "@/lib/auth/scope";
import { can, type Viewer } from "@/lib/auth/viewer";
import type { Permission } from "@/lib/domain/permissions";
import type { ListFilters } from "@/lib/filters";
import { fromCents, toCents } from "@/lib/money";
import { maskReference } from "@/lib/mask";
import { CASE_OPEN_STATUSES, CASE_STATUS, INVOICE_STATUS } from "@/lib/domain/vocab";
import type { CsvColumn, CsvValue } from "@/lib/csv";
import { getAgents } from "@/lib/data/reference";
import { customerListWhere, listDuplicateCandidates } from "@/lib/data/customers";
import { salesListWhere } from "@/lib/data/sales";
import { invoiceListWhere } from "@/lib/data/billing";
import { transactionWhere } from "@/lib/data/transactions";
import { listCases, type CaseQueue } from "@/lib/data/chargebacks";
import { all, caseConds, inRange, invoiceBalanceStages, invoiceConds, OPEN_INVOICE_STATUSES, saleConds, txnConds } from "@/lib/data/metrics";

/** Hard cap for exports and report queries. */
export const MAX_ROWS = 10_000;
/** Rows rendered on screen (the CSV export carries the rest). */
export const SCREEN_ROWS = 500;

/* ================================================================ model */

export type ColKind = "text" | "id" | "money" | "number" | "percent" | "date" | "datetime" | "brand";
export type ReportColumn = {
  key: string;
  label: string;
  kind?: ColKind;
  /** Link the cell: `${prefix}${row[key ?? column.key]}`. */
  href?: { prefix: string; key?: string };
  /** Display vocabulary for status-like columns. */
  vocab?: Record<string, { label: string }>;
  /** Hidden on narrow screens. */
  secondary?: boolean;
};
export type Cell = string | number | Date | null;
export type ReportRow = Record<string, Cell>;
export type ReportSummary = { label: string; value: string | number; kind?: ColKind; hint?: string };
export type ReportResult = { summary: ReportSummary[]; columns: ReportColumn[]; rows: ReportRow[]; total: number; truncated: boolean; note?: string };

export type ReportFilter = "range" | "brand" | "agent" | "customer" | "type" | "status";
export type ReportDef = {
  key: string;
  title: string;
  description: string;
  group: "Sales" | "Billing & collections" | "Recharge / Chargeback" | "Data quality & integrations";
  financial: boolean;
  /** Extra permissions on top of reports.view (+ reports.financial when financial). */
  requires?: Permission[];
  filters: ReportFilter[];
  defaultRange: string;
  statusOptions?: { value: string; label: string }[];
  statusLabel?: string;
  typeOptions?: { value: string; label: string }[];
  typeLabel?: string;
  defaultStatus?: string;
};

const opts = (m: Record<string, { label: string }>) => Object.entries(m).map(([value, v]) => ({ value, label: v.label }));

export const REPORTS: ReportDef[] = [
  {
    key: "consolidated-sales", title: "Consolidated sales", group: "Sales", financial: false, defaultRange: "30d",
    description: "Every sale across all authorised brands with customer, agent and status.",
    filters: ["range", "brand", "agent", "customer", "status"], statusLabel: "Sale status",
    statusOptions: [{ value: "open", label: "Open" }, { value: "completed", label: "Completed" }, { value: "cancelled", label: "Cancelled" }],
  },
  {
    key: "brand-sales", title: "Brand-wise sales", group: "Sales", financial: false, defaultRange: "30d",
    description: "Sales count, gross, discounts, tax, collected and outstanding per brand.",
    filters: ["range", "brand", "agent"],
  },
  {
    key: "agent-performance", title: "Sales agent performance", group: "Sales", financial: false, defaultRange: "30d", requires: ["agents.view"],
    description: "Sales, gross, average deal, collected payments, target attainment and chargebacks per agent.",
    filters: ["range", "brand", "agent"],
  },
  {
    key: "billing-collection", title: "Billing & collection status", group: "Billing & collections", financial: true, defaultRange: "30d",
    description: "Invoices billed per brand and status with amounts billed, collected and still due.",
    filters: ["range", "brand", "agent", "customer", "status"], statusLabel: "Invoice status", statusOptions: opts(INVOICE_STATUS),
  },
  {
    key: "outstanding-aging", title: "Outstanding balances (aging)", group: "Billing & collections", financial: true, defaultRange: "all",
    description: "Open invoice balances aged by days past due date: 0–30, 31–60, 61–90 and 90+.",
    filters: ["range", "brand", "agent", "customer"],
  },
  {
    key: "chargeback-cases", title: "Chargeback cases", group: "Recharge / Chargeback", financial: true, defaultRange: "90d", requires: ["chargebacks.view"],
    description: "Customer chargeback cases with status, reason and the agent whose order it was.",
    filters: ["range", "brand", "agent", "customer", "status"], statusLabel: "Case status", statusOptions: opts(CASE_STATUS),
  },
  {
    key: "recharge-status", title: "Recharge request status", group: "Recharge / Chargeback", financial: true, defaultRange: "90d", requires: ["chargebacks.view"],
    description: "Requests by type and workflow status. Intercompany recharges are listed separately and are never revenue.",
    filters: ["range", "brand", "type"], typeLabel: "Case type",
    typeOptions: [{ value: "chargeback", label: "Recharge / Chargeback" }, { value: "intercompany_recharge", label: "Intercompany recharge" }],
  },
  {
    key: "duplicate-review", title: "Duplicate customer review", group: "Data quality & integrations", financial: false, defaultRange: "all", requires: ["customers.view"],
    description: "Possible duplicate customer pairs detected by the system, agents or imports.",
    filters: ["status"], statusLabel: "Review status", defaultStatus: "open",
    statusOptions: [{ value: "open", label: "Open" }, { value: "dismissed", label: "Dismissed" }, { value: "merged", label: "Merged" }],
  },
];

export function getReportDef(key: string | null | undefined) {
  return REPORTS.find((r) => r.key === key) ?? null;
}

export function canRunReport(viewer: Viewer, def: ReportDef) {
  return can(viewer, "reports.view", ...(def.financial ? (["reports.financial"] as Permission[]) : []), ...(def.requires ?? []));
}

/* ============================================================ helpers */

const c = (v: unknown) => toCents(decStr(v));
const NONE = "__none__";
const validStatus = (def: ReportDef, s: string | null) => (s && def.statusOptions?.some((o) => o.value === s) ? s : null);
const validType = (def: ReportDef, t: string | null) => (t && def.typeOptions?.some((o) => o.value === t) ? t : null);
const brandsOf = (viewer: Viewer, f: ListFilters) => brandFilter(viewer, f.brand).filter((b) => b !== NONE);
function finish(rows: ReportRow[], columns: ReportColumn[], summary: ReportSummary[], note?: string): ReportResult {
  return { summary, columns, rows: rows.slice(0, MAX_ROWS), total: Math.min(rows.length, MAX_ROWS), truncated: rows.length > MAX_ROWS, note };
}
const sumKey = (rows: ReportRow[], key: string) => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);

/* ============================================================ reports */

type G<K> = { _id: K; n: number; v?: unknown };

async function namesOf(key: "users" | "customers", list: (string | null | undefined)[]) {
  const C = await getDb();
  const idList = ids(uniq(list));
  if (key === "users") {
    const rows = await C.users.find({ id: { $in: idList } }, { projection: { id: 1, name: 1 } }).toArray();
    return new Map(rows.map((r) => [r.id, r.name]));
  }
  const rows = await C.customers.find({ id: { $in: idList } }, { projection: { id: 1, fullName: 1 } }).toArray();
  return new Map(rows.map((r) => [r.id, r.fullName]));
}

const lookupInvoice = [
  { $lookup: { from: "invoices", localField: "invoiceId", foreignField: "id", as: "_inv" } },
  { $unwind: "$_inv" },
];

export async function runReport(viewer: Viewer, def: ReportDef, f: ListFilters, now: Date): Promise<ReportResult> {
  const C = await getDb();
  const status = f.status === "all" ? null : (validStatus(def, f.status) ?? def.defaultStatus ?? null);
  const type = validType(def, f.type);
  // Metric helpers treat `status` as an invoice status; strip it where the report uses another vocabulary.
  const mf: ListFilters = { ...f, status: def.key === "billing-collection" ? status : null };

  switch (def.key) {
    case "consolidated-sales": {
      const list = await C.sales
        .find(
          all<RowOf<"sales">>(
            scopeSales(viewer, f.brand),
            f.agent ? { agentId: f.agent } : undefined,
            f.entity ? { legalEntityId: f.entity } : undefined,
            f.customer ? { customerId: f.customer } : undefined,
            status ? { status: status as never } : undefined,
            inRange("saleDate", f),
          ),
          { sort: { saleDate: -1, id: -1 }, limit: MAX_ROWS + 1 },
        )
        .toArray();
      const [cust, agents] = await Promise.all([namesOf("customers", list.map((r) => r.customerId)), namesOf("users", list.map((r) => r.agentId))]);
      const out: ReportRow[] = list
        .filter((r) => cust.has(r.customerId) && agents.has(r.agentId))
        .map((r) => ({
          id: r.id, saleDate: r.saleDate, brandId: r.brandId, customerId: r.customerId, customerName: cust.get(r.customerId) ?? null,
          agentName: agents.get(r.agentId) ?? null, legalEntityId: r.legalEntityId, status: r.status,
          subtotal: c(r.subtotal), discount: c(r.discount), tax: c(r.tax), total: c(r.total), currency: r.currency,
        }));
      const live = out.filter((r) => r.status !== "cancelled");
      return finish(
        out,
        [
          { key: "id", label: "Sale", kind: "id", href: { prefix: "/sales/" } },
          { key: "saleDate", label: "Date", kind: "date" },
          { key: "brandId", label: "Brand", kind: "brand" },
          { key: "customerName", label: "Customer", href: { prefix: "/customers/", key: "customerId" } },
          { key: "customerId", label: "Customer ID", kind: "id", secondary: true },
          { key: "agentName", label: "Agent", secondary: true },
          { key: "status", label: "Status", vocab: { open: { label: "Open" }, completed: { label: "Completed" }, cancelled: { label: "Cancelled" } } },
          { key: "subtotal", label: "Subtotal", kind: "money", secondary: true },
          { key: "discount", label: "Discount", kind: "money", secondary: true },
          { key: "tax", label: "Tax", kind: "money", secondary: true },
          { key: "total", label: "Total", kind: "money" },
        ],
        [
          { label: "Sales (non-cancelled)", value: live.length, kind: "number" },
          { label: "Gross sales", value: sumKey(live, "total"), kind: "money" },
          { label: "Average sale", value: live.length ? Math.round(sumKey(live, "total") / live.length) : 0, kind: "money" },
          { label: "Cancelled", value: out.length - live.length, kind: "number", hint: "Excluded from gross" },
        ],
      );
    }

    case "brand-sales": {
      const brandIds = brandsOf(viewer, f);
      const [sc, tc] = await Promise.all([saleConds(viewer, mf), txnConds(viewer, mf)]);
      const [s, p, r, o, cust, brandRows] = await Promise.all([
        C.sales
          .aggregate<G<string> & { gross: unknown; discount: unknown; tax: unknown }>([
            { $match: sc },
            { $group: { _id: "$brandId", n: { $sum: 1 }, gross: sumDec("$total"), discount: sumDec("$discount"), tax: sumDec("$tax") } },
          ])
          .toArray(),
        C.transactions.aggregate<G<string>>([{ $match: all(tc, { type: "payment", status: "succeeded" }) }, { $group: { _id: "$brandId", n: { $sum: 1 }, v: sumDec("$amount") } }]).toArray(),
        C.transactions.aggregate<G<string>>([{ $match: all(tc, { type: "refund", status: "succeeded" }) }, { $group: { _id: "$brandId", n: { $sum: 1 }, v: sumDec("$amount") } }]).toArray(),
        C.invoices
          .aggregate<G<string>>([
            { $match: all(invoiceConds(viewer, mf), { status: { $in: [...OPEN_INVOICE_STATUSES] } }) },
            ...invoiceBalanceStages(),
            { $group: { _id: "$brandId", n: { $sum: 1 }, v: { $sum: "$balance" } } },
          ])
          .toArray(),
        C.sales.aggregate<{ _id: string; c: string[] }>([{ $match: sc }, { $group: { _id: "$brandId", c: { $addToSet: "$customerId" } } }]).toArray(),
        C.brands.find({ id: { $in: ids(brandIds) } }, { projection: { id: 1, name: 1 } }).toArray(),
      ]);
      const rows: ReportRow[] = brandIds.map((id) => {
        const x = s.find((q) => q._id === id);
        return {
          brandId: id, brandName: brandRows.find((b) => b.id === id)?.name ?? id, sales: x?.n ?? 0, customers: cust.find((q) => q._id === id)?.c.length ?? 0,
          gross: c(x?.gross), discount: c(x?.discount), tax: c(x?.tax), avg: x?.n ? Math.round(c(x.gross) / x.n) : 0,
          collected: c(p.find((q) => q._id === id)?.v), refunds: c(r.find((q) => q._id === id)?.v), outstanding: c(o.find((q) => q._id === id)?.v),
        };
      });
      return finish(
        rows,
        [
          { key: "brandId", label: "Brand", kind: "brand" },
          { key: "sales", label: "Sales", kind: "number" },
          { key: "customers", label: "Customers", kind: "number", secondary: true },
          { key: "gross", label: "Gross sales", kind: "money" },
          { key: "discount", label: "Discounts", kind: "money", secondary: true },
          { key: "tax", label: "Tax", kind: "money", secondary: true },
          { key: "avg", label: "Avg sale", kind: "money", secondary: true },
          { key: "collected", label: "Collected", kind: "money" },
          { key: "refunds", label: "Refunds", kind: "money", secondary: true },
          { key: "outstanding", label: "Outstanding", kind: "money" },
        ],
        [
          { label: "Gross sales", value: sumKey(rows, "gross"), kind: "money" },
          { label: "Collected", value: sumKey(rows, "collected"), kind: "money" },
          { label: "Refunds", value: sumKey(rows, "refunds"), kind: "money", hint: "Shown separately, not netted" },
          { label: "Outstanding", value: sumKey(rows, "outstanding"), kind: "money" },
        ],
        "Gross sales are by sale date; collected and refunds by ledger date; outstanding covers open invoices billed in the range.",
      );
    }

    case "agent-performance": {
      const brandIds = brandsOf(viewer, f);
      const agentWhere = { ...mf, agent: null };
      const [sc, tc, cc] = await Promise.all([saleConds(viewer, agentWhere), txnConds(viewer, agentWhere), caseConds(viewer, agentWhere)]);
      const [agents, s, p, cb] = await Promise.all([
        getAgents(),
        C.sales.aggregate<G<string> & { gross: unknown }>([{ $match: sc }, { $group: { _id: "$agentId", n: { $sum: 1 }, gross: sumDec("$total") } }]).toArray(),
        C.transactions
          .aggregate<G<string>>([
            { $match: all(tc, { type: "payment", status: "succeeded" }) },
            ...lookupInvoice,
            { $group: { _id: "$_inv.agentId", n: { $sum: 1 }, v: sumDec("$amount") } },
          ])
          .toArray(),
        C.chargebackCases
          .aggregate<G<string> & { completed: unknown }>([
            { $match: cc },
            ...lookupInvoice,
            {
              $group: {
                _id: "$_inv.agentId",
                n: { $sum: 1 },
                completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, { $toDecimal: "$amount" }, { $toDecimal: "0" }] } },
              },
            },
          ])
          .toArray(),
      ]);
      const days = f.from ? Math.max(1, ((f.to ?? now).getTime() - f.from.getTime()) / 86_400_000) : null;
      const pool = agents.filter((a) => a.brandIds.some((b) => brandIds.includes(b)) && (!f.agent || a.id === f.agent) && (can(viewer, "sales.view_all") || a.id === viewer.id));
      const rows: ReportRow[] = pool
        .map((a) => {
          const x = s.find((q) => q._id === a.id);
          const gross = c(x?.gross);
          const target = days ? Math.round((c(a.monthlyTarget) * days) / 30.44) : null;
          const k = cb.find((q) => q._id === a.id);
          return {
            agentId: a.id, name: a.name, code: a.agentCode, team: a.team, status: a.status, sales: x?.n ?? 0, gross,
            avg: x?.n ? Math.round(gross / x.n) : 0, collected: c(p.find((q) => q._id === a.id)?.v), target,
            attainment: target ? gross / target : null, cbCases: k?.n ?? 0, cbCompleted: c(k?.completed),
          };
        })
        .sort((a, b) => Number(b.gross) - Number(a.gross));
      return finish(
        rows,
        [
          { key: "name", label: "Agent", href: { prefix: "/admin/agents/", key: "agentId" } },
          { key: "code", label: "Code", kind: "id", secondary: true },
          { key: "team", label: "Team", secondary: true },
          { key: "sales", label: "Sales", kind: "number" },
          { key: "gross", label: "Gross", kind: "money" },
          { key: "avg", label: "Avg deal", kind: "money", secondary: true },
          { key: "collected", label: "Collected", kind: "money", secondary: true },
          { key: "target", label: "Target (period)", kind: "money", secondary: true },
          { key: "attainment", label: "Attainment", kind: "percent" },
          { key: "cbCases", label: "Chargeback cases", kind: "number", secondary: true },
          { key: "cbCompleted", label: "Chargebacks completed", kind: "money", secondary: true },
        ],
        [
          { label: "Agents", value: rows.length, kind: "number" },
          { label: "With sales", value: rows.filter((r) => Number(r.sales) > 0).length, kind: "number" },
          { label: "Gross sales", value: sumKey(rows, "gross"), kind: "money" },
          { label: "Collected on their invoices", value: sumKey(rows, "collected"), kind: "money" },
        ],
        days ? "Target for the period = monthly target × days in range ÷ 30.44." : "Select a bounded date range to compute target attainment.",
      );
    }

    case "billing-collection": {
      const rows = await C.invoices
        .aggregate<{ _id: { brandId: string; status: string }; n: number; billed: unknown; paid: unknown; due: unknown }>([
          { $match: invoiceConds(viewer, mf) },
          ...invoiceBalanceStages(),
          {
            $group: {
              _id: { brandId: "$brandId", status: "$status" },
              n: { $sum: 1 },
              billed: sumDec("$total"),
              paid: sumDec("$amountPaid"),
              due: { $sum: { $cond: [{ $in: ["$status", [...OPEN_INVOICE_STATUSES]] }, "$balance", { $toDecimal: "0" }] } },
            },
          },
          { $sort: { "_id.brandId": 1, "_id.status": 1 } },
        ])
        .toArray();
      const out: ReportRow[] = rows.map((r) => ({ brandId: r._id.brandId, status: r._id.status, count: r.n, billed: c(r.billed), paid: c(r.paid), due: c(r.due) }));
      const billed = sumKey(out.filter((r) => r.status !== "draft" && r.status !== "cancelled"), "billed");
      return finish(
        out,
        [
          { key: "brandId", label: "Brand", kind: "brand" },
          { key: "status", label: "Status", vocab: INVOICE_STATUS },
          { key: "count", label: "Invoices", kind: "number" },
          { key: "billed", label: "Billed", kind: "money" },
          { key: "paid", label: "Amount paid", kind: "money" },
          { key: "due", label: "Balance due", kind: "money" },
        ],
        [
          { label: "Invoices", value: sumKey(out, "count"), kind: "number" },
          { label: "Billed (issued)", value: billed, kind: "money", hint: "Excl. draft & cancelled" },
          { label: "Amount paid", value: sumKey(out, "paid"), kind: "money", hint: "Net of refunds" },
          { label: "Balance due", value: sumKey(out, "due"), kind: "money", hint: "After approved adjustments" },
          { label: "Collection rate", value: billed ? `${((sumKey(out, "paid") / billed) * 100).toFixed(1)}%` : "—" },
        ],
      );
    }

    case "outstanding-aging": {
      const list = await C.invoices
        .aggregate<RowOf<"invoices"> & { balance: unknown }>([
          { $match: all(invoiceConds(viewer, { ...mf, status: null }), { status: { $in: [...OPEN_INVOICE_STATUSES] } }) },
          ...invoiceBalanceStages(),
          { $match: { balance: { $gt: { $numberDecimal: "0" } } } },
          { $sort: { dueDate: 1 } },
          { $limit: MAX_ROWS + 1 },
          { $project: { _id: 0 } },
        ])
        .toArray();
      const [cust, agents] = await Promise.all([namesOf("customers", list.map((r) => r.customerId)), namesOf("users", list.map((r) => r.agentId))]);
      const bucket = (d: number) => (d <= 30 ? "0–30" : d <= 60 ? "31–60" : d <= 90 ? "61–90" : "90+");
      const out: ReportRow[] = list
        .filter((r) => cust.has(r.customerId))
        .map((r) => {
          const days = Math.max(0, Math.floor((now.getTime() - new Date(r.dueDate).getTime()) / 86_400_000));
          return {
            id: r.id, invoiceNumber: r.invoiceNumber, brandId: r.brandId, customerId: r.customerId, customerName: cust.get(r.customerId) ?? null,
            agentName: agents.get(r.agentId) ?? null, legalEntityId: r.legalEntityId, status: r.status, billingDate: r.billingDate, dueDate: r.dueDate,
            total: c(r.total), balance: c(r.balance), days, bucket: bucket(days), notDue: r.dueDate > now ? "Not yet due" : "Past due",
          };
        });
      const sumB = (b: string) => sumKey(out.filter((r) => r.bucket === b), "balance");
      const nB = (b: string) => out.filter((r) => r.bucket === b).length;
      return finish(
        out,
        [
          { key: "invoiceNumber", label: "Invoice", kind: "id", href: { prefix: "/billing/", key: "id" } },
          { key: "brandId", label: "Brand", kind: "brand" },
          { key: "customerName", label: "Customer", href: { prefix: "/customers/", key: "customerId" } },
          { key: "agentName", label: "Agent", secondary: true },
          { key: "status", label: "Status", vocab: INVOICE_STATUS },
          { key: "dueDate", label: "Due", kind: "date", secondary: true },
          { key: "days", label: "Days past due", kind: "number" },
          { key: "bucket", label: "Aging bucket" },
          { key: "total", label: "Invoice total", kind: "money", secondary: true },
          { key: "balance", label: "Balance due", kind: "money" },
        ],
        [
          { label: "0–30 days", value: sumB("0–30"), kind: "money", hint: `${nB("0–30")} invoices (incl. not yet due)` },
          { label: "31–60 days", value: sumB("31–60"), kind: "money", hint: `${nB("31–60")} invoices` },
          { label: "61–90 days", value: sumB("61–90"), kind: "money", hint: `${nB("61–90")} invoices` },
          { label: "90+ days", value: sumB("90+"), kind: "money", hint: `${nB("90+")} invoices` },
          { label: "Total outstanding", value: sumKey(out, "balance"), kind: "money" },
        ],
        "Aged by days past the due date as of today. Balance = total − amount paid − approved adjustments. The date range filters by billing date.",
      );
    }

    case "chargeback-cases": {
      const ext = can(viewer, "transactions.view");
      const list = await C.chargebackCases
        .find(all<RowOf<"chargebackCases">>(await caseConds(viewer, mf), status ? { status: status as never } : undefined), { sort: { requestDate: -1 }, limit: MAX_ROWS + 1 })
        .toArray();
      const invs = await C.invoices.find({ id: { $in: ids(list.map((r) => r.invoiceId)) } }, { projection: { id: 1, invoiceNumber: 1, agentId: 1 } }).toArray();
      const [cust, agents] = await Promise.all([namesOf("customers", list.map((r) => r.customerId)), namesOf("users", invs.map((i) => i.agentId))]);
      const out: ReportRow[] = list.flatMap((r) => {
        const inv = invs.find((i) => i.id === r.invoiceId);
        if (!inv || !cust.has(r.customerId)) return [];
        return [
          {
            id: r.id, requestDate: r.requestDate, brandId: r.brandId, customerId: r.customerId, customerName: cust.get(r.customerId) ?? null,
            invoiceId: r.invoiceId, invoiceNumber: inv.invoiceNumber, status: r.status, origin: r.origin, reasonCode: r.reasonCode, amount: c(r.amount),
            agentName: agents.get(inv.agentId) ?? null,
            externalRef: ext ? r.externalProcessorReference : r.externalProcessorReference ? maskReference(r.externalProcessorReference) : null,
            completedAt: r.completedAt,
          },
        ];
      });
      const done = out.filter((r) => r.status === "completed");
      const open = out.filter((r) => (CASE_OPEN_STATUSES as readonly string[]).includes(String(r.status)));
      return finish(
        out,
        [
          { key: "id", label: "Case", kind: "id", href: { prefix: "/recharge/" } },
          { key: "requestDate", label: "Requested", kind: "date" },
          { key: "brandId", label: "Brand", kind: "brand" },
          { key: "customerName", label: "Customer", href: { prefix: "/customers/", key: "customerId" }, secondary: true },
          { key: "invoiceNumber", label: "Invoice", kind: "id", href: { prefix: "/billing/", key: "invoiceId" }, secondary: true },
          { key: "status", label: "Status", vocab: CASE_STATUS },
          { key: "reasonCode", label: "Reason", secondary: true },
          { key: "agentName", label: "Agent" },
          { key: "externalRef", label: "Processor ref", kind: "id", secondary: true },
          { key: "amount", label: "Amount", kind: "money" },
        ],
        [
          { label: "Cases", value: out.length, kind: "number" },
          { label: "Completed amount", value: sumKey(done, "amount"), kind: "money", hint: `${done.length} completed cases` },
          { label: "Open amount (not counted)", value: sumKey(open, "amount"), kind: "money", hint: `${open.length} open cases` },
        ],
        "Customer chargebacks only — intercompany recharges are in the Recharge request status report.",
      );
    }

    case "recharge-status": {
      const grouped = await C.chargebackCases
        .aggregate<{ _id: { caseType: string; status: string }; n: number; amt: unknown }>([
          { $match: all<RowOf<"chargebackCases">>(await caseConds(viewer, mf, { type: "any" }), type ? { caseType: type as never } : undefined) },
          { $group: { _id: { caseType: "$caseType", status: "$status" }, n: { $sum: 1 }, amt: sumDec("$amount") } },
          { $sort: { "_id.caseType": 1, "_id.status": 1 } },
        ])
        .toArray();
      const rows = grouped.map((g) => ({ caseType: g._id.caseType, status: g._id.status, n: g.n, amt: decStr(g.amt) }));
      const out: ReportRow[] = rows.map((r) => ({
        caseType: r.caseType === "chargeback" ? "Recharge / Chargeback" : "Intercompany recharge", status: r.status, count: r.n, amount: c(r.amt),
      }));
      const ofType = (t: string) => rows.filter((r) => r.caseType === t);
      const cnt = (t: string) => ofType(t).reduce((a, r) => a + r.n, 0);
      const done = (t: string) => c(ofType(t).find((r) => r.status === "completed")?.amt);
      return finish(
        out,
        [
          { key: "caseType", label: "Type" },
          { key: "status", label: "Status", vocab: CASE_STATUS },
          { key: "count", label: "Requests", kind: "number" },
          { key: "amount", label: "Amount", kind: "money" },
        ],
        [
          { label: "Chargeback requests", value: cnt("chargeback"), kind: "number" },
          { label: "Completed chargebacks", value: done("chargeback"), kind: "money" },
          { label: "Intercompany requests", value: cnt("intercompany_recharge"), kind: "number", hint: "Internal — never revenue" },
          { label: "Completed intercompany", value: done("intercompany_recharge"), kind: "money", hint: "Internal transfer" },
        ],
        "Intercompany recharges are internal reimbursements between our own legal entities and are never counted as revenue or customer chargebacks.",
      );
    }

    case "duplicate-review": {
      const list = await listDuplicateCandidates(viewer, status ?? "open");
      const out: ReportRow[] = list.map((d) => ({
        id: d.id, score: d.score, reasons: d.matchReasons.join(", "), detectedBy: d.detectedBy, status: d.status, createdAt: d.createdAt,
        aId: d.customerAId, aName: d.a.fullName, bId: d.customerBId, bName: d.b.fullName,
      }));
      return finish(
        out,
        [
          { key: "id", label: "Pair", kind: "id" },
          { key: "aName", label: "Customer A", href: { prefix: "/customers/", key: "aId" } },
          { key: "aId", label: "A ID", kind: "id", secondary: true },
          { key: "bName", label: "Customer B", href: { prefix: "/customers/", key: "bId" } },
          { key: "bId", label: "B ID", kind: "id", secondary: true },
          { key: "reasons", label: "Match reasons", secondary: true },
          { key: "score", label: "Score", kind: "number" },
          { key: "detectedBy", label: "Detected by", secondary: true },
          { key: "createdAt", label: "Detected", kind: "date", secondary: true },
        ],
        [
          { label: "Pairs", value: out.length, kind: "number" },
          { label: "High confidence (≥ 80)", value: out.filter((r) => Number(r.score) >= 80).length, kind: "number" },
        ],
        "Pairs where either customer is outside your scope are hidden. Merging is done from Duplicate Review.",
      );
    }

  }
  return finish([], [], []);
}

/** CSV columns for a report: money as decimal strings, dates ISO, brand/entity ids, status as label. */
export function reportCsvColumns(columns: ReportColumn[]): CsvColumn<ReportRow>[] {
  return columns.map((col) => ({
    header: col.label,
    value: (r: ReportRow): CsvValue => {
      const v = r[col.key];
      if (v === null || v === undefined) return null;
      if (col.kind === "money") return { raw: fromCents(Number(v)) };
      if (col.kind === "percent") return { raw: (Number(v) * 100).toFixed(2) };
      if (col.vocab) return col.vocab[String(v)]?.label ?? String(v);
      return v;
    },
  }));
}

/* ========================================================= export datasets */

export type Dataset = { perms: Permission[]; financial: boolean; defaultRange: string };
export const DATASETS: Record<string, Dataset> = {
  customers: { perms: ["customers.view"], financial: false, defaultRange: "all" },
  sales: { perms: ["sales.view"], financial: false, defaultRange: "all" },
  invoices: { perms: ["billing.view"], financial: true, defaultRange: "all" },
  transactions: { perms: ["transactions.view"], financial: true, defaultRange: "all" },
  chargebacks: { perms: ["chargebacks.view"], financial: true, defaultRange: "all" },
  activity: { perms: ["audit.view"], financial: false, defaultRange: "all" },
  agents: { perms: ["agents.view"], financial: false, defaultRange: "all" },
};

const money = (v: string | null | undefined): CsvValue => (v === null || v === undefined ? null : { raw: fromCents(toCents(v)) });

type Built = { columns: CsvColumn<Record<string, unknown>>[]; rows: Record<string, unknown>[] };
function cols(spec: [string, string, ("money" | "ref")?][], maskRefs = false): CsvColumn<Record<string, unknown>>[] {
  return spec.map(([header, key, kind]) => ({
    header,
    value: (r) => {
      const v = r[key] as CsvValue | string;
      if (kind === "money") return money(v as string | null);
      if (kind === "ref") return maskRefs ? (v ? maskReference(String(v)) : null) : (v as CsvValue);
      return v as CsvValue;
    },
  }));
}

/**
 * Raw dataset exports. Each reuses the filter builder of the matching list
 * page, so a CSV contains exactly what the user sees in that list (all pages).
 */
export async function buildDataset(viewer: Viewer, name: string, f: ListFilters, sp: Record<string, string | string[] | undefined>): Promise<Built> {
  const C = await getDb();
  const limit = MAX_ROWS;
  const maskRefs = !can(viewer, "transactions.view");
  switch (name) {
    case "customers": {
      const where = (await customerListWhere(viewer, f)) as Filter<RowOf<"customers">>;
      const list = await C.customers.find(where, { sort: { lastActivityAt: -1, id: 1 }, limit }).toArray();
      const [agents, rels] = await Promise.all([
        namesOf("users", list.map((r) => r.assignedAgentId)),
        C.customerBrandRelationships.find({ customerId: { $in: ids(list.map((r) => r.id)) } }).toArray(),
      ]);
      const rows = list.map((r) => ({
        id: r.id, fullName: r.fullName, email: r.email, phone: r.phone, companyName: r.companyName, country: r.country, city: r.city,
        status: r.status, source: r.acquisitionSource, agent: r.assignedAgentId ? (agents.get(r.assignedAgentId) ?? null) : null,
        brands: rels.filter((x) => x.customerId === r.id).map((x) => x.brandId).sort().join(" ") || null,
        createdAt: r.createdAt, lastActivityAt: r.lastActivityAt,
      }));
      return {
        rows,
        columns: cols([
          ["Customer ID", "id"], ["Name", "fullName"], ["Email", "email"], ["Phone", "phone"], ["Company", "companyName"], ["Country", "country"],
          ["City", "city"], ["Status", "status"], ["Acquisition source", "source"], ["Assigned agent", "agent"], ["Brands", "brands"],
          ["Created at", "createdAt"], ["Last activity", "lastActivityAt"],
        ]),
      };
    }
    case "sales": {
      const mine = sp.mine === "1";
      const where = (await salesListWhere(viewer, f, { mine })) as unknown as Filter<RowOf<"sales">>;
      const list = await C.sales.find(where, { sort: { saleDate: -1, id: -1 }, limit }).toArray();
      const [cust, agents] = await Promise.all([namesOf("customers", list.map((r) => r.customerId)), namesOf("users", list.map((r) => r.agentId))]);
      const rows = list
        .filter((r) => cust.has(r.customerId))
        .map((r) => ({
          id: r.id, saleDate: r.saleDate, brandId: r.brandId, customerId: r.customerId, customerName: cust.get(r.customerId) ?? null,
          agent: agents.get(r.agentId) ?? null, legalEntityId: r.legalEntityId, status: r.status, currency: r.currency, subtotal: r.subtotal,
          discount: r.discount, tax: r.tax, total: r.total, sourceSystem: r.sourceSystem,
        }));
      return {
        rows,
        columns: cols([
          ["Sale ID", "id"], ["Sale date", "saleDate"], ["Brand", "brandId"], ["Customer ID", "customerId"], ["Customer", "customerName"], ["Agent", "agent"],
          ["Status", "status"], ["Currency", "currency"], ["Subtotal", "subtotal", "money"], ["Discount", "discount", "money"],
          ["Tax", "tax", "money"], ["Total", "total", "money"], ["Source system", "sourceSystem"],
        ]),
      };
    }
    case "invoices": {
      const where = (await invoiceListWhere(viewer, f)) as Filter<RowOf<"invoices">>;
      const list = await C.invoices
        .aggregate<RowOf<"invoices"> & { balance: unknown }>([
          { $match: where },
          { $sort: { billingDate: -1, id: -1 } },
          { $limit: limit },
          ...invoiceBalanceStages(),
          { $project: { _id: 0 } },
        ])
        .toArray();
      const [cust, agents, pays] = await Promise.all([
        namesOf("customers", list.map((r) => r.customerId)),
        namesOf("users", list.map((r) => r.agentId)),
        C.transactions
          .find({ invoiceId: { $in: ids(list.map((r) => r.id)) }, type: "payment" }, { sort: { occurredAt: -1 }, projection: { invoiceId: 1, paymentReference: 1 } })
          .toArray(),
      ]);
      const rows = list
        .filter((r) => cust.has(r.customerId))
        .map((r) => ({
          id: r.id, invoiceNumber: r.invoiceNumber, saleId: r.saleId, brandId: r.brandId, customerId: r.customerId,
          customerName: cust.get(r.customerId) ?? null, agent: agents.get(r.agentId) ?? null, legalEntityId: r.legalEntityId, billingDate: r.billingDate,
          dueDate: r.dueDate, status: r.status, paymentMethod: r.paymentMethod, currency: r.currency, total: r.total, amountPaid: r.amountPaid,
          balance: decStr(r.balance), lastRef: pays.find((t) => t.invoiceId === r.id)?.paymentReference ?? null,
        }));
      return {
        rows,
        columns: cols(
          [
            ["Internal ID", "id"], ["Invoice number", "invoiceNumber"], ["Sale ID", "saleId"], ["Brand", "brandId"], ["Customer ID", "customerId"],
            ["Customer", "customerName"], ["Agent", "agent"], ["Billing date", "billingDate"], ["Due date", "dueDate"],
            ["Status", "status"], ["Payment method", "paymentMethod"], ["Currency", "currency"], ["Total", "total", "money"], ["Amount paid", "amountPaid", "money"],
            ["Balance due", "balance", "money"], ["Last payment reference", "lastRef", "ref"],
          ],
          maskRefs,
        ),
      };
    }
    case "transactions": {
      const where = (await transactionWhere(viewer, f)) as Filter<RowOf<"transactions">>;
      const list = await C.transactions.find(where, { sort: { occurredAt: -1, id: -1 }, limit }).toArray();
      const [cust, invs] = await Promise.all([
        namesOf("customers", list.map((r) => r.customerId)),
        C.invoices.find({ id: { $in: ids(uniq(list.map((r) => r.invoiceId))) } }, { projection: { id: 1, invoiceNumber: 1 } }).toArray(),
      ]);
      return {
        rows: list.map((r) => ({
          id: r.id, type: r.type, status: r.status, occurredAt: r.occurredAt, brandId: r.brandId, customerId: r.customerId,
          customerName: r.customerId ? (cust.get(r.customerId) ?? null) : null, invoiceNumber: invs.find((i) => i.id === r.invoiceId)?.invoiceNumber ?? null,
          caseId: r.chargebackCaseId, adjustmentId: r.adjustmentId, currency: r.currency, amount: r.amount, method: r.paymentMethod,
          processor: r.processor, ref: r.paymentReference,
          revenue: r.type === "intercompany_recharge" ? "no (internal transfer)" : r.type === "payment" ? "yes" : "no",
        })),
        columns: cols(
          [
            ["Transaction ID", "id"], ["Type", "type"], ["Status", "status"], ["Occurred at", "occurredAt"], ["Brand", "brandId"],
            ["Customer ID", "customerId"], ["Customer", "customerName"], ["Invoice number", "invoiceNumber"],
            ["Case ID", "caseId"], ["Adjustment ID", "adjustmentId"], ["Currency", "currency"], ["Amount", "amount", "money"], ["Payment method", "method"],
            ["Processor", "processor"], ["Payment reference", "ref", "ref"], ["Counts as revenue", "revenue"],
          ],
          maskRefs,
        ),
      };
    }
    case "chargebacks": {
      const q = typeof sp.queue === "string" && ["mine", "review", "approval", "processing", "open", "all"].includes(sp.queue) ? (sp.queue as CaseQueue) : "all";
      const { rows } = await listCases(viewer, f, q, { limit, paginate: false });
      return {
        rows,
        columns: cols(
          [
            ["Case ID", "id"], ["Type", "caseType"], ["Origin", "origin"], ["Status", "status"], ["Brand", "brandId"], ["Customer ID", "customerId"],
            ["Customer", "customerName"], ["Invoice number", "invoiceNumber"], ["Original transaction", "originalTransactionId"],
            ["Agent", "agentName"], ["Currency", "currency"],
            ["Amount", "amount", "money"], ["Reason code", "reasonCode"], ["Request date", "requestDate"], ["Requested by", "requesterName"],
            ["Processor reference", "externalProcessorReference", "ref"],
          ],
          maskRefs,
        ),
      };
    }
    case "activity": {
      const q = f.q ? f.q.replace(/[%_]/g, "") : "";
      const list = await C.activityLogs
        .find(
          all<RowOf<"activityLogs">>(
            // Brand-tagged entries outside the viewer's brands are excluded; untagged system entries are kept.
            { $or: [{ brandId: null }, { brandId: { $in: brandFilter(viewer, f.brand) } }] },
            f.agent ? { actorId: f.agent } : undefined,
            f.type ? { entityType: f.type } : undefined,
            q ? { $or: [{ action: contains(q) }, { summary: contains(q) }, { entityId: contains(q) }] } : undefined,
            inRange("createdAt", f),
          ),
          { sort: { createdAt: -1 }, limit },
        )
        .toArray();
      const actors = await namesOf("users", list.map((r) => r.actorId));
      return {
        rows: list.map((r) => ({
          id: r.id, createdAt: r.createdAt, actor: r.actorId ? (actors.get(r.actorId) ?? null) : null, action: r.action, entityType: r.entityType,
          entityId: r.entityId, brandId: r.brandId, legalEntityId: r.legalEntityId, summary: r.summary, ip: r.ip,
        })),
        columns: cols([
          ["Log ID", "id"], ["When", "createdAt"], ["Actor", "actor"], ["Action", "action"], ["Entity type", "entityType"], ["Entity ID", "entityId"],
          ["Brand", "brandId"], ["Summary", "summary"], ["IP", "ip"],
        ]),
      };
    }
    case "agents": {
      const brandIds = brandFilter(viewer, f.brand);
      const everyone = await getAgents();
      const list = everyone.filter((a) => a.brandIds.some((b) => brandIds.includes(b)) && (!f.agent || a.id === f.agent) && (!f.status || a.status === f.status));
      const [stats, mgr] = await Promise.all([
        C.sales
          .aggregate<{ _id: string; n: number; gross: unknown }>([
            { $match: all<RowOf<"sales">>(scopeSales(viewer, f.brand), { status: { $ne: "cancelled" } }, inRange("saleDate", f)) },
            { $group: { _id: "$agentId", n: { $sum: 1 }, gross: sumDec("$total") } },
          ])
          .toArray(),
        C.salesAgents.find({}, { projection: { userId: 1, hireDate: 1 } }).toArray(),
      ]);
      return {
        rows: list.map((a) => {
          const s = stats.find((x) => x._id === a.id);
          return { ...a, brands: a.brandIds.join(" "), hireDate: mgr.find((m) => m.userId === a.id)?.hireDate, sales: s?.n ?? 0, gross: s ? decStr(s.gross) : "0" };
        }),
        columns: cols([
          ["User ID", "id"], ["Name", "name"], ["Email", "email"], ["Agent code", "agentCode"], ["Team", "team"], ["Status", "status"], ["Brands", "brands"],
          ["Monthly target", "monthlyTarget", "money"], ["Hire date", "hireDate"], ["Sales (range)", "sales"], ["Gross (range)", "gross", "money"],
        ]),
      };
    }
  }
  throw new Error(`Unknown dataset ${name}`);
}
