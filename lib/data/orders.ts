import "server-only";
import { and, desc, eq, ilike, ne, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { customers, invoices, sales, salesAgents, users } from "@/lib/db/schema";
import { scopeSales } from "@/lib/auth/scope";
import { can, type Viewer } from "@/lib/auth/viewer";

export type PeriodTotal = { cents: number; count: number };
export type AgentTotals = { agentId: string; name: string; today: PeriodTotal; prevMonth: PeriodTotal; thisMonth: PeriodTotal; year: PeriodTotal };

const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);

/**
 * Takings per agent for today, last month, this month and this year (non-cancelled
 * sales, by sale date, server time zone). Super Admins see every agent; an agent
 * sees only their own row.
 */
export async function getAgentTotals(viewer: Viewer, brand: string | null): Promise<AgentTotals[]> {
  const db = await getDb();
  const period = (cond: string) => ({
    sum: sql.raw(`coalesce(sum("sales"."total") filter (where ${cond}), 0)::text`),
    n: sql.raw(`(count(*) filter (where ${cond}))::int`),
  });
  const today = period(`"sales"."sale_date" >= date_trunc('day', now())`);
  const prev = period(`"sales"."sale_date" >= date_trunc('month', now()) - interval '1 month' and "sales"."sale_date" < date_trunc('month', now())`);
  const month = period(`"sales"."sale_date" >= date_trunc('month', now())`);
  const year = period(`"sales"."sale_date" >= date_trunc('year', now())`);
  const rows = await db
    .select({
      agentId: sales.agentId,
      tSum: sql<string>`${today.sum}`,
      tN: sql<number>`${today.n}`,
      pSum: sql<string>`${prev.sum}`,
      pN: sql<number>`${prev.n}`,
      mSum: sql<string>`${month.sum}`,
      mN: sql<number>`${month.n}`,
      ySum: sql<string>`${year.sum}`,
      yN: sql<number>`${year.n}`,
    })
    .from(sales)
    .where(and(scopeSales(viewer, brand), ne(sales.status, "cancelled")))
    .groupBy(sales.agentId);

  // Every active agent appears (with zeros) so the table compares the whole team.
  const agentList = can(viewer, "sales.view_all")
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .innerJoin(salesAgents, eq(salesAgents.userId, users.id))
        .where(eq(users.status, "active"))
    : [{ id: viewer.id, name: viewer.name }];
  const ids = new Set([...agentList.map((a) => a.id), ...rows.map((r) => r.agentId)]);
  const names = new Map(agentList.map((a) => [a.id, a.name]));
  if ([...ids].some((id) => !names.has(id))) {
    for (const u of await db.select({ id: users.id, name: users.name }).from(users)) names.set(u.id, u.name);
  }
  return [...ids]
    .map((id) => {
      const r = rows.find((x) => x.agentId === id);
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
  const db = await getDb();
  const like = f.q ? `%${f.q.replace(/[%_]/g, "")}%` : null;
  const digits = f.q.replace(/\D/g, "");
  const where = and(
    scopeSales(viewer, f.brand),
    f.agent && can(viewer, "sales.view_all") ? eq(sales.agentId, f.agent) : undefined,
    like
      ? or(
          ilike(customers.fullName, like),
          ilike(customers.email, like),
          ilike(invoices.invoiceNumber, like),
          ilike(invoices.sourceRecordId, like),
          ilike(sales.id, like),
          digits.length >= 4 ? ilike(customers.phoneNormalized, `%${digits}%`) : undefined,
          sql`exists (select 1 from transactions t where t.invoice_id = "invoices"."id" and (t.payment_reference ilike ${like} or t.id ilike ${like}))`,
        )
      : undefined,
  );
  const base = db
    .select({
      invoiceId: invoices.id,
      invoiceNumber: invoices.invoiceNumber,
      agentInvoiceNumber: invoices.sourceRecordId,
      status: invoices.status,
      total: invoices.total,
      amountPaid: invoices.amountPaid,
      currency: invoices.currency,
      paymentMethod: invoices.paymentMethod,
      billingDate: invoices.billingDate,
      saleId: sales.id,
      createdAt: sales.createdAt,
      brandId: sales.brandId,
      agentId: sales.agentId,
      agentName: users.name,
      description: sql<string | null>`(select si.description from sale_items si where si.sale_id = "sales"."id" order by si.id limit 1)`,
      customerId: customers.id,
      customerName: customers.fullName,
      customerEmail: customers.email,
      customerPhone: customers.phone,
      billingAddress: invoices.billingAddress,
      paymentId: sql<string | null>`(select t.id from transactions t where t.invoice_id = "invoices"."id" and t.type = 'payment' and t.status = 'succeeded' order by t.occurred_at desc limit 1)`,
      paymentReference: sql<string | null>`(select t.payment_reference from transactions t where t.invoice_id = "invoices"."id" and t.type = 'payment' and t.status = 'succeeded' order by t.occurred_at desc limit 1)`,
      chargebacks: sql<number>`(select count(*)::int from chargeback_cases c where c.invoice_id = "invoices"."id")`,
    })
    .from(invoices)
    .innerJoin(sales, eq(sales.id, invoices.saleId))
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .leftJoin(users, eq(users.id, sales.agentId))
    .where(where);
  const [rows, [{ total }]] = await Promise.all([
    base.orderBy(desc(sales.saleDate), desc(invoices.id)).limit(ORDERS_PAGE_SIZE).offset((f.page - 1) * ORDERS_PAGE_SIZE),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(invoices)
      .innerJoin(sales, eq(sales.id, invoices.saleId))
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(where),
  ]);
  return { rows, total };
}
