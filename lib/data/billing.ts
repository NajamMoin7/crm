import "server-only";
import type { Filter } from "mongodb";
import { getDb, type RowOf } from "@/lib/db";
import { byKey, contains, dec, decStr, ids, sumDec, uniq } from "@/lib/db/query";
import { scopeCases, scopeInvoices } from "@/lib/auth/scope";
import { can, type Viewer } from "@/lib/auth/viewer";
import { PAGE_SIZE, type ListFilters } from "@/lib/filters";
import { fromCents, toCents } from "@/lib/money";

type Invoice = RowOf<"invoices">;

/** Approved adjustments per invoice (cents) — they reduce the balance due but never amount_paid. */
export async function approvedAdjustmentsByInvoice(invoiceIds: string[]): Promise<Map<string, number>> {
  const C = await getDb();
  const rows = await C.financialAdjustments
    .aggregate<{ _id: string; total: unknown }>([
      { $match: { invoiceId: { $in: ids(invoiceIds) }, status: "approved" } },
      { $group: { _id: "$invoiceId", total: sumDec("$amount") } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, toCents(decStr(r.total))]));
}

/** Adjusted balance = max(0, total − paid − approved adjustments), in cents. */
export const invoiceBalanceCents = (inv: Pick<Invoice, "total" | "amountPaid">, adjustedCents: number) =>
  Math.max(0, toCents(inv.total) - toCents(inv.amountPaid) - adjustedCents);

/** Adds `adjusted` and `balance` (decimal strings) to invoice rows. */
export async function withBalances<T extends Pick<Invoice, "id" | "total" | "amountPaid">>(rows: T[]) {
  const adj = await approvedAdjustmentsByInvoice(rows.map((r) => r.id));
  return rows.map((r) => {
    const a = adj.get(r.id) ?? 0;
    return { ...r, adjusted: fromCents(a), balance: fromCents(invoiceBalanceCents(r, a)) };
  });
}

/** Aggregation stages adding `adjDec` and `balanceDec` (Decimal128) to invoice documents. */
export const balanceStages = [
  {
    $lookup: {
      from: "financial_adjustments",
      let: { invId: "$id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$invoiceId", "$$invId"] }, status: "approved" } },
        { $group: { _id: null, s: sumDec("$amount") } },
      ],
      as: "_adj",
    },
  },
  { $set: { adjDec: { $ifNull: [{ $first: "$_adj.s" }, dec("0")] } } },
  { $set: { balanceDec: { $max: [dec("0"), { $subtract: [dec("$total"), { $add: [dec("$amountPaid"), "$adjDec"] }] }] } } },
  { $unset: "_adj" },
];

export async function invoiceListWhere(viewer: Viewer, f: ListFilters): Promise<Filter<Invoice>> {
  const C = await getDb();
  const q = f.q.trim();
  const conds: Filter<Invoice>[] = [scopeInvoices(viewer, f.brand)];
  if (q) {
    const rx = contains(q);
    const customerIds = await C.customers.distinct("id", { $or: [{ fullName: rx }, { companyName: rx }] });
    const alternatives: Filter<Invoice>[] = [{ invoiceNumber: rx }, { id: rx }, { customerId: rx }, { customerId: { $in: customerIds } }];
    if (can(viewer, "transactions.view")) {
      const byRef = await C.transactions.distinct("invoiceId", { paymentReference: rx });
      alternatives.push({ id: { $in: uniq(byRef) } });
    }
    conds.push({ $or: alternatives });
  }
  if (f.status) conds.push({ status: f.status as Invoice["status"] });
  if (f.agent) conds.push({ agentId: f.agent });
  if (f.entity) conds.push({ legalEntityId: f.entity });
  if (f.customer) conds.push({ customerId: f.customer });
  if (f.from) conds.push({ billingDate: { $gte: f.from } });
  if (f.to) conds.push({ billingDate: { $lte: f.to } });
  return { $and: conds };
}

export async function listInvoices(viewer: Viewer, f: ListFilters) {
  const C = await getDb();
  const where = await invoiceListWhere(viewer, f);
  const [page, total] = await Promise.all([
    C.invoices.find(where, { sort: { billingDate: -1, id: -1 }, skip: (f.page - 1) * PAGE_SIZE, limit: PAGE_SIZE }).toArray(),
    C.invoices.countDocuments(where),
  ]);
  const [people, entities, custs, withBal] = await Promise.all([
    C.users.find({ id: { $in: ids(uniq(page.map((i) => i.agentId))) } }, { projection: { id: 1, name: 1 } }).toArray(),
    C.legalEntities.find({ id: { $in: ids(uniq(page.map((i) => i.legalEntityId))) } }, { projection: { id: 1, internalCode: 1 } }).toArray(),
    C.customers.find({ id: { $in: ids(uniq(page.map((i) => i.customerId))) } }, { projection: { id: 1, fullName: 1, companyName: 1 } }).toArray(),
    withBalances(page),
  ]);
  const userMap = byKey(people, "id");
  const entityMap = byKey(entities, "id");
  const customerMap = byKey(custs, "id");
  const rows = withBal.map((i) => ({
    id: i.id,
    invoiceNumber: i.invoiceNumber,
    brandId: i.brandId,
    customerId: i.customerId,
    customerName: customerMap.get(i.customerId)?.fullName ?? "",
    companyName: customerMap.get(i.customerId)?.companyName ?? null,
    agentId: i.agentId,
    agentName: userMap.get(i.agentId)?.name ?? null,
    legalEntityId: i.legalEntityId,
    entityCode: entityMap.get(i.legalEntityId)?.internalCode ?? null,
    billingDate: i.billingDate,
    dueDate: i.dueDate,
    total: i.total,
    amountPaid: i.amountPaid,
    adjusted: i.adjusted,
    balance: i.balance,
    currency: i.currency,
    status: i.status,
    paymentMethod: i.paymentMethod,
  }));
  return { rows, total };
}

/**
 * KPI definitions (same filters as the table):
 * - Billed: Σ total of issued invoices (excludes draft and cancelled).
 * - Collected: Σ amount_paid (net of refunds) across all matching invoices.
 * - Outstanding: Σ (total − paid − approved adjustments) for pending, partially paid and overdue.
 * - Pending / Draft: number of invoices awaiting issue or payment.
 */
export async function invoiceKpis(viewer: Viewer, f: ListFilters) {
  const C = await getDb();
  const is = (statuses: string[]) => ({ $in: ["$status", statuses] });
  const countIf = (cond: unknown) => ({ $sum: { $cond: [cond, 1, 0] } });
  const [row] = await C.invoices
    .aggregate<Record<string, unknown>>([
      { $match: await invoiceListWhere(viewer, f) },
      ...balanceStages,
      {
        $group: {
          _id: null,
          billed: { $sum: { $cond: [is(["draft", "cancelled"]), dec("0"), dec("$total")] } },
          collected: sumDec("$amountPaid"),
          outstanding: { $sum: { $cond: [is(["pending", "partially_paid", "overdue"]), "$balanceDec", dec("0")] } },
          overdueCount: countIf({ $eq: ["$status", "overdue"] }),
          pendingCount: countIf({ $eq: ["$status", "pending"] }),
          draftCount: countIf({ $eq: ["$status", "draft"] }),
          n: { $sum: 1 },
        },
      },
    ])
    .toArray();
  return {
    billed: toCents(decStr(row?.billed)),
    collected: toCents(decStr(row?.collected)),
    outstanding: toCents(decStr(row?.outstanding)),
    overdueCount: Number(row?.overdueCount ?? 0),
    pendingCount: Number(row?.pendingCount ?? 0),
    draftCount: Number(row?.draftCount ?? 0),
    n: Number(row?.n ?? 0),
  };
}

export async function getInvoiceDetail(viewer: Viewer, id: string) {
  const C = await getDb();
  const invoice = await C.invoices.findOne({ $and: [{ id }, scopeInvoices(viewer)] });
  if (!invoice) return null;
  const [customer, brand, sale, agent, entity] = await Promise.all([
    C.customers.findOne({ id: invoice.customerId }),
    C.brands.findOne({ id: invoice.brandId }),
    C.sales.findOne({ id: invoice.saleId }),
    C.users.findOne({ id: invoice.agentId }, { projection: { id: 1, name: 1, email: 1 } }),
    C.legalEntities.findOne({ id: invoice.legalEntityId }),
  ]);
  if (!customer || !brand || !sale) return null;
  const inv = {
    invoice,
    customerName: customer.fullName,
    customerCompany: customer.companyName,
    customerEmail: customer.email,
    agentName: agent?.name ?? null,
    agentEmail: agent?.email ?? null,
    entityName: entity?.registeredName ?? null,
    entityCode: entity?.internalCode ?? null,
    entityJurisdiction: entity?.jurisdiction ?? null,
    brandName: brand.name,
    allowedPaymentMethods: brand.allowedPaymentMethods,
    saleDate: sale.saleDate,
    saleStatus: sale.status,
    saleNotes: sale.notes,
  };

  const [items, saleLines, ledgerRows, cases, adjustmentRows, activityRows] = await Promise.all([
    C.invoiceItems.find({ invoiceId: id }, { sort: { id: 1 } }).toArray(),
    C.saleItems.find({ saleId: invoice.saleId }, { sort: { id: 1 } }).toArray(),
    C.transactions.find({ invoiceId: id }, { sort: { occurredAt: 1, id: 1 } }).toArray(),
    can(viewer, "chargebacks.view")
      ? C.chargebackCases
          .find(
            { $and: [{ invoiceId: id }, scopeCases(viewer)] },
            { sort: { requestDate: -1 }, projection: { id: 1, caseType: 1, status: 1, amount: 1, currency: 1, reasonCode: 1, requestDate: 1 } },
          )
          .toArray()
      : Promise.resolve([]),
    C.financialAdjustments.find({ invoiceId: id }, { sort: { createdAt: -1 } }).toArray(),
    C.activityLogs
      .find(
        { $or: [{ entityType: "invoice", entityId: id }, { entityType: "sale", entityId: invoice.saleId }, { "metadata.invoiceId": id }] },
        { sort: { createdAt: -1, id: -1 }, limit: 60 },
      )
      .toArray(),
  ]);
  const names = new Map(
    (
      await C.users
        .find(
          { id: { $in: ids(uniq([...ledgerRows.map((t) => t.createdBy), ...adjustmentRows.map((a) => a.requestedBy), ...activityRows.map((a) => a.actorId)])) } },
          { projection: { id: 1, name: 1 } },
        )
        .toArray()
    ).map((u) => [u.id, u.name]),
  );
  const nameOf = (uid: string | null) => (uid ? (names.get(uid) ?? null) : null);
  const ledger = ledgerRows.map((t) => ({
    id: t.id,
    type: t.type,
    status: t.status,
    amount: t.amount,
    currency: t.currency,
    paymentMethod: t.paymentMethod,
    processor: t.processor,
    paymentReference: t.paymentReference,
    occurredAt: t.occurredAt,
    relatedTransactionId: t.relatedTransactionId,
    chargebackCaseId: t.chargebackCaseId,
    adjustmentId: t.adjustmentId,
    notes: t.notes,
    createdByName: nameOf(t.createdBy),
  }));
  const adjustments = adjustmentRows.map((a) => ({
    id: a.id,
    type: a.type,
    status: a.status,
    amount: a.amount,
    currency: a.currency,
    reason: a.reason,
    createdAt: a.createdAt,
    requestedByName: nameOf(a.requestedBy),
  }));
  const activity = activityRows.map((a) => ({ id: a.id, action: a.action, summary: a.summary, createdAt: a.createdAt, actor: nameOf(a.actorId) }));

  const approvedAdj = adjustments.filter((a) => a.status === "approved").reduce((s, a) => s + toCents(a.amount), 0);
  const total = toCents(invoice.total);
  const paid = toCents(invoice.amountPaid);
  return {
    ...inv,
    invoice,
    items,
    saleLines,
    ledger,
    cases,
    adjustments,
    activity,
    money: { total, paid, approvedAdj, balance: Math.max(0, total - paid - approvedAdj) },
  };
}

export type InvoiceDetail = NonNullable<Awaited<ReturnType<typeof getInvoiceDetail>>>;
