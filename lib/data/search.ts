import "server-only";
import { and, asc, desc, eq, exists, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { chargebackCases, customers, invoices, sales, salesAgents, transactions, users } from "@/lib/db/schema";
import { brandFilter, scopeCases, scopeCustomers, scopeInvoices, scopeSales, scopeTransactions } from "@/lib/auth/scope";
import { can, type Viewer } from "@/lib/auth/viewer";
import { getAgents, getBrandMap } from "@/lib/data/reference";
import type { BrandLite } from "@/components/crm/brand-badge";
import { maskEmail, maskReference } from "@/lib/mask";
import { formatMoney } from "@/lib/money";
import { fmtDate } from "@/lib/format";

export type SearchItem = { id: string; title: string; subtitle: string; href: string; brand?: BrandLite | null };
export type SearchGroup = { type: string; label: string; items: SearchItem[] };

const PER_GROUP = 6;

/**
 * Global search. Every group is permission-gated and composed with the same
 * row-level scope as its list page, so results never reveal records the
 * viewer could not open.
 */
export async function globalSearch(viewer: Viewer, raw: string): Promise<SearchGroup[]> {
  const q = raw.trim().slice(0, 100);
  if (q.length < 2) return [];
  const db = await getDb();
  const like = `%${q.replace(/[%_\\]/g, "")}%`;
  const digits = q.replace(/\D/g, "");
  const brandMap = await getBrandMap();
  const brand = (id: string | null | undefined) => (id ? (brandMap.get(id) ?? null) : null);
  const txView = can(viewer, "transactions.view");
  const groups: Promise<SearchGroup | null>[] = [];

  if (can(viewer, "customers.view")) {
    groups.push(
      db
        .select({
          id: customers.id, fullName: customers.fullName, email: customers.email, companyName: customers.companyName, firstBrandId: customers.firstBrandId,
        })
        .from(customers)
        .where(
          and(
            scopeCustomers(viewer),
            or(
              ilike(customers.id, like),
              ilike(customers.fullName, like),
              ilike(customers.email, like),
              ilike(customers.companyName, like),
              digits.length >= 4 ? ilike(customers.phoneNormalized, `%${digits}%`) : undefined,
            ),
          ),
        )
        .orderBy(desc(customers.lastActivityAt))
        .limit(PER_GROUP)
        .then((rows) => ({
          type: "customers",
          label: "Customers",
          items: rows.map((r) => ({
            id: r.id,
            title: r.fullName,
            subtitle: [r.id, r.companyName, r.email].filter(Boolean).join(" · "),
            href: `/customers/${r.id}`,
            brand: brand(r.firstBrandId),
          })),
        })),
    );
  }

  if (can(viewer, "billing.view")) {
    groups.push(
      db
        .select({
          id: invoices.id, invoiceNumber: invoices.invoiceNumber, brandId: invoices.brandId, total: invoices.total, currency: invoices.currency,
          status: invoices.status, customerName: customers.fullName,
        })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .where(
          and(
            scopeInvoices(viewer),
            or(
              ilike(invoices.invoiceNumber, like),
              ilike(invoices.id, like),
              // Payment reference via the ledger: partial match for finance, exact match for everyone else.
              exists(
                sql`(select 1 from ${transactions} where ${transactions.invoiceId} = ${invoices.id} and ${
                  txView ? ilike(transactions.paymentReference, like) : eq(transactions.paymentReference, q)
                })`,
              ),
            ),
          ),
        )
        .orderBy(desc(invoices.billingDate))
        .limit(PER_GROUP)
        .then((rows) => ({
          type: "invoices",
          label: "Billing records",
          items: rows.map((r) => ({
            id: r.id,
            title: r.invoiceNumber,
            subtitle: `${r.customerName} · ${formatMoney(r.total, r.currency)} · ${r.status.replace(/_/g, " ")}`,
            href: `/billing/${r.id}`,
            brand: brand(r.brandId),
          })),
        })),
    );
  }

  if (can(viewer, "sales.view")) {
    groups.push(
      db
        .select({ id: sales.id, brandId: sales.brandId, total: sales.total, currency: sales.currency, saleDate: sales.saleDate, customerName: customers.fullName })
        .from(sales)
        .innerJoin(customers, eq(customers.id, sales.customerId))
        .where(and(scopeSales(viewer), ilike(sales.id, like)))
        .orderBy(desc(sales.saleDate))
        .limit(PER_GROUP)
        .then((rows) => ({
          type: "sales",
          label: "Sales",
          items: rows.map((r) => ({
            id: r.id,
            title: r.id,
            subtitle: `${r.customerName} · ${formatMoney(r.total, r.currency)} · ${fmtDate(r.saleDate)}`,
            href: `/sales/${r.id}`,
            brand: brand(r.brandId),
          })),
        })),
    );
  }

  if (txView) {
    groups.push(
      db
        .select({
          id: transactions.id, type: transactions.type, amount: transactions.amount, currency: transactions.currency, brandId: transactions.brandId,
          ref: transactions.paymentReference, occurredAt: transactions.occurredAt, invoiceId: transactions.invoiceId, caseId: transactions.chargebackCaseId,
        })
        .from(transactions)
        .where(and(scopeTransactions(viewer), or(ilike(transactions.id, like), ilike(transactions.paymentReference, like))))
        .orderBy(desc(transactions.occurredAt))
        .limit(PER_GROUP)
        .then((rows) => ({
          type: "transactions",
          label: "Transactions",
          items: rows.map((r) => ({
            id: r.id,
            title: `${r.id} · ${r.type.replace(/_/g, " ")}`,
            subtitle: `${formatMoney(r.amount, r.currency)} · ${r.ref ?? "no reference"} · ${fmtDate(r.occurredAt)}`,
            href: r.invoiceId ? `/billing/${r.invoiceId}` : r.caseId ? `/recharge/${r.caseId}` : "/billing",
            brand: brand(r.brandId),
          })),
        })),
    );
  }

  if (can(viewer, "chargebacks.view")) {
    groups.push(
      db
        .select({
          id: chargebackCases.id, caseType: chargebackCases.caseType, status: chargebackCases.status, amount: chargebackCases.amount,
          currency: chargebackCases.currency, brandId: chargebackCases.brandId, ext: chargebackCases.externalProcessorReference, customerName: customers.fullName,
        })
        .from(chargebackCases)
        .innerJoin(customers, eq(customers.id, chargebackCases.customerId))
        .where(and(scopeCases(viewer), or(ilike(chargebackCases.id, like), ilike(chargebackCases.externalProcessorReference, like))))
        .orderBy(desc(chargebackCases.requestDate))
        .limit(PER_GROUP)
        .then((rows) => ({
          type: "chargebacks",
          label: "Recharge / Chargeback cases",
          items: rows.map((r) => ({
            id: r.id,
            title: `${r.id}${r.caseType === "intercompany_recharge" ? " · intercompany" : ""}`,
            subtitle: [r.customerName, formatMoney(r.amount, r.currency), r.status.replace(/_/g, " "), r.ext ? (txView ? r.ext : maskReference(r.ext)) : null]
              .filter(Boolean)
              .join(" · "),
            href: `/recharge/${r.id}`,
            brand: brand(r.brandId),
          })),
        })),
    );
  }

  if (can(viewer, "agents.view")) {
    const viewerBrands = brandFilter(viewer, null);
    groups.push(
      (async () => {
        const visible = new Set((await getAgents()).filter((a) => a.brandIds.some((b) => viewerBrands.includes(b))).map((a) => a.id));
        const rows = await db
          .select({ id: users.id, name: users.name, email: users.email, code: salesAgents.agentCode, team: salesAgents.team, status: users.status })
          .from(salesAgents)
          .innerJoin(users, eq(users.id, salesAgents.userId))
          .where(
            and(
              inArray(users.id, visible.size ? [...visible] : ["__none__"]),
              or(ilike(users.name, like), ilike(users.email, like), ilike(salesAgents.agentCode, like)),
            ),
          )
          .orderBy(asc(users.name))
          .limit(PER_GROUP);
        return {
          type: "agents",
          label: "Sales agents",
          items: rows.map((r) => ({
            id: r.id,
            title: r.name,
            subtitle: `${r.code} · ${r.team} · ${can(viewer, "users.manage") || can(viewer, "agents.manage") ? r.email : maskEmail(r.email)}${r.status !== "active" ? " · suspended" : ""}`,
            href: `/admin/agents/${r.id}`,
          })),
        };
      })(),
    );
  }

  const results = await Promise.all(groups);
  return results.filter((g): g is SearchGroup => !!g && g.items.length > 0);
}
