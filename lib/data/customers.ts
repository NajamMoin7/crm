import "server-only";
import type { Filter } from "mongodb";
import { getDb, type RowOf } from "@/lib/db";
import { contains, decStr, equalsCi, ids, sumDec, uniq } from "@/lib/db/query";
import { brandFilter, scopeCases, scopeCustomers, scopeInvoices, scopeSales } from "@/lib/auth/scope";
import { can, type Viewer } from "@/lib/auth/viewer";
import { PAGE_SIZE, type ListFilters } from "@/lib/filters";

type CustomerFilter = Filter<RowOf<"customers">>;

export function customerSearchCond(q: string): CustomerFilter | undefined {
  if (!q) return undefined;
  const like = contains(q);
  const digits = q.replace(/\D/g, "");
  return {
    $or: [
      { id: like },
      { fullName: like },
      { email: like },
      { companyName: like },
      ...(digits.length >= 4 ? [{ phoneNormalized: contains(digits) }] : []),
    ],
  };
}

/** Filter for the customer list (async: scoping reads brand links and sales). */
export async function customerListWhere(viewer: Viewer, f: ListFilters): Promise<CustomerFilter> {
  const conds: CustomerFilter[] = [await scopeCustomers(viewer, f.brand)];
  const search = customerSearchCond(f.q);
  if (search) conds.push(search);
  if (f.status) conds.push({ status: f.status as never });
  if (f.agent) conds.push({ assignedAgentId: f.agent });
  if (f.from) conds.push({ createdAt: { $gte: f.from } });
  if (f.to) conds.push({ createdAt: { $lte: f.to } });
  return { $and: conds };
}

/** Sorted brand ids per customer (null when none, like array_agg). */
async function brandIdsFor(customerIds: string[]) {
  const C = await getDb();
  const rels = await C.customerBrandRelationships.find({ customerId: { $in: ids(customerIds) } }).toArray();
  const map = new Map<string, string[]>();
  for (const r of rels) (map.get(r.customerId) ?? map.set(r.customerId, []).get(r.customerId)!).push(r.brandId);
  for (const list of map.values()) list.sort();
  return (id: string): string[] | null => map.get(id) ?? null;
}

async function userNames(userIds: (string | null | undefined)[]) {
  const C = await getDb();
  const rows = await C.users.find({ id: { $in: ids(uniq(userIds)) } }, { projection: { id: 1, name: 1 } }).toArray();
  return new Map(rows.map((u) => [u.id, u.name]));
}

export async function listCustomers(viewer: Viewer, f: ListFilters, opts: { limit?: number } = {}) {
  const C = await getDb();
  const where = await customerListWhere(viewer, f);
  const limit = opts.limit ?? PAGE_SIZE;
  const [page, total] = await Promise.all([
    C.customers.find(where, { sort: { lastActivityAt: -1, id: 1 }, skip: (f.page - 1) * limit, limit }).toArray(),
    C.customers.countDocuments(where),
  ]);
  const pageIds = page.map((c) => c.id);
  // Sales totals respect the same scope, so an agent only sees totals of their own sales.
  const [totals, brandsOf, names] = await Promise.all([
    C.sales
      .aggregate<{ _id: string; total: unknown; n: number }>([
        { $match: { $and: [scopeSales(viewer, f.brand), { status: { $ne: "cancelled" } }, { customerId: { $in: ids(pageIds) } }] } },
        { $group: { _id: "$customerId", total: sumDec("$total"), n: { $sum: 1 } } },
      ])
      .toArray(),
    brandIdsFor(pageIds),
    userNames(page.map((c) => c.assignedAgentId)),
  ]);
  const rows = page.map((c) => {
    const t = totals.find((x) => x._id === c.id);
    return {
      id: c.id,
      fullName: c.fullName,
      email: c.email,
      phone: c.phone,
      companyName: c.companyName,
      country: c.country,
      status: c.status,
      assignedAgentId: c.assignedAgentId,
      agentName: c.assignedAgentId ? (names.get(c.assignedAgentId) ?? null) : null,
      lastActivityAt: c.lastActivityAt,
      createdAt: c.createdAt,
      salesTotal: t ? decStr(t.total) : null,
      salesCount: t ? t.n : null,
      brandIds: brandsOf(c.id),
    };
  });
  return { rows, total };
}

/** Loads a customer only if the viewer may see it (merged records remain viewable). */
export async function getCustomerForViewer(viewer: Viewer, id: string) {
  const C = await getDb();
  return C.customers.findOne({ $and: [{ id }, await scopeCustomers(viewer, null, { includeMerged: true })] });
}

export async function getCustomerProfile(viewer: Viewer, id: string) {
  const C = await getDb();
  const customer = await getCustomerForViewer(viewer, id);
  if (!customer) return null;

  const [brandRels, saleDocs, invoiceRows, caseRows, paymentRows, noteDocs, activityDocs, agent, dupes] = await Promise.all([
    C.customerBrandRelationships.find({ customerId: id }).toArray(),
    C.sales.find({ $and: [{ customerId: id }, scopeSales(viewer)] }, { sort: { saleDate: -1 } }).toArray(),
    can(viewer, "billing.view")
      ? C.invoices
          .find({ $and: [{ customerId: id }, scopeInvoices(viewer)] }, { sort: { billingDate: -1 } })
          .toArray()
          .then((rows) =>
            rows.map((i) => ({
              id: i.id, invoiceNumber: i.invoiceNumber, brandId: i.brandId, legalEntityId: i.legalEntityId,
              billingDate: i.billingDate, dueDate: i.dueDate, total: i.total, amountPaid: i.amountPaid,
              currency: i.currency, status: i.status, paymentMethod: i.paymentMethod,
            })),
          )
      : Promise.resolve([]),
    can(viewer, "chargebacks.view")
      ? C.chargebackCases
          .find({ $and: [{ customerId: id }, scopeCases(viewer)] }, { sort: { requestDate: -1 } })
          .toArray()
          .then((rows) =>
            rows.map((k) => ({
              id: k.id, caseType: k.caseType, brandId: k.brandId, status: k.status, amount: k.amount, currency: k.currency,
              reasonCode: k.reasonCode, requestDate: k.requestDate, invoiceId: k.invoiceId,
              originalLegalEntityId: k.originalLegalEntityId, responsibleLegalEntityId: k.responsibleLegalEntityId,
            })),
          )
      : Promise.resolve([]),
    can(viewer, "billing.view")
      ? (async () => {
          const invIds = await C.invoices.distinct("id", { $and: [{ customerId: id }, scopeInvoices(viewer)] });
          const txns = await C.transactions.find({ invoiceId: { $in: ids(invIds) } }, { sort: { occurredAt: -1 } }).toArray();
          return txns.map((t) => ({
            id: t.id, type: t.type, status: t.status, amount: t.amount, currency: t.currency, paymentReference: t.paymentReference,
            occurredAt: t.occurredAt, invoiceId: t.invoiceId, brandId: t.brandId, method: t.paymentMethod,
          }));
        })()
      : Promise.resolve([]),
    C.notes
      .find(
        { entityType: "customer", entityId: id, ...(can(viewer, "transactions.view") ? {} : { visibility: "internal" }) },
        { sort: { createdAt: -1 } },
      )
      .toArray(),
    C.activityLogs
      .find({ $or: [{ entityType: "customer", entityId: id }, { "metadata.customerId": id }] }, { sort: { createdAt: -1 }, limit: 50 })
      .toArray(),
    customer.assignedAgentId
      ? C.users.findOne({ id: customer.assignedAgentId }, { projection: { id: 1, name: 1, email: 1 } }).then((u) => (u ? { id: u.id, name: u.name, email: u.email } : null))
      : Promise.resolve(null),
    C.duplicateCandidates.find({ status: "open", $or: [{ customerAId: id }, { customerBId: id }] }).toArray(),
  ]);
  const names = await userNames([...saleDocs.map((s) => s.agentId), ...noteDocs.map((n) => n.authorId), ...activityDocs.map((a) => a.actorId)]);
  const saleRows = saleDocs.map((s) => ({
    id: s.id, brandId: s.brandId, agentId: s.agentId, agentName: names.get(s.agentId) ?? null, legalEntityId: s.legalEntityId,
    saleDate: s.saleDate, total: s.total, currency: s.currency, status: s.status,
  }));
  const noteRows = noteDocs.map((n) => ({ id: n.id, body: n.body, visibility: n.visibility, createdAt: n.createdAt, author: names.get(n.authorId) ?? null }));
  const activity = activityDocs.map((a) => ({
    id: a.id, action: a.action, summary: a.summary, createdAt: a.createdAt, actor: a.actorId ? (names.get(a.actorId) ?? null) : null,
  }));

  return { customer, brandRels, saleRows, invoiceRows, caseRows, paymentRows, noteRows, activity, agent, dupes };
}

/** Last 10 digits of a phone, for "right(phone, 10)" comparisons. */
const last10 = (digits: string) => digits.slice(-10);
const endsWith = (digits: string) => new RegExp(`${last10(digits)}$`);

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
  const C = await getDb();
  const brandIds = brandFilter(viewer, null);
  const conds: CustomerFilter[] = [];
  const q = input.query?.trim() ?? "";
  if (q) {
    conds.push({ id: equalsCi(q) });
    if (q.includes("@")) conds.push({ email: equalsCi(q) });
    const digits = q.replace(/\D/g, "");
    if (digits.length >= 7) conds.push({ phoneNormalized: endsWith(digits) });
    if (q.length >= 3 && !q.includes("@") && digits.length < 4) conds.push({ fullName: contains(q) });
  }
  if (input.email) conds.push({ email: equalsCi(input.email.trim()) });
  if (input.phone) {
    const d = input.phone.replace(/\D/g, "");
    if (d.length >= 7) conds.push({ phoneNormalized: endsWith(d) });
  }
  if (input.name && input.name.trim().length >= 3) conds.push({ fullName: equalsCi(input.name.trim()) });
  if (conds.length === 0) return [];

  const where: CustomerFilter[] = [{ $or: conds }, { archivedAt: null }];
  if (!opts.global) {
    // In the viewer's brands — or not yet billed under any brand.
    const [inBrands, linked] = await Promise.all([
      C.customerBrandRelationships.distinct("customerId", { brandId: { $in: brandIds } }),
      C.customerBrandRelationships.distinct("customerId"),
    ]);
    where.push({ $or: [{ id: { $in: ids(inBrands) } }, { id: { $nin: linked } }] });
  }
  const docs = await C.customers.find({ $and: where }, { limit: 10 }).toArray();
  const brandsOf = await brandIdsFor(docs.map((d) => d.id));

  return docs.map((d) => {
    const r = {
      id: d.id,
      fullName: d.fullName,
      email: d.email,
      phone: d.phone,
      phoneNormalized: d.phoneNormalized,
      companyName: d.companyName,
      billingAddress: d.billingAddress,
      country: d.country,
      assignedAgentId: d.assignedAgentId,
      mergedIntoId: d.mergedIntoId,
      brandIds: brandsOf(d.id),
    };
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
  const C = await getDb();
  const rows = await C.duplicateCandidates.find({ status: status as never }, { sort: { score: -1 } }).toArray();
  const pairIds = [...new Set(rows.flatMap((r) => [r.customerAId, r.customerBId]))];
  let custs: {
    id: string; fullName: string; email: string | null; phone: string | null; companyName: string | null; city: string | null;
    country: string | null; createdAt: Date; acquisitionSource: string | null; mergedIntoId: string | null;
    brandIds: string[] | null; salesCount: number; invoiceCount: number;
  }[] = [];
  if (pairIds.length) {
    const docs = await C.customers.find({ $and: [{ id: { $in: pairIds } }, await scopeCustomers(viewer, null, { includeMerged: true })] }).toArray();
    const docIds = docs.map((d) => d.id);
    const [brandsOf, saleCounts, invoiceCounts] = await Promise.all([
      brandIdsFor(docIds),
      C.sales.aggregate<{ _id: string; n: number }>([{ $match: { customerId: { $in: ids(docIds) } } }, { $group: { _id: "$customerId", n: { $sum: 1 } } }]).toArray(),
      C.invoices.aggregate<{ _id: string; n: number }>([{ $match: { customerId: { $in: ids(docIds) } } }, { $group: { _id: "$customerId", n: { $sum: 1 } } }]).toArray(),
    ]);
    custs = docs.map((c) => ({
      id: c.id, fullName: c.fullName, email: c.email, phone: c.phone, companyName: c.companyName, city: c.city, country: c.country,
      createdAt: c.createdAt, acquisitionSource: c.acquisitionSource, mergedIntoId: c.mergedIntoId,
      brandIds: brandsOf(c.id),
      salesCount: saleCounts.find((x) => x._id === c.id)?.n ?? 0,
      invoiceCount: invoiceCounts.find((x) => x._id === c.id)?.n ?? 0,
    }));
  }
  const map = new Map(custs.map((c) => [c.id, c]));
  // Pairs where either record is outside the viewer's scope are hidden entirely.
  return rows.filter((r) => map.has(r.customerAId) && map.has(r.customerBId)).map((r) => ({ ...r, a: map.get(r.customerAId)!, b: map.get(r.customerBId)! }));
}
