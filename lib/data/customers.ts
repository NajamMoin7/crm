import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql, sum } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  activityLogs,
  chargebackCases,
  customerBrandRelationships,
  customers,
  duplicateCandidates,
  invoices,
  notes,
  sales,
  transactions,
  users,
} from "@/lib/db/schema";
import { brandFilter, scopeCases, scopeCustomers, scopeInvoices, scopeSales } from "@/lib/auth/scope";
import { can, type Viewer } from "@/lib/auth/viewer";
import { PAGE_SIZE, type ListFilters } from "@/lib/filters";

export function customerSearchCond(q: string) {
  if (!q) return undefined;
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const digits = q.replace(/\D/g, "");
  return or(
    ilike(customers.id, like),
    ilike(customers.fullName, like),
    ilike(customers.email, like),
    ilike(customers.companyName, like),
    digits.length >= 4 ? ilike(customers.phoneNormalized, `%${digits}%`) : undefined,
  );
}

export function customerListWhere(viewer: Viewer, f: ListFilters) {
  return and(
    scopeCustomers(viewer, f.brand),
    customerSearchCond(f.q),
    f.status ? eq(customers.status, f.status as never) : undefined,
    f.agent ? eq(customers.assignedAgentId, f.agent) : undefined,
    f.from ? sql`${customers.createdAt} >= ${f.from}` : undefined,
    f.to ? sql`${customers.createdAt} <= ${f.to}` : undefined,
  );
}

export async function listCustomers(viewer: Viewer, f: ListFilters, opts: { limit?: number } = {}) {
  const db = await getDb();
  const where = customerListWhere(viewer, f);
  const limit = opts.limit ?? PAGE_SIZE;
  // Sales totals respect the same scope, so an agent only sees totals of their own sales.
  const saleTotals = db
    .select({ customerId: sales.customerId, total: sum(sales.total).as("total"), n: count().as("n") })
    .from(sales)
    .where(and(scopeSales(viewer, f.brand), ne(sales.status, "cancelled")))
    .groupBy(sales.customerId)
    .as("st");

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: customers.id,
        fullName: customers.fullName,
        email: customers.email,
        phone: customers.phone,
        companyName: customers.companyName,
        country: customers.country,
        status: customers.status,
        assignedAgentId: customers.assignedAgentId,
        agentName: users.name,
        lastActivityAt: customers.lastActivityAt,
        createdAt: customers.createdAt,
        salesTotal: saleTotals.total,
        salesCount: saleTotals.n,
        brandIds: sql<string[]>`(select array_agg(${customerBrandRelationships.brandId} order by ${customerBrandRelationships.brandId}) from ${customerBrandRelationships} where ${customerBrandRelationships.customerId} = ${customers.id})`,
      })
      .from(customers)
      .leftJoin(users, eq(users.id, customers.assignedAgentId))
      .leftJoin(saleTotals, eq(saleTotals.customerId, customers.id))
      .where(where)
      .orderBy(desc(customers.lastActivityAt), asc(customers.id))
      .limit(limit)
      .offset((f.page - 1) * limit),
    db.select({ total: count() }).from(customers).where(where),
  ]);
  return { rows, total };
}

/** Loads a customer only if the viewer may see it (merged records remain viewable). */
export async function getCustomerForViewer(viewer: Viewer, id: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), scopeCustomers(viewer, null, { includeMerged: true })))
    .limit(1);
  return row ?? null;
}

export async function getCustomerProfile(viewer: Viewer, id: string) {
  const db = await getDb();
  const customer = await getCustomerForViewer(viewer, id);
  if (!customer) return null;

  const [brandRels, saleRows, invoiceRows, caseRows, paymentRows, noteRows, activity, agent, dupes] = await Promise.all([
    db.select().from(customerBrandRelationships).where(eq(customerBrandRelationships.customerId, id)),
    db
      .select({
        id: sales.id, brandId: sales.brandId, agentId: sales.agentId, agentName: users.name, legalEntityId: sales.legalEntityId,
        saleDate: sales.saleDate, total: sales.total, currency: sales.currency, status: sales.status,
      })
      .from(sales)
      .leftJoin(users, eq(users.id, sales.agentId))
      .where(and(eq(sales.customerId, id), scopeSales(viewer)))
      .orderBy(desc(sales.saleDate)),
    can(viewer, "billing.view")
      ? db
          .select({
            id: invoices.id, invoiceNumber: invoices.invoiceNumber, brandId: invoices.brandId, legalEntityId: invoices.legalEntityId,
            billingDate: invoices.billingDate, dueDate: invoices.dueDate, total: invoices.total, amountPaid: invoices.amountPaid,
            currency: invoices.currency, status: invoices.status, paymentMethod: invoices.paymentMethod,
          })
          .from(invoices)
          .where(and(eq(invoices.customerId, id), scopeInvoices(viewer)))
          .orderBy(desc(invoices.billingDate))
      : Promise.resolve([]),
    can(viewer, "chargebacks.view")
      ? db
          .select({
            id: chargebackCases.id, caseType: chargebackCases.caseType, brandId: chargebackCases.brandId, status: chargebackCases.status,
            amount: chargebackCases.amount, currency: chargebackCases.currency, reasonCode: chargebackCases.reasonCode,
            requestDate: chargebackCases.requestDate, invoiceId: chargebackCases.invoiceId,
            originalLegalEntityId: chargebackCases.originalLegalEntityId, responsibleLegalEntityId: chargebackCases.responsibleLegalEntityId,
          })
          .from(chargebackCases)
          .where(and(eq(chargebackCases.customerId, id), scopeCases(viewer)))
          .orderBy(desc(chargebackCases.requestDate))
      : Promise.resolve([]),
    can(viewer, "billing.view")
      ? db
          .select({
            id: transactions.id, type: transactions.type, status: transactions.status, amount: transactions.amount,
            currency: transactions.currency, paymentReference: transactions.paymentReference, occurredAt: transactions.occurredAt,
            invoiceId: transactions.invoiceId, brandId: transactions.brandId, method: transactions.paymentMethod,
          })
          .from(transactions)
          .innerJoin(invoices, eq(invoices.id, transactions.invoiceId))
          .where(and(eq(invoices.customerId, id), scopeInvoices(viewer)))
          .orderBy(desc(transactions.occurredAt))
      : Promise.resolve([]),
    db
      .select({ id: notes.id, body: notes.body, visibility: notes.visibility, createdAt: notes.createdAt, author: users.name })
      .from(notes)
      .leftJoin(users, eq(users.id, notes.authorId))
      .where(
        and(
          eq(notes.entityType, "customer"),
          eq(notes.entityId, id),
          can(viewer, "transactions.view") ? undefined : eq(notes.visibility, "internal"),
        ),
      )
      .orderBy(desc(notes.createdAt)),
    db
      .select({ id: activityLogs.id, action: activityLogs.action, summary: activityLogs.summary, createdAt: activityLogs.createdAt, actor: users.name })
      .from(activityLogs)
      .leftJoin(users, eq(users.id, activityLogs.actorId))
      .where(
        or(
          and(eq(activityLogs.entityType, "customer"), eq(activityLogs.entityId, id)),
          sql`${activityLogs.metadata} ->> 'customerId' = ${id}`,
        ),
      )
      .orderBy(desc(activityLogs.createdAt))
      .limit(50),
    customer.assignedAgentId
      ? db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, customer.assignedAgentId)).then((r) => r[0] ?? null)
      : Promise.resolve(null),
    db
      .select()
      .from(duplicateCandidates)
      .where(and(eq(duplicateCandidates.status, "open"), or(eq(duplicateCandidates.customerAId, id), eq(duplicateCandidates.customerBId, id)))),
  ]);

  return { customer, brandRels, saleRows, invoiceRows, caseRows, paymentRows, noteRows, activity, agent, dupes };
}

/**
 * Identity matching used before creating a customer or billing record.
 * Exact identifiers (customer id, email, phone) are matched across all
 * customers in the viewer's brands — the agent must already know the value —
 * and contact details are masked for records the viewer doesn't own.
 * Never auto-merges: it only reports candidates.
 */
export async function findCustomerMatches(
  viewer: Viewer,
  input: { query?: string; email?: string; phone?: string; name?: string },
  /** global: search every customer (duplicate prevention); callers must mask what the viewer can't see. */
  opts: { global?: boolean } = {},
) {
  const db = await getDb();
  const brandIds = brandFilter(viewer, null);
  const conds = [];
  const q = input.query?.trim() ?? "";
  if (q) {
    conds.push(eq(sql`upper(${customers.id})`, q.toUpperCase()));
    if (q.includes("@")) conds.push(eq(sql`lower(${customers.email})`, q.toLowerCase()));
    const digits = q.replace(/\D/g, "");
    if (digits.length >= 7) conds.push(sql`right(${customers.phoneNormalized}, 10) = right(${digits}, 10)`);
    if (q.length >= 3 && !q.includes("@") && digits.length < 4) conds.push(ilike(customers.fullName, `%${q.replace(/[%_]/g, "")}%`));
  }
  if (input.email) conds.push(eq(sql`lower(${customers.email})`, input.email.trim().toLowerCase()));
  if (input.phone) {
    const d = input.phone.replace(/\D/g, "");
    if (d.length >= 7) conds.push(sql`right(${customers.phoneNormalized}, 10) = right(${d}, 10)`);
  }
  if (input.name && input.name.trim().length >= 3) conds.push(sql`lower(${customers.fullName}) = ${input.name.trim().toLowerCase()}`);
  if (conds.length === 0) return [];

  const rows = await db
    .select({
      id: customers.id,
      fullName: customers.fullName,
      email: customers.email,
      phone: customers.phone,
      phoneNormalized: customers.phoneNormalized,
      companyName: customers.companyName,
      billingAddress: customers.billingAddress,
      country: customers.country,
      assignedAgentId: customers.assignedAgentId,
      mergedIntoId: customers.mergedIntoId,
      brandIds: sql<string[]>`(select array_agg(${customerBrandRelationships.brandId}) from ${customerBrandRelationships} where ${customerBrandRelationships.customerId} = ${customers.id})`,
    })
    .from(customers)
    .where(
      and(
        or(...conds),
        isNull(customers.archivedAt),
        opts.global
          ? undefined
          : // In the viewer's brands — or not yet billed under any brand.
            sql`(exists (select 1 from ${customerBrandRelationships} where ${customerBrandRelationships.customerId} = ${customers.id} and ${inArray(customerBrandRelationships.brandId, brandIds)}) or not exists (select 1 from ${customerBrandRelationships} where ${customerBrandRelationships.customerId} = ${customers.id}))`,
      ),
    )
    .limit(10);

  return rows.map((r) => {
    const reasons: string[] = [];
    if (q && r.id.toUpperCase() === q.toUpperCase()) reasons.push("Customer ID");
    const email = (input.email ?? (q.includes("@") ? q : "")).toLowerCase();
    if (email && r.email?.toLowerCase() === email) reasons.push("Email");
    const phone = (input.phone ?? q).replace(/\D/g, "");
    if (phone.length >= 7 && r.phoneNormalized?.slice(-10) === phone.slice(-10)) reasons.push("Phone");
    if ((input.name && r.fullName.toLowerCase() === input.name.trim().toLowerCase()) || (q && !reasons.length)) reasons.push("Name");
    return { ...r, reasons };
  });
}

export async function listDuplicateCandidates(viewer: Viewer, status = "open") {
  const db = await getDb();
  const rows = await db
    .select()
    .from(duplicateCandidates)
    .where(eq(duplicateCandidates.status, status as never))
    .orderBy(desc(duplicateCandidates.score));
  const ids = [...new Set(rows.flatMap((r) => [r.customerAId, r.customerBId]))];
  const custs = ids.length
    ? await db
        .select({
          id: customers.id, fullName: customers.fullName, email: customers.email, phone: customers.phone, companyName: customers.companyName,
          city: customers.city, country: customers.country, createdAt: customers.createdAt, acquisitionSource: customers.acquisitionSource,
          mergedIntoId: customers.mergedIntoId,
          brandIds: sql<string[]>`(select array_agg(${customerBrandRelationships.brandId}) from ${customerBrandRelationships} where ${customerBrandRelationships.customerId} = ${customers.id})`,
          salesCount: sql<number>`(select count(*)::int from sales s where s.customer_id = "customers"."id")`,
          invoiceCount: sql<number>`(select count(*)::int from invoices i where i.customer_id = "customers"."id")`,
        })
        .from(customers)
        .where(and(inArray(customers.id, ids), scopeCustomers(viewer, null, { includeMerged: true })))
    : [];
  const map = new Map(custs.map((c) => [c.id, c]));
  // Pairs where either record is outside the viewer's scope are hidden entirely.
  return rows.filter((r) => map.has(r.customerAId) && map.has(r.customerBId)).map((r) => ({ ...r, a: map.get(r.customerAId)!, b: map.get(r.customerBId)! }));
}
