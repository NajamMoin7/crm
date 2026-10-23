import "server-only";
import type { Filter } from "mongodb";
import { getDb, type RowOf } from "@/lib/db";
import { byKey, contains, dec, decStr, ids, startOf, uniq } from "@/lib/db/query";
import { scopeSales } from "@/lib/auth/scope";
import { can, type Viewer } from "@/lib/auth/viewer";

export type PeriodTotal = { cents: number; count: number };
export type AgentTotals = { agentId: string; name: string; today: PeriodTotal; prevMonth: PeriodTotal; thisMonth: PeriodTotal; year: PeriodTotal };

const cents = (v: unknown) => Math.round(Number(decStr(v)) * 100);

/**
 * Takings per agent for today, last month, this month and this year (non-cancelled
 * sales, by sale date, UTC periods). Super Admins see every agent; an agent
 * sees only their own row.
 */
export async function getAgentTotals(viewer: Viewer, brand: string | null): Promise<AgentTotals[]> {
  const C = await getDb();
  const now = new Date();
  const day = startOf("day", now);
  const month = startOf("month", now);
  const prevMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1));
  const year = startOf("year", now);
  const inPeriod = (from: Date, to?: Date) => (to ? { $and: [{ $gte: ["$saleDate", from] }, { $lt: ["$saleDate", to] }] } : { $gte: ["$saleDate", from] });
  const period = (cond: unknown) => ({
    sum: { $sum: { $cond: [cond, dec("$total"), dec("0")] } },
    n: { $sum: { $cond: [cond, 1, 0] } },
  });
  const t = period(inPeriod(day));
  const p = period(inPeriod(prevMonth, month));
  const m = period(inPeriod(month));
  const y = period(inPeriod(year));
  const rows = await C.sales
    .aggregate<{ _id: string; tSum: unknown; tN: number; pSum: unknown; pN: number; mSum: unknown; mN: number; ySum: unknown; yN: number }>([
      { $match: { $and: [scopeSales(viewer, brand), { status: { $ne: "cancelled" } }] } },
      { $group: { _id: "$agentId", tSum: t.sum, tN: t.n, pSum: p.sum, pN: p.n, mSum: m.sum, mN: m.n, ySum: y.sum, yN: y.n } },
    ])
    .toArray();

  // Every active agent appears (with zeros) so the table compares the whole team.
  let agentList: { id: string; name: string }[];
  if (can(viewer, "sales.view_all")) {
    const agentIds = await C.salesAgents.distinct("userId");
    agentList = await C.users.find({ id: { $in: ids(agentIds) }, status: "active" }, { projection: { id: 1, name: 1 } }).toArray();
  } else {
    agentList = [{ id: viewer.id, name: viewer.name }];
  }
  const allIds = new Set([...agentList.map((a) => a.id), ...rows.map((r) => r._id)]);
  const names = new Map(agentList.map((a) => [a.id, a.name]));
  const missing = [...allIds].filter((id) => !names.has(id));
  if (missing.length) {
    for (const u of await C.users.find({ id: { $in: missing } }, { projection: { id: 1, name: 1 } }).toArray()) names.set(u.id, u.name);
  }
  return [...allIds]
    .map((id) => {
      const r = rows.find((x) => x._id === id);
      return {
        agentId: id,
        name: names.get(id) ?? id,
        today: { cents: cents(r?.tSum), count: Number(r?.tN ?? 0) },
        prevMonth: { cents: cents(r?.pSum), count: Number(r?.pN ?? 0) },
        thisMonth: { cents: cents(r?.mSum), count: Number(r?.mN ?? 0) },
        year: { cents: cents(r?.ySum), count: Number(r?.yN ?? 0) },
      };
    })
    .sort((a, b) => b.thisMonth.cents - a.thisMonth.cents || b.year.cents - a.year.cents || a.name.localeCompare(b.name));
}

export const ORDERS_PAGE_SIZE = 20;

/** Orders = invoices with their sale, customer, agent, latest payment and chargeback count. */
export async function listOrders(viewer: Viewer, f: { q: string; brand: string | null; agent: string | null; page: number }) {
  const C = await getDb();
  const q = f.q.trim();
  const digits = q.replace(/\D/g, "");

  // Sales in scope (brand, own-sales-only, agent filter) → their invoices.
  const saleConds: Filter<RowOf<"sales">>[] = [scopeSales(viewer, f.brand)];
  if (f.agent && can(viewer, "sales.view_all")) saleConds.push({ agentId: f.agent });
  const saleIds = await C.sales.distinct("id", { $and: saleConds });

  const conds: Filter<RowOf<"invoices">>[] = [{ saleId: { $in: ids(saleIds) } }];
  if (q) {
    const rx = contains(q);
    const customerOr: Filter<RowOf<"customers">>[] = [{ fullName: rx }, { email: rx }];
    if (digits.length >= 4) customerOr.push({ phoneNormalized: contains(digits) });
    const [customerIds, byPayment] = await Promise.all([
      C.customers.distinct("id", { $or: customerOr }),
      C.transactions.distinct("invoiceId", { $or: [{ paymentReference: rx }, { id: rx }] }),
    ]);
    conds.push({
      $or: [
        { customerId: { $in: customerIds } },
        { invoiceNumber: rx },
        { sourceRecordId: rx },
        { saleId: rx },
        { id: { $in: uniq(byPayment) } },
      ],
    });
  }
  const where = { $and: conds };

  // Newest sale first (sale dates live on the sales documents), then invoice id; paged in the database.
  const [sorted, total] = await Promise.all([
    C.invoices
      .aggregate<RowOf<"invoices">>([
        { $match: where },
        { $lookup: { from: "sales", localField: "saleId", foreignField: "id", pipeline: [{ $project: { _id: 0, saleDate: 1 } }], as: "_sale" } },
        { $set: { _saleDate: { $first: "$_sale.saleDate" } } },
        { $sort: { _saleDate: -1, id: -1 } },
        { $skip: (f.page - 1) * ORDERS_PAGE_SIZE },
        { $limit: ORDERS_PAGE_SIZE },
        { $project: { _id: 0, _sale: 0, _saleDate: 0 } },
      ])
      .toArray(),
    C.invoices.countDocuments(where),
  ]);
  const pageSales = byKey(
    await C.sales.find({ id: { $in: ids(uniq(sorted.map((i) => i.saleId))) } }, { projection: { id: 1, saleDate: 1, createdAt: 1, brandId: 1, agentId: 1 } }).toArray(),
    "id",
  );

  const invoiceIds = sorted.map((i) => i.id);
  const [custs, people, items, payments, cbCounts] = await Promise.all([
    C.customers.find({ id: { $in: ids(uniq(sorted.map((i) => i.customerId))) } }, { projection: { id: 1, fullName: 1, email: 1, phone: 1 } }).toArray(),
    C.users.find({ id: { $in: ids(uniq(sorted.map((i) => pageSales.get(i.saleId)?.agentId))) } }, { projection: { id: 1, name: 1 } }).toArray(),
    C.saleItems.find({ saleId: { $in: ids(sorted.map((i) => i.saleId)) } }, { sort: { id: 1 }, projection: { saleId: 1, description: 1 } }).toArray(),
    C.transactions
      .find({ invoiceId: { $in: ids(invoiceIds) }, type: "payment", status: "succeeded" }, { sort: { occurredAt: -1 }, projection: { id: 1, invoiceId: 1, paymentReference: 1 } })
      .toArray(),
    C.chargebackCases.aggregate<{ _id: string; n: number }>([{ $match: { invoiceId: { $in: ids(invoiceIds) } } }, { $group: { _id: "$invoiceId", n: { $sum: 1 } } }]).toArray(),
  ]);
  const customerMap = byKey(custs, "id");
  const userMap = byKey(people, "id");
  const firstItem = new Map<string, string>();
  for (const it of items) if (!firstItem.has(it.saleId)) firstItem.set(it.saleId, it.description);
  const latestPayment = new Map<string, (typeof payments)[number]>();
  for (const pmt of payments) if (pmt.invoiceId && !latestPayment.has(pmt.invoiceId)) latestPayment.set(pmt.invoiceId, pmt);

  const rows = sorted.filter((i) => pageSales.has(i.saleId)).map((i) => {
    const s = pageSales.get(i.saleId)!;
    const c = customerMap.get(i.customerId);
    const pay = latestPayment.get(i.id);
    return {
      invoiceId: i.id,
      invoiceNumber: i.invoiceNumber,
      agentInvoiceNumber: i.sourceRecordId,
      status: i.status,
      total: i.total,
      amountPaid: i.amountPaid,
      currency: i.currency,
      paymentMethod: i.paymentMethod,
      billingDate: i.billingDate,
      saleId: s.id,
      createdAt: s.createdAt,
      brandId: s.brandId,
      agentId: s.agentId,
      agentName: userMap.get(s.agentId)?.name ?? null,
      description: firstItem.get(s.id) ?? null,
      customerId: i.customerId,
      customerName: c?.fullName ?? "",
      customerEmail: c?.email ?? null,
      customerPhone: c?.phone ?? null,
      billingAddress: i.billingAddress,
      paymentId: pay?.id ?? null,
      paymentReference: pay?.paymentReference ?? null,
      chargebacks: cbCounts.find((x) => x._id === i.id)?.n ?? 0,
    };
  });
  return { rows, total };
}
