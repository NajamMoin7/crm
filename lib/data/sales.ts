import "server-only";
import type { Filter } from "mongodb";
import { getDb, type RowOf } from "@/lib/db";
import { byKey, contains, dec, decStr, ids, NONE, uniq } from "@/lib/db/query";
import { scopeInvoices, scopeSales } from "@/lib/auth/scope";
import { can, canAccessEntity, type Viewer } from "@/lib/auth/viewer";
import { PAGE_SIZE, type ListFilters } from "@/lib/filters";
import { SALE_STATUS } from "@/components/sales/vocab";

type Sale = RowOf<"sales">;

export type SalesListOptions = {
  /** Forces attribution to the viewer (My Sales). */
  mine?: boolean;
};

/**
 * Shared filter for the sales list, its summary and the export. Scope
 * (brand, legal entity, own-sales-only) is always applied; the agent filter
 * is ignored for viewers who may only see their own sales.
 */
export async function salesListWhere(viewer: Viewer, f: ListFilters, opts: SalesListOptions = {}): Promise<Filter<Sale>> {
  const C = await getDb();
  const q = f.q.trim();
  const agent = opts.mine ? viewer.id : can(viewer, "sales.view_all") ? f.agent : null;
  const conds: Filter<Sale>[] = [scopeSales(viewer, f.brand)];
  if (q) {
    const rx = contains(q);
    const customerIds = await C.customers.distinct("id", { fullName: rx });
    conds.push({ $or: [{ id: rx }, { customerId: rx }, { customerId: { $in: customerIds } }] });
  }
  if (agent) conds.push({ agentId: agent });
  if (f.entity) conds.push({ legalEntityId: canAccessEntity(viewer, f.entity) ? f.entity : NONE });
  if (f.status && f.status in SALE_STATUS) conds.push({ status: f.status as Sale["status"] });
  if (f.customer) conds.push({ customerId: f.customer });
  if (f.from) conds.push({ saleDate: { $gte: f.from } });
  if (f.to) conds.push({ saleDate: { $lte: f.to } });
  return { $and: conds };
}

export async function listSales(viewer: Viewer, f: ListFilters, opts: SalesListOptions = {}) {
  const C = await getDb();
  const where = await salesListWhere(viewer, f, opts);
  const [page, total, summaryRows] = await Promise.all([
    C.sales.find(where, { sort: { saleDate: -1, id: -1 }, skip: (f.page - 1) * PAGE_SIZE, limit: PAGE_SIZE }).toArray(),
    C.sales.countDocuments(where),
    // Summary uses the exact same filters. Gross excludes cancelled sales.
    C.sales
      .aggregate<{ _id: string; n: number; gross: unknown; cancelled: number }>([
        { $match: where },
        {
          $group: {
            _id: "$currency",
            n: { $sum: 1 },
            gross: { $sum: { $cond: [{ $ne: ["$status", "cancelled"] }, dec("$total"), dec("0")] } },
            cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
  ]);
  const [custs, people, entities, invs] = await Promise.all([
    C.customers.find({ id: { $in: ids(uniq(page.map((s) => s.customerId))) } }, { projection: { id: 1, fullName: 1 } }).toArray(),
    C.users.find({ id: { $in: ids(uniq(page.map((s) => s.agentId))) } }, { projection: { id: 1, name: 1 } }).toArray(),
    C.legalEntities.find({ id: { $in: ids(uniq(page.map((s) => s.legalEntityId))) } }, { projection: { id: 1, internalCode: 1 } }).toArray(),
    C.invoices.find({ saleId: { $in: ids(page.map((s) => s.id)) } }, { sort: { billingDate: 1 }, projection: { id: 1, saleId: 1, invoiceNumber: 1 } }).toArray(),
  ]);
  const customerMap = byKey(custs, "id");
  const userMap = byKey(people, "id");
  const entityMap = byKey(entities, "id");
  // First invoice per sale (by billing date).
  const firstInvoice = new Map<string, (typeof invs)[number]>();
  for (const i of invs) if (!firstInvoice.has(i.saleId)) firstInvoice.set(i.saleId, i);
  const rows = page.map((s) => ({
    id: s.id,
    saleDate: s.saleDate,
    brandId: s.brandId,
    customerId: s.customerId,
    customerName: customerMap.get(s.customerId)?.fullName ?? "",
    agentId: s.agentId,
    agentName: userMap.get(s.agentId)?.name ?? null,
    legalEntityId: s.legalEntityId,
    entityCode: entityMap.get(s.legalEntityId)?.internalCode ?? null,
    total: s.total,
    currency: s.currency,
    status: s.status,
    invoiceId: firstInvoice.get(s.id)?.id ?? null,
    invoiceNumber: firstInvoice.get(s.id)?.invoiceNumber ?? null,
  }));
  const summary = summaryRows.map((r) => ({ currency: r._id, n: r.n, gross: decStr(r.gross), cancelled: r.cancelled }));
  return { rows, total, summary };
}

/** Loads one sale only if it is inside the viewer's scope. */
export async function getSaleDetail(viewer: Viewer, id: string) {
  const C = await getDb();
  const sale = await C.sales.findOne({ $and: [{ id }, scopeSales(viewer)] });
  if (!sale) return null;
  const [customer, agent, entity, createdBy] = await Promise.all([
    C.customers.findOne({ id: sale.customerId }),
    C.users.findOne({ id: sale.agentId }, { projection: { id: 1, name: 1, email: 1 } }),
    C.legalEntities.findOne({ id: sale.legalEntityId }),
    C.users.findOne({ id: sale.createdBy }, { projection: { id: 1, name: 1 } }),
  ]);
  if (!customer) return null;

  const [itemRows, invoiceRows] = await Promise.all([
    C.saleItems.find({ saleId: id }, { sort: { id: 1 } }).toArray(),
    can(viewer, "billing.view")
      ? C.invoices
          .find(
            { $and: [{ saleId: id }, scopeInvoices(viewer)] },
            {
              sort: { billingDate: 1 },
              projection: { id: 1, invoiceNumber: 1, billingDate: 1, dueDate: 1, total: 1, amountPaid: 1, currency: 1, status: 1, legalEntityId: 1 },
            },
          )
          .toArray()
      : Promise.resolve([]),
  ]);
  const products = byKey(
    await C.productsServices.find({ id: { $in: ids(uniq(itemRows.map((i) => i.productId))) } }, { projection: { id: 1, sku: 1 } }).toArray(),
    "id",
  );
  const items = itemRows.map((i) => ({
    id: i.id,
    description: i.description,
    productId: i.productId,
    sku: i.productId ? (products.get(i.productId)?.sku ?? null) : null,
    quantity: i.quantity,
    unitPrice: i.unitPrice,
    discount: i.discount,
    taxRate: i.taxRate,
    lineTotal: i.lineTotal,
  }));
  const invoices = invoiceRows.map((i) => ({
    id: i.id,
    invoiceNumber: i.invoiceNumber,
    billingDate: i.billingDate,
    dueDate: i.dueDate,
    total: i.total,
    amountPaid: i.amountPaid,
    currency: i.currency,
    status: i.status,
    legalEntityId: i.legalEntityId,
  }));

  const entityIds = [id, ...invoices.map((i) => i.id)];
  const logRows = await C.activityLogs.find({ entityId: { $in: entityIds } }, { sort: { createdAt: -1 }, limit: 50 }).toArray();
  const actors = byKey(await C.users.find({ id: { $in: ids(uniq(logRows.map((a) => a.actorId))) } }, { projection: { id: 1, name: 1 } }).toArray(), "id");
  const activity = logRows.map((a) => ({ id: a.id, action: a.action, summary: a.summary, createdAt: a.createdAt, actor: a.actorId ? (actors.get(a.actorId)?.name ?? null) : null }));

  return {
    sale,
    customerName: customer.fullName,
    customerEmail: customer.email,
    customerCompany: customer.companyName,
    agentName: agent?.name ?? null,
    agentEmail: agent?.email ?? null,
    entityName: entity?.registeredName ?? null,
    entityCode: entity?.internalCode ?? null,
    entityJurisdiction: entity?.jurisdiction ?? null,
    items,
    invoices,
    activity,
    createdByName: createdBy?.name ?? null,
  };
}
