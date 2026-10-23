import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, ne, notInArray, or, sql, sum, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb, type DbOrTx } from "@/lib/db";
import {
  chargebackCases,
  chargebackEvents,
  customers,
  invoices,
  transactions,
  users,
} from "@/lib/db/schema";
import { scopeCases, scopeInvoices, scopeTransactions } from "@/lib/auth/scope";
import type { Viewer } from "@/lib/auth/viewer";
import { PAGE_SIZE, type ListFilters } from "@/lib/filters";
import { CASE_ACTIVE_STATUSES } from "@/lib/domain/vocab";
import { fromCents, toCents } from "@/lib/money";

/* ------------------------------------------------ chargeable balance */

/**
 * What can still be charged back on an original payment:
 *   original amount − succeeded refunds of it − active cases of the same type.
 * Rejected / failed / cancelled cases release their amount.
 */
export async function chargeableBalance(db: DbOrTx, originalTxnId: string, caseType: "chargeback" | "intercompany_recharge", excludeCaseId?: string) {
  const [orig] = await db.select({ amount: transactions.amount }).from(transactions).where(eq(transactions.id, originalTxnId));
  if (!orig) return null;
  const [[ref], [cb]] = await Promise.all([
    db
      .select({ total: sum(transactions.amount) })
      .from(transactions)
      .where(and(eq(transactions.relatedTransactionId, originalTxnId), eq(transactions.type, "refund"), eq(transactions.status, "succeeded"))),
    db
      .select({ total: sum(chargebackCases.amount), n: count() })
      .from(chargebackCases)
      .where(
        and(
          eq(chargebackCases.originalTransactionId, originalTxnId),
          eq(chargebackCases.caseType, caseType),
          inArray(chargebackCases.status, [...CASE_ACTIVE_STATUSES]),
          excludeCaseId ? ne(chargebackCases.id, excludeCaseId) : undefined,
        ),
      ),
  ]);
  const original = toCents(orig.amount);
  const refunded = toCents(ref?.total ?? "0");
  const committed = toCents(cb?.total ?? "0");
  return { original, refunded, committed, activeCases: Number(cb?.n ?? 0), remaining: Math.max(0, original - refunded - committed) };
}

/* ------------------------------------------- original transaction lookup */

const origSelect = {
  id: transactions.id,
  brandId: transactions.brandId,
  legalEntityId: transactions.legalEntityId,
  customerId: transactions.customerId,
  customerName: customers.fullName,
  customerEmail: customers.email,
  invoiceId: transactions.invoiceId,
  invoiceNumber: invoices.invoiceNumber,
  invoiceStatus: invoices.status,
  amount: transactions.amount,
  currency: transactions.currency,
  status: transactions.status,
  paymentMethod: transactions.paymentMethod,
  processor: transactions.processor,
  paymentReference: transactions.paymentReference,
  occurredAt: transactions.occurredAt,
};

/**
 * Transactions an original-payment lookup may return for this viewer. Callers
 * join `invoices`; agents can only raise cases on invoices they can see.
 */
function originalScope(viewer: Viewer): SQL {
  return and(eq(transactions.type, "payment"), scopeTransactions(viewer), scopeInvoices(viewer))!;
}

export async function searchOriginalTransactions(viewer: Viewer, query: string) {
  const db = await getDb();
  const q = query.trim();
  if (q.length < 3) return [];
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const rows = await db
    .select(origSelect)
    .from(transactions)
    .innerJoin(invoices, eq(invoices.id, transactions.invoiceId))
    .leftJoin(customers, eq(customers.id, transactions.customerId))
    .where(
      and(
        originalScope(viewer),
        or(
          eq(sql`upper(${transactions.id})`, q.toUpperCase()),
          ilike(invoices.invoiceNumber, like),
          eq(sql`upper(${invoices.id})`, q.toUpperCase()),
          eq(sql`upper(${transactions.customerId})`, q.toUpperCase()),
          eq(sql`lower(${customers.email})`, q.toLowerCase()),
          eq(transactions.paymentReference, q),
        ),
      ),
    )
    .orderBy(desc(transactions.occurredAt))
    .limit(25);
  return Promise.all(
    rows.map(async (r) => ({ ...r, balance: (await chargeableBalance(db, r.id, "chargeback"))! })),
  );
}

export async function getOriginalTransaction(viewer: Viewer, txnId: string, db?: DbOrTx) {
  const conn = db ?? (await getDb());
  const [row] = await conn
    .select(origSelect)
    .from(transactions)
    .innerJoin(invoices, eq(invoices.id, transactions.invoiceId))
    .leftJoin(customers, eq(customers.id, transactions.customerId))
    .where(and(eq(transactions.id, txnId), originalScope(viewer)));
  return row ?? null;
}

/* ------------------------------------------------------------ case lists */

const requester = alias(users, "requester");
const saleAgent = alias(users, "sale_agent");

export type CaseQueue = "mine" | "review" | "approval" | "processing" | "open" | "all";

export function caseListWhere(viewer: Viewer, f: ListFilters, queue: CaseQueue = "all") {
  const like = f.q ? `%${f.q.replace(/[%_]/g, "")}%` : null;
  return and(
    scopeCases(viewer, f.brand),
    f.status ? eq(chargebackCases.status, f.status as never) : undefined,
    f.type ? eq(chargebackCases.caseType, f.type as never) : undefined,
    f.agent ? eq(invoices.agentId, f.agent) : undefined,
    f.customer ? eq(chargebackCases.customerId, f.customer) : undefined,
    f.from ? sql`${chargebackCases.requestDate} >= ${f.from}` : undefined,
    f.to ? sql`${chargebackCases.requestDate} <= ${f.to}` : undefined,
    like
      ? or(
          ilike(chargebackCases.id, like),
          ilike(chargebackCases.originalTransactionId, like),
          ilike(chargebackCases.externalProcessorReference, like),
          ilike(customers.fullName, like),
          ilike(invoices.invoiceNumber, like),
        )
      : undefined,
    queue === "mine" ? eq(chargebackCases.requestedBy, viewer.id) : undefined,
    queue === "review" ? and(eq(chargebackCases.status, "pending_review"), ne(chargebackCases.requestedBy, viewer.id)) : undefined,
    queue === "approval" ? and(eq(chargebackCases.status, "pending_approval"), ne(chargebackCases.requestedBy, viewer.id)) : undefined,
    queue === "processing" ? inArray(chargebackCases.status, ["approved", "processing"]) : undefined,
    queue === "open" ? notInArray(chargebackCases.status, ["completed", "rejected", "failed", "cancelled"]) : undefined,
  );
}

export async function listCases(viewer: Viewer, f: ListFilters, queue: CaseQueue = "all", opts: { limit?: number; paginate?: boolean } = {}) {
  const db = await getDb();
  const where = caseListWhere(viewer, f, queue);
  const limit = opts.limit ?? PAGE_SIZE;
  const base = db
    .select({
      id: chargebackCases.id,
      caseType: chargebackCases.caseType,
      origin: chargebackCases.origin,
      status: chargebackCases.status,
      brandId: chargebackCases.brandId,
      customerId: chargebackCases.customerId,
      customerName: customers.fullName,
      invoiceId: chargebackCases.invoiceId,
      invoiceNumber: invoices.invoiceNumber,
      originalTransactionId: chargebackCases.originalTransactionId,
      originalLegalEntityId: chargebackCases.originalLegalEntityId,
      agentId: invoices.agentId,
      agentName: saleAgent.name,
      responsibleLegalEntityId: chargebackCases.responsibleLegalEntityId,
      amount: chargebackCases.amount,
      currency: chargebackCases.currency,
      reasonCode: chargebackCases.reasonCode,
      requestDate: chargebackCases.requestDate,
      requestedBy: chargebackCases.requestedBy,
      requesterName: requester.name,
      externalProcessorReference: chargebackCases.externalProcessorReference,
      updatedAt: chargebackCases.updatedAt,
    })
    .from(chargebackCases)
    .innerJoin(customers, eq(customers.id, chargebackCases.customerId))
    .innerJoin(invoices, eq(invoices.id, chargebackCases.invoiceId))
    .innerJoin(requester, eq(requester.id, chargebackCases.requestedBy))
    .leftJoin(saleAgent, eq(saleAgent.id, invoices.agentId))
    .where(where)
    .orderBy(desc(chargebackCases.updatedAt), asc(chargebackCases.id));

  const rows = opts.paginate === false ? await base.limit(limit) : await base.limit(limit).offset((f.page - 1) * limit);
  const [agg] = await db
    .select({
      total: count(),
      amount: sum(chargebackCases.amount),
      completedAmount: sql<string>`coalesce(sum(${chargebackCases.amount}) filter (where ${chargebackCases.status} = 'completed'), 0)`,
      openAmount: sql<string>`coalesce(sum(${chargebackCases.amount}) filter (where ${chargebackCases.status} not in ('completed','rejected','failed','cancelled')), 0)`,
    })
    .from(chargebackCases)
    .innerJoin(customers, eq(customers.id, chargebackCases.customerId))
    .innerJoin(invoices, eq(invoices.id, chargebackCases.invoiceId))
    .where(where);
  return { rows, total: Number(agg.total), amount: agg.amount ?? "0", completedAmount: agg.completedAmount, openAmount: agg.openAmount };
}

/** Counts for the management queues (each already scoped). */
export async function queueCounts(viewer: Viewer, brand: string | null) {
  const db = await getDb();
  const scope = scopeCases(viewer, brand);
  const [r] = await db
    .select({
      mine: sql<number>`count(*) filter (where ${chargebackCases.requestedBy} = ${viewer.id} and ${chargebackCases.status} not in ('completed','rejected','failed','cancelled'))::int`,
      review: sql<number>`count(*) filter (where ${chargebackCases.status} = 'pending_review' and ${chargebackCases.requestedBy} <> ${viewer.id})::int`,
      approval: sql<number>`count(*) filter (where ${chargebackCases.status} = 'pending_approval' and ${chargebackCases.requestedBy} <> ${viewer.id})::int`,
      processing: sql<number>`count(*) filter (where ${chargebackCases.status} in ('approved','processing'))::int`,
      open: sql<number>`count(*) filter (where ${chargebackCases.status} not in ('completed','rejected','failed','cancelled'))::int`,
      drafts: sql<number>`count(*) filter (where ${chargebackCases.status} = 'draft' and ${chargebackCases.requestedBy} = ${viewer.id})::int`,
    })
    .from(chargebackCases)
    .where(scope);
  return r;
}

/* ------------------------------------------------------------ case detail */

export async function getCaseDetail(viewer: Viewer, id: string) {
  const db = await getDb();
  const [c] = await db.select().from(chargebackCases).where(and(eq(chargebackCases.id, id), scopeCases(viewer)));
  if (!c) return null;
  const actor = alias(users, "actor");
  const [events, [original], [invoice], [customer], ledger, balance, siblings] = await Promise.all([
    db
      .select({
        id: chargebackEvents.id,
        action: chargebackEvents.action,
        fromStatus: chargebackEvents.fromStatus,
        toStatus: chargebackEvents.toStatus,
        note: chargebackEvents.note,
        changes: chargebackEvents.changes,
        createdAt: chargebackEvents.createdAt,
        actorId: chargebackEvents.actorId,
        actorName: actor.name,
      })
      .from(chargebackEvents)
      .innerJoin(actor, eq(actor.id, chargebackEvents.actorId))
      .where(eq(chargebackEvents.caseId, id))
      .orderBy(asc(chargebackEvents.createdAt), asc(chargebackEvents.id)),
    db.select().from(transactions).where(eq(transactions.id, c.originalTransactionId)),
    db
      .select({
        id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status, total: invoices.total,
        amountPaid: invoices.amountPaid, currency: invoices.currency, billingDate: invoices.billingDate, agentId: invoices.agentId,
        saleId: invoices.saleId, agentName: saleAgent.name,
      })
      .from(invoices)
      .leftJoin(saleAgent, eq(saleAgent.id, invoices.agentId))
      .where(eq(invoices.id, c.invoiceId)),
    db.select({ id: customers.id, fullName: customers.fullName, email: customers.email, phone: customers.phone }).from(customers).where(eq(customers.id, c.customerId)),
    c.ledgerTransactionId ? db.select().from(transactions).where(eq(transactions.id, c.ledgerTransactionId)) : Promise.resolve([]),
    chargeableBalance(db, c.originalTransactionId, c.caseType, c.id),
    db
      .select({ id: chargebackCases.id, status: chargebackCases.status, amount: chargebackCases.amount, caseType: chargebackCases.caseType })
      .from(chargebackCases)
      .where(and(eq(chargebackCases.originalTransactionId, c.originalTransactionId), ne(chargebackCases.id, id)))
      .orderBy(asc(chargebackCases.requestDate)),
  ]);
  return { case: c, events, original, invoice, customer, ledger: ledger[0] ?? null, balance: balance!, siblings };
}

export function sumCents(values: (string | null | undefined)[]) {
  return fromCents(values.reduce((a, v) => a + toCents(v ?? "0"), 0));
}
