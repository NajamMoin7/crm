import "server-only";
import type { Filter } from "mongodb";
import { getDb, type RowOf } from "@/lib/db";
import { contains, decStr, equalsCi, ids, sumDec, uniq } from "@/lib/db/query";
import { scopeCases, scopeInvoices, scopeTransactions } from "@/lib/auth/scope";
import type { Viewer } from "@/lib/auth/viewer";
import { PAGE_SIZE, type ListFilters } from "@/lib/filters";
import { CASE_ACTIVE_STATUSES } from "@/lib/domain/vocab";
import { fromCents, toCents } from "@/lib/money";

type CaseDoc = RowOf<"chargebackCases">;
const CLOSED = ["completed", "rejected", "failed", "cancelled"];

/* ------------------------------------------------ chargeable balance */

/**
 * What can still be charged back on an original payment:
 *   original amount − succeeded refunds of it − active cases of the same type.
 * Rejected / failed / cancelled cases release their amount.
 * Joins the current transaction when called inside one (queries run sequentially).
 */
export async function chargeableBalance(originalTxnId: string, caseType: "chargeback" | "intercompany_recharge", excludeCaseId?: string) {
  const C = await getDb();
  const orig = await C.transactions.findOne({ id: originalTxnId }, { projection: { amount: 1 } });
  if (!orig) return null;
  const [ref] = await C.transactions
    .aggregate<{ total: unknown }>([
      { $match: { relatedTransactionId: originalTxnId, type: "refund", status: "succeeded" } },
      { $group: { _id: null, total: sumDec("$amount") } },
    ])
    .toArray();
  const [cb] = await C.chargebackCases
    .aggregate<{ total: unknown; n: number }>([
      {
        $match: {
          originalTransactionId: originalTxnId,
          caseType,
          status: { $in: [...CASE_ACTIVE_STATUSES] },
          ...(excludeCaseId ? { id: { $ne: excludeCaseId } } : {}),
        },
      },
      { $group: { _id: null, total: sumDec("$amount"), n: { $sum: 1 } } },
    ])
    .toArray();
  const original = toCents(orig.amount);
  const refunded = toCents(decStr(ref?.total ?? "0"));
  const committed = toCents(decStr(cb?.total ?? "0"));
  return { original, refunded, committed, activeCases: Number(cb?.n ?? 0), remaining: Math.max(0, original - refunded - committed) };
}

/* ------------------------------------------- original transaction lookup */

type TxnDoc = RowOf<"transactions">;

/** Shape of an original payment (transaction + invoice + customer fields), as before. */
async function toOriginals(rows: TxnDoc[], viewer: Viewer) {
  if (!rows.length) return [];
  const C = await getDb();
  // Agents can only raise cases on invoices they can see.
  const invoices = await C.invoices
    .find({ $and: [{ id: { $in: ids(uniq(rows.map((r) => r.invoiceId))) } }, scopeInvoices(viewer)] }, { projection: { id: 1, invoiceNumber: 1, status: 1 } })
    .toArray();
  const customers = await C.customers
    .find({ id: { $in: ids(uniq(rows.map((r) => r.customerId))) } }, { projection: { id: 1, fullName: 1, email: 1 } })
    .toArray();
  return rows.flatMap((t) => {
    const inv = invoices.find((i) => i.id === t.invoiceId);
    if (!inv) return [];
    const cust = customers.find((c) => c.id === t.customerId);
    return [
      {
        id: t.id,
        brandId: t.brandId,
        legalEntityId: t.legalEntityId,
        customerId: t.customerId,
        customerName: cust?.fullName ?? null,
        customerEmail: cust?.email ?? null,
        invoiceId: t.invoiceId,
        invoiceNumber: inv.invoiceNumber,
        invoiceStatus: inv.status,
        amount: t.amount,
        currency: t.currency,
        status: t.status,
        paymentMethod: t.paymentMethod,
        processor: t.processor,
        paymentReference: t.paymentReference,
        occurredAt: t.occurredAt,
      },
    ];
  });
}

/** Payments an original-payment lookup may return for this viewer (invoice scope checked in toOriginals). */
function originalScope(viewer: Viewer): Filter<TxnDoc> {
  return { $and: [{ type: "payment", invoiceId: { $ne: null } }, scopeTransactions(viewer)] };
}

export async function searchOriginalTransactions(viewer: Viewer, query: string) {
  const C = await getDb();
  const q = query.trim();
  if (q.length < 3) return [];
  const [invoiceIds, customerIds] = await Promise.all([
    C.invoices.distinct("id", { $or: [{ invoiceNumber: contains(q) }, { id: equalsCi(q) }] }),
    C.customers.distinct("id", { email: equalsCi(q) }),
  ]);
  const rows = await C.transactions
    .find(
      {
        $and: [
          originalScope(viewer),
          {
            $or: [
              { id: equalsCi(q) },
              { invoiceId: { $in: ids(invoiceIds) } },
              { customerId: equalsCi(q) },
              { customerId: { $in: ids(customerIds) } },
              { paymentReference: q },
            ],
          },
        ],
      },
      { sort: { occurredAt: -1 }, limit: 100 },
    )
    .toArray();
  const originals = (await toOriginals(rows, viewer)).slice(0, 25);
  return Promise.all(originals.map(async (r) => ({ ...r, balance: (await chargeableBalance(r.id, "chargeback"))! })));
}

export async function getOriginalTransaction(viewer: Viewer, txnId: string) {
  const C = await getDb();
  const row = await C.transactions.findOne({ $and: [{ id: txnId }, originalScope(viewer)] });
  if (!row) return null;
  return (await toOriginals([row], viewer))[0] ?? null;
}

/* ------------------------------------------------------------ case lists */

export type CaseQueue = "mine" | "review" | "approval" | "processing" | "open" | "all";

export async function caseListWhere(viewer: Viewer, f: ListFilters, queue: CaseQueue = "all"): Promise<Filter<CaseDoc>> {
  const C = await getDb();
  const conds: Filter<CaseDoc>[] = [scopeCases(viewer, f.brand)];
  if (f.status) conds.push({ status: f.status as never });
  if (f.type) conds.push({ caseType: f.type as never });
  if (f.agent) conds.push({ invoiceId: { $in: ids(await C.invoices.distinct("id", { agentId: f.agent })) } });
  if (f.customer) conds.push({ customerId: f.customer });
  if (f.from) conds.push({ requestDate: { $gte: f.from } });
  if (f.to) conds.push({ requestDate: { $lte: f.to } });
  if (f.q) {
    const re = contains(f.q);
    const [customerIds, invoiceIds] = await Promise.all([
      C.customers.distinct("id", { fullName: re }),
      C.invoices.distinct("id", { invoiceNumber: re }),
    ]);
    conds.push({
      $or: [
        { id: re },
        { originalTransactionId: re },
        { externalProcessorReference: re },
        { customerId: { $in: ids(customerIds) } },
        { invoiceId: { $in: ids(invoiceIds) } },
      ],
    });
  }
  if (queue === "mine") conds.push({ requestedBy: viewer.id });
  if (queue === "review") conds.push({ status: "pending_review", requestedBy: { $ne: viewer.id } });
  if (queue === "approval") conds.push({ status: "pending_approval", requestedBy: { $ne: viewer.id } });
  if (queue === "processing") conds.push({ status: { $in: ["approved", "processing"] } });
  if (queue === "open") conds.push({ status: { $nin: CLOSED as CaseDoc["status"][] } });
  return { $and: conds };
}

export async function listCases(viewer: Viewer, f: ListFilters, queue: CaseQueue = "all", opts: { limit?: number; paginate?: boolean } = {}) {
  const C = await getDb();
  const where = await caseListWhere(viewer, f, queue);
  const limit = opts.limit ?? PAGE_SIZE;
  const [cases, [agg]] = await Promise.all([
    C.chargebackCases
      .find(where, { sort: { updatedAt: -1, id: 1 }, limit, skip: opts.paginate === false ? 0 : (f.page - 1) * limit })
      .toArray(),
    C.chargebackCases
      .aggregate<{ total: number; amount: unknown; completedAmount: unknown; openAmount: unknown }>([
        { $match: where },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            amount: sumDec("$amount"),
            completedAmount: sumDec({ $cond: [{ $eq: ["$status", "completed"] }, "$amount", "0"] }),
            openAmount: sumDec({ $cond: [{ $in: ["$status", CLOSED] }, "0", "$amount"] }),
          },
        },
      ])
      .toArray(),
  ]);
  const [customers, invoices] = await Promise.all([
    C.customers.find({ id: { $in: ids(uniq(cases.map((c) => c.customerId))) } }, { projection: { id: 1, fullName: 1 } }).toArray(),
    C.invoices.find({ id: { $in: ids(uniq(cases.map((c) => c.invoiceId))) } }, { projection: { id: 1, invoiceNumber: 1, agentId: 1 } }).toArray(),
  ]);
  const userIds = uniq([...cases.map((c) => c.requestedBy), ...invoices.map((i) => i.agentId)]);
  const users = await C.users.find({ id: { $in: ids(userIds) } }, { projection: { id: 1, name: 1 } }).toArray();
  const userName = (id: string | null | undefined) => (id ? (users.find((u) => u.id === id)?.name ?? null) : null);

  const rows = cases.map((c) => {
    const inv = invoices.find((i) => i.id === c.invoiceId);
    return {
      id: c.id,
      caseType: c.caseType,
      origin: c.origin,
      status: c.status,
      brandId: c.brandId,
      customerId: c.customerId,
      customerName: customers.find((x) => x.id === c.customerId)?.fullName ?? "",
      invoiceId: c.invoiceId,
      invoiceNumber: inv?.invoiceNumber ?? "",
      originalTransactionId: c.originalTransactionId,
      originalLegalEntityId: c.originalLegalEntityId,
      agentId: inv?.agentId ?? "",
      agentName: userName(inv?.agentId),
      responsibleLegalEntityId: c.responsibleLegalEntityId,
      amount: c.amount,
      currency: c.currency,
      reasonCode: c.reasonCode,
      requestDate: c.requestDate,
      requestedBy: c.requestedBy,
      requesterName: userName(c.requestedBy) ?? "",
      externalProcessorReference: c.externalProcessorReference,
      updatedAt: c.updatedAt,
    };
  });
  return {
    rows,
    total: Number(agg?.total ?? 0),
    amount: decStr(agg?.amount ?? "0"),
    completedAmount: decStr(agg?.completedAmount ?? "0"),
    openAmount: decStr(agg?.openAmount ?? "0"),
  };
}

/** Counts for the management queues (each already scoped). */
export async function queueCounts(viewer: Viewer, brand: string | null) {
  const C = await getDb();
  const open = { $not: { $in: ["$status", CLOSED] } };
  const mineReq = { $eq: ["$requestedBy", viewer.id] };
  const notMine = { $ne: ["$requestedBy", viewer.id] };
  const count = (cond: unknown) => ({ $sum: { $cond: [cond, 1, 0] } });
  const [r] = await C.chargebackCases
    .aggregate<{ mine: number; review: number; approval: number; processing: number; open: number; drafts: number }>([
      { $match: scopeCases(viewer, brand) },
      {
        $group: {
          _id: null,
          mine: count({ $and: [mineReq, open] }),
          review: count({ $and: [{ $eq: ["$status", "pending_review"] }, notMine] }),
          approval: count({ $and: [{ $eq: ["$status", "pending_approval"] }, notMine] }),
          processing: count({ $in: ["$status", ["approved", "processing"]] }),
          open: count(open),
          drafts: count({ $and: [{ $eq: ["$status", "draft"] }, mineReq] }),
        },
      },
    ])
    .toArray();
  return {
    mine: r?.mine ?? 0,
    review: r?.review ?? 0,
    approval: r?.approval ?? 0,
    processing: r?.processing ?? 0,
    open: r?.open ?? 0,
    drafts: r?.drafts ?? 0,
  };
}

/* ------------------------------------------------------------ case detail */

export async function getCaseDetail(viewer: Viewer, id: string) {
  const C = await getDb();
  const c = await C.chargebackCases.findOne({ $and: [{ id }, scopeCases(viewer)] });
  if (!c) return null;
  const [eventRows, original, invoiceRow, customerRow, ledger, balance, siblings] = await Promise.all([
    C.chargebackEvents.find({ caseId: id }, { sort: { createdAt: 1, id: 1 } }).toArray(),
    C.transactions.findOne({ id: c.originalTransactionId }),
    C.invoices.findOne({ id: c.invoiceId }),
    C.customers.findOne({ id: c.customerId }, { projection: { id: 1, fullName: 1, email: 1, phone: 1 } }),
    c.ledgerTransactionId ? C.transactions.findOne({ id: c.ledgerTransactionId }) : Promise.resolve(null),
    chargeableBalance(c.originalTransactionId, c.caseType, c.id),
    C.chargebackCases
      .find({ originalTransactionId: c.originalTransactionId, id: { $ne: id } }, { sort: { requestDate: 1 }, projection: { id: 1, status: 1, amount: 1, caseType: 1 } })
      .toArray(),
  ]);
  const names = new Map(
    (await C.users.find({ id: { $in: ids(uniq([...eventRows.map((e) => e.actorId), invoiceRow?.agentId])) } }, { projection: { id: 1, name: 1 } }).toArray()).map(
      (u) => [u.id, u.name],
    ),
  );
  // Inner join on the actor, as before: events by deleted users are not listed.
  const events = eventRows
    .filter((e) => names.has(e.actorId))
    .map((e) => ({
      id: e.id,
      action: e.action,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      note: e.note,
      changes: e.changes,
      createdAt: e.createdAt,
      actorId: e.actorId,
      actorName: names.get(e.actorId)!,
    }));
  const invoice = invoiceRow
    ? {
        id: invoiceRow.id,
        invoiceNumber: invoiceRow.invoiceNumber,
        status: invoiceRow.status,
        total: invoiceRow.total,
        amountPaid: invoiceRow.amountPaid,
        currency: invoiceRow.currency,
        billingDate: invoiceRow.billingDate,
        agentId: invoiceRow.agentId,
        saleId: invoiceRow.saleId,
        agentName: names.get(invoiceRow.agentId) ?? null,
      }
    : undefined;
  const customer = customerRow ? { id: customerRow.id, fullName: customerRow.fullName, email: customerRow.email, phone: customerRow.phone } : undefined;
  return {
    case: c,
    events,
    original: original ?? undefined,
    invoice,
    customer,
    ledger: ledger ?? null,
    balance: balance!,
    siblings: siblings.map((s) => ({ id: s.id, status: s.status, amount: s.amount, caseType: s.caseType })),
  };
}

export function sumCents(values: (string | null | undefined)[]) {
  return fromCents(values.reduce((a, v) => a + toCents(v ?? "0"), 0));
}
