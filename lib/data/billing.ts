import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  activityLogs,
  brands,
  chargebackCases,
  customers,
  financialAdjustments,
  invoiceItems,
  invoices,
  legalEntities,
  saleItems,
  sales,
  transactions,
  users,
} from "@/lib/db/schema";
import { brandFilter, scopeCases, scopeInvoices } from "@/lib/auth/scope";
import { can, type Viewer } from "@/lib/auth/viewer";
import { PAGE_SIZE, type ListFilters } from "@/lib/filters";
import { toCents } from "@/lib/money";

/** Approved adjustments per invoice — they reduce the balance due but never amount_paid. */
export const approvedAdjSql = sql<string>`coalesce((select sum(fa.amount) from ${financialAdjustments} fa where fa.invoice_id = ${invoices.id} and fa.status = 'approved'), 0)`;
/** Adjusted balance = max(0, total − paid − approved adjustments). */
export const balanceSql = sql<string>`greatest(0, ${invoices.total} - ${invoices.amountPaid} - ${approvedAdjSql})`;

export function invoiceListWhere(viewer: Viewer, f: ListFilters) {
  const q = f.q.trim();
  const like = `%${q.replace(/[%_]/g, "")}%`;
  return and(
    scopeInvoices(viewer, f.brand),
    q
      ? or(
          ilike(invoices.invoiceNumber, like),
          ilike(invoices.id, like),
          ilike(invoices.customerId, like),
          ilike(customers.fullName, like),
          ilike(customers.companyName, like),
          can(viewer, "transactions.view")
            ? sql`exists (select 1 from ${transactions} t where t.invoice_id = ${invoices.id} and t.payment_reference ilike ${like})`
            : undefined,
        )
      : undefined,
    f.status ? eq(invoices.status, f.status as never) : undefined,
    f.agent ? eq(invoices.agentId, f.agent) : undefined,
    f.entity ? eq(invoices.legalEntityId, f.entity) : undefined,
    f.customer ? eq(invoices.customerId, f.customer) : undefined,
    f.from ? sql`${invoices.billingDate} >= ${f.from}` : undefined,
    f.to ? sql`${invoices.billingDate} <= ${f.to}` : undefined,
  );
}

export async function listInvoices(viewer: Viewer, f: ListFilters) {
  const db = await getDb();
  const where = invoiceListWhere(viewer, f);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        brandId: invoices.brandId,
        customerId: invoices.customerId,
        customerName: customers.fullName,
        companyName: customers.companyName,
        agentId: invoices.agentId,
        agentName: users.name,
        legalEntityId: invoices.legalEntityId,
        entityCode: legalEntities.internalCode,
        billingDate: invoices.billingDate,
        dueDate: invoices.dueDate,
        total: invoices.total,
        amountPaid: invoices.amountPaid,
        adjusted: approvedAdjSql,
        balance: balanceSql,
        currency: invoices.currency,
        status: invoices.status,
        paymentMethod: invoices.paymentMethod,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .leftJoin(users, eq(users.id, invoices.agentId))
      .leftJoin(legalEntities, eq(legalEntities.id, invoices.legalEntityId))
      .where(where)
      .orderBy(desc(invoices.billingDate), desc(invoices.id))
      .limit(PAGE_SIZE)
      .offset((f.page - 1) * PAGE_SIZE),
    db.select({ total: count() }).from(invoices).innerJoin(customers, eq(customers.id, invoices.customerId)).where(where),
  ]);
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
  const db = await getDb();
  const [row] = await db
    .select({
      billed: sql<string>`coalesce(sum(${invoices.total}) filter (where ${invoices.status} not in ('draft','cancelled')), 0)`,
      collected: sql<string>`coalesce(sum(${invoices.amountPaid}), 0)`,
      outstanding: sql<string>`coalesce(sum(${balanceSql}) filter (where ${invoices.status} in ('pending','partially_paid','overdue')), 0)`,
      overdueCount: sql<number>`count(*) filter (where ${invoices.status} = 'overdue')::int`,
      pendingCount: sql<number>`count(*) filter (where ${invoices.status} = 'pending')::int`,
      draftCount: sql<number>`count(*) filter (where ${invoices.status} = 'draft')::int`,
      n: sql<number>`count(*)::int`,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(invoiceListWhere(viewer, f));
  return {
    billed: toCents(row.billed),
    collected: toCents(row.collected),
    outstanding: toCents(row.outstanding),
    overdueCount: Number(row.overdueCount),
    pendingCount: Number(row.pendingCount),
    draftCount: Number(row.draftCount),
    n: Number(row.n),
  };
}

export async function getInvoiceDetail(viewer: Viewer, id: string) {
  const db = await getDb();
  const [inv] = await db
    .select({
      invoice: invoices,
      customerName: customers.fullName,
      customerCompany: customers.companyName,
      customerEmail: customers.email,
      agentName: users.name,
      agentEmail: users.email,
      entityName: legalEntities.registeredName,
      entityCode: legalEntities.internalCode,
      entityJurisdiction: legalEntities.jurisdiction,
      brandName: brands.name,
      allowedPaymentMethods: brands.allowedPaymentMethods,
      saleDate: sales.saleDate,
      saleStatus: sales.status,
      saleNotes: sales.notes,
    })
    .from(invoices)
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .innerJoin(brands, eq(brands.id, invoices.brandId))
    .innerJoin(sales, eq(sales.id, invoices.saleId))
    .leftJoin(users, eq(users.id, invoices.agentId))
    .leftJoin(legalEntities, eq(legalEntities.id, invoices.legalEntityId))
    .where(and(eq(invoices.id, id), scopeInvoices(viewer)))
    .limit(1);
  if (!inv) return null;
  const invoice = inv.invoice;

  const [items, saleLines, ledger, cases, adjustments, activity] = await Promise.all([
    db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id)).orderBy(asc(invoiceItems.id)),
    db.select().from(saleItems).where(eq(saleItems.saleId, invoice.saleId)).orderBy(asc(saleItems.id)),
    db
      .select({
        id: transactions.id,
        type: transactions.type,
        status: transactions.status,
        amount: transactions.amount,
        currency: transactions.currency,
        paymentMethod: transactions.paymentMethod,
        processor: transactions.processor,
        paymentReference: transactions.paymentReference,
        occurredAt: transactions.occurredAt,
        relatedTransactionId: transactions.relatedTransactionId,
        chargebackCaseId: transactions.chargebackCaseId,
        adjustmentId: transactions.adjustmentId,
        notes: transactions.notes,
        createdByName: users.name,
      })
      .from(transactions)
      .leftJoin(users, eq(users.id, transactions.createdBy))
      .where(eq(transactions.invoiceId, id))
      .orderBy(asc(transactions.occurredAt), asc(transactions.id)),
    can(viewer, "chargebacks.view")
      ? db
          .select({
            id: chargebackCases.id,
            caseType: chargebackCases.caseType,
            status: chargebackCases.status,
            amount: chargebackCases.amount,
            currency: chargebackCases.currency,
            reasonCode: chargebackCases.reasonCode,
            requestDate: chargebackCases.requestDate,
          })
          .from(chargebackCases)
          .where(and(eq(chargebackCases.invoiceId, id), scopeCases(viewer)))
          .orderBy(desc(chargebackCases.requestDate))
      : Promise.resolve([]),
    db
      .select({
        id: financialAdjustments.id,
        type: financialAdjustments.type,
        status: financialAdjustments.status,
        amount: financialAdjustments.amount,
        currency: financialAdjustments.currency,
        reason: financialAdjustments.reason,
        createdAt: financialAdjustments.createdAt,
        requestedByName: users.name,
      })
      .from(financialAdjustments)
      .leftJoin(users, eq(users.id, financialAdjustments.requestedBy))
      .where(eq(financialAdjustments.invoiceId, id))
      .orderBy(desc(financialAdjustments.createdAt)),
    db
      .select({ id: activityLogs.id, action: activityLogs.action, summary: activityLogs.summary, createdAt: activityLogs.createdAt, actor: users.name })
      .from(activityLogs)
      .leftJoin(users, eq(users.id, activityLogs.actorId))
      .where(
        or(
          and(eq(activityLogs.entityType, "invoice"), eq(activityLogs.entityId, id)),
          and(eq(activityLogs.entityType, "sale"), eq(activityLogs.entityId, invoice.saleId)),
          sql`${activityLogs.metadata} ->> 'invoiceId' = ${id}`,
        ),
      )
      .orderBy(desc(activityLogs.createdAt), desc(activityLogs.id))
      .limit(60),
  ]);

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

/* ------------------------------------------------------- adjustments */

export function adjustmentWhere(viewer: Viewer, f: ListFilters) {
  const q = f.q.trim();
  const like = `%${q.replace(/[%_]/g, "")}%`;
  return and(
    inArray(financialAdjustments.brandId, brandFilter(viewer, f.brand)),
    viewer.entityIds === "all" ? undefined : inArray(financialAdjustments.legalEntityId, viewer.entityIds.length ? viewer.entityIds : ["__none__"]),
    f.status ? eq(financialAdjustments.status, f.status as never) : undefined,
    f.type ? eq(financialAdjustments.type, f.type as never) : undefined,
    f.entity ? eq(financialAdjustments.legalEntityId, f.entity) : undefined,
    q
      ? or(
          ilike(financialAdjustments.id, like),
          ilike(invoices.invoiceNumber, like),
          ilike(customers.fullName, like),
          ilike(financialAdjustments.reason, like),
        )
      : undefined,
    f.from ? sql`${financialAdjustments.createdAt} >= ${f.from}` : undefined,
    f.to ? sql`${financialAdjustments.createdAt} <= ${f.to}` : undefined,
  );
}

