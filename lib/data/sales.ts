import "server-only";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  activityLogs,
  customers,
  invoices,
  legalEntities,
  productsServices,
  saleItems,
  sales,
  users,
} from "@/lib/db/schema";
import { scopeInvoices, scopeSales } from "@/lib/auth/scope";
import { can, canAccessEntity, type Viewer } from "@/lib/auth/viewer";
import { PAGE_SIZE, type ListFilters } from "@/lib/filters";
import { SALE_STATUS } from "@/components/sales/vocab";

export type SalesListOptions = {
  /** Forces attribution to the viewer (My Sales). */
  mine?: boolean;
};

/**
 * Shared WHERE clause for the sales list, its summary and the export. Scope
 * (brand, legal entity, own-sales-only) is always applied; the agent filter
 * is ignored for viewers who may only see their own sales.
 */
export function salesListWhere(viewer: Viewer, f: ListFilters, opts: SalesListOptions = {}) {
  const q = f.q.trim();
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const agent = opts.mine ? viewer.id : can(viewer, "sales.view_all") ? f.agent : null;
  return and(
    scopeSales(viewer, f.brand),
    q ? or(ilike(sales.id, like), ilike(customers.fullName, like), ilike(customers.id, like)) : undefined,
    agent ? eq(sales.agentId, agent) : undefined,
    f.entity ? (canAccessEntity(viewer, f.entity) ? eq(sales.legalEntityId, f.entity) : sql`false`) : undefined,
    f.status && f.status in SALE_STATUS ? eq(sales.status, f.status as "open" | "completed" | "cancelled") : undefined,
    f.customer ? eq(sales.customerId, f.customer) : undefined,
    f.from ? sql`${sales.saleDate} >= ${f.from}` : undefined,
    f.to ? sql`${sales.saleDate} <= ${f.to}` : undefined,
  );
}

export async function listSales(viewer: Viewer, f: ListFilters, opts: SalesListOptions = {}) {
  const db = await getDb();
  const where = salesListWhere(viewer, f, opts);
  const [rows, [{ total }], summary] = await Promise.all([
    db
      .select({
        id: sales.id,
        saleDate: sales.saleDate,
        brandId: sales.brandId,
        customerId: sales.customerId,
        customerName: customers.fullName,
        agentId: sales.agentId,
        agentName: users.name,
        legalEntityId: sales.legalEntityId,
        entityCode: legalEntities.internalCode,
        total: sales.total,
        currency: sales.currency,
        status: sales.status,
        invoiceId: sql<string | null>`(select i.id from invoices i where i.sale_id = "sales"."id" order by i.billing_date limit 1)`,
        invoiceNumber: sql<string | null>`(select i.invoice_number from invoices i where i.sale_id = "sales"."id" order by i.billing_date limit 1)`,
      })
      .from(sales)
      .innerJoin(customers, eq(customers.id, sales.customerId))
      .leftJoin(users, eq(users.id, sales.agentId))
      .leftJoin(legalEntities, eq(legalEntities.id, sales.legalEntityId))
      .where(where)
      .orderBy(desc(sales.saleDate), desc(sales.id))
      .limit(PAGE_SIZE)
      .offset((f.page - 1) * PAGE_SIZE),
    db.select({ total: count() }).from(sales).innerJoin(customers, eq(customers.id, sales.customerId)).where(where),
    // Summary uses the exact same filters. Gross excludes cancelled sales.
    db
      .select({
        currency: sales.currency,
        n: count(),
        gross: sql<string>`coalesce(sum(${sales.total}) filter (where ${sales.status} <> 'cancelled'), 0)::text`,
        cancelled: sql<number>`(count(*) filter (where ${sales.status} = 'cancelled'))::int`,
      })
      .from(sales)
      .innerJoin(customers, eq(customers.id, sales.customerId))
      .where(where)
      .groupBy(sales.currency)
      .orderBy(asc(sales.currency)),
  ]);
  return { rows, total, summary };
}

/** Loads one sale only if it is inside the viewer's scope. */
export async function getSaleDetail(viewer: Viewer, id: string) {
  const db = await getDb();
  const [sale] = await db
    .select({
      sale: sales,
      customerName: customers.fullName,
      customerEmail: customers.email,
      customerCompany: customers.companyName,
      agentName: users.name,
      agentEmail: users.email,
      entityName: legalEntities.registeredName,
      entityCode: legalEntities.internalCode,
      entityJurisdiction: legalEntities.jurisdiction,
    })
    .from(sales)
    .innerJoin(customers, eq(customers.id, sales.customerId))
    .leftJoin(users, eq(users.id, sales.agentId))
    .leftJoin(legalEntities, eq(legalEntities.id, sales.legalEntityId))
    .where(and(eq(sales.id, id), scopeSales(viewer)))
    .limit(1);
  if (!sale) return null;

  const [items, invoiceRows, createdBy] = await Promise.all([
    db
      .select({
        id: saleItems.id,
        description: saleItems.description,
        productId: saleItems.productId,
        sku: productsServices.sku,
        quantity: saleItems.quantity,
        unitPrice: saleItems.unitPrice,
        discount: saleItems.discount,
        taxRate: saleItems.taxRate,
        lineTotal: saleItems.lineTotal,
      })
      .from(saleItems)
      .leftJoin(productsServices, eq(productsServices.id, saleItems.productId))
      .where(eq(saleItems.saleId, id))
      .orderBy(asc(saleItems.id)),
    can(viewer, "billing.view")
      ? db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            billingDate: invoices.billingDate,
            dueDate: invoices.dueDate,
            total: invoices.total,
            amountPaid: invoices.amountPaid,
            currency: invoices.currency,
            status: invoices.status,
            legalEntityId: invoices.legalEntityId,
          })
          .from(invoices)
          .where(and(eq(invoices.saleId, id), scopeInvoices(viewer)))
          .orderBy(asc(invoices.billingDate))
      : Promise.resolve([]),
    db.select({ name: users.name }).from(users).where(eq(users.id, sale.sale.createdBy)).then((r) => r[0]?.name ?? null),
  ]);

  const entityIds = [id, ...invoiceRows.map((i) => i.id)];
  const activity = await db
    .select({ id: activityLogs.id, action: activityLogs.action, summary: activityLogs.summary, createdAt: activityLogs.createdAt, actor: users.name })
    .from(activityLogs)
    .leftJoin(users, eq(users.id, activityLogs.actorId))
    .where(inArray(activityLogs.entityId, entityIds))
    .orderBy(desc(activityLogs.createdAt))
    .limit(50);

  return { ...sale, items, invoices: invoiceRows, activity, createdByName: createdBy };
}
