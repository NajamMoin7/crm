import "server-only";
import { getDb } from "@/lib/db";
import { contains, ids, uniq } from "@/lib/db/query";
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
 * record scope as its list page, so results never reveal records the
 * viewer could not open.
 */
export async function globalSearch(viewer: Viewer, raw: string): Promise<SearchGroup[]> {
  const q = raw.trim().slice(0, 100);
  if (q.length < 2) return [];
  const C = await getDb();
  const like = contains(q);
  const digits = q.replace(/\D/g, "");
  const brandMap = await getBrandMap();
  const brand = (id: string | null | undefined) => (id ? (brandMap.get(id) ?? null) : null);
  const txView = can(viewer, "transactions.view");
  const groups: Promise<SearchGroup | null>[] = [];
  const customerNames = async (customerIds: string[]) =>
    new Map((await C.customers.find({ id: { $in: ids(uniq(customerIds)) } }, { projection: { id: 1, fullName: 1 } }).toArray()).map((c) => [c.id, c.fullName]));

  if (can(viewer, "customers.view")) {
    groups.push(
      (async () => {
        const rows = await C.customers
          .find(
            {
              $and: [
                await scopeCustomers(viewer),
                {
                  $or: [
                    { id: like },
                    { fullName: like },
                    { email: like },
                    { companyName: like },
                    ...(digits.length >= 4 ? [{ phoneNormalized: contains(digits) }] : []),
                  ],
                },
              ],
            },
            { sort: { lastActivityAt: -1 }, limit: PER_GROUP },
          )
          .toArray();
        return {
          type: "customers",
          label: "Customers",
          items: rows.map((r) => ({
            id: r.id,
            title: r.fullName,
            subtitle: [r.id, r.companyName, r.email].filter(Boolean).join(" · "),
            href: `/customers/${r.id}`,
            brand: brand(r.firstBrandId),
          })),
        };
      })(),
    );
  }

  if (can(viewer, "billing.view")) {
    groups.push(
      (async () => {
        // Payment reference via the ledger: partial match for finance, exact match for everyone else.
        const byRef = await C.transactions.distinct("invoiceId", { paymentReference: txView ? like : q });
        const rows = await C.invoices
          .find(
            { $and: [scopeInvoices(viewer), { $or: [{ invoiceNumber: like }, { id: like }, { id: { $in: ids(uniq(byRef)) } }] }] },
            { sort: { billingDate: -1 }, limit: PER_GROUP },
          )
          .toArray();
        const names = await customerNames(rows.map((r) => r.customerId));
        return {
          type: "invoices",
          label: "Billing records",
          items: rows.map((r) => ({
            id: r.id,
            title: r.invoiceNumber,
            subtitle: `${names.get(r.customerId)} · ${formatMoney(r.total, r.currency)} · ${r.status.replace(/_/g, " ")}`,
            href: `/billing/${r.id}`,
            brand: brand(r.brandId),
          })),
        };
      })(),
    );
  }

  if (can(viewer, "sales.view")) {
    groups.push(
      (async () => {
        const rows = await C.sales.find({ $and: [scopeSales(viewer), { id: like }] }, { sort: { saleDate: -1 }, limit: PER_GROUP }).toArray();
        const names = await customerNames(rows.map((r) => r.customerId));
        return {
          type: "sales",
          label: "Sales",
          items: rows.map((r) => ({
            id: r.id,
            title: r.id,
            subtitle: `${names.get(r.customerId)} · ${formatMoney(r.total, r.currency)} · ${fmtDate(r.saleDate)}`,
            href: `/sales/${r.id}`,
            brand: brand(r.brandId),
          })),
        };
      })(),
    );
  }

  if (txView) {
    groups.push(
      C.transactions
        .find({ $and: [scopeTransactions(viewer), { $or: [{ id: like }, { paymentReference: like }] }] }, { sort: { occurredAt: -1 }, limit: PER_GROUP })
        .toArray()
        .then((rows) => ({
          type: "transactions",
          label: "Transactions",
          items: rows.map((r) => ({
            id: r.id,
            title: `${r.id} · ${r.type.replace(/_/g, " ")}`,
            subtitle: `${formatMoney(r.amount, r.currency)} · ${r.paymentReference ?? "no reference"} · ${fmtDate(r.occurredAt)}`,
            href: r.invoiceId ? `/billing/${r.invoiceId}` : r.chargebackCaseId ? `/recharge/${r.chargebackCaseId}` : "/billing",
            brand: brand(r.brandId),
          })),
        })),
    );
  }

  if (can(viewer, "chargebacks.view")) {
    groups.push(
      (async () => {
        const rows = await C.chargebackCases
          .find({ $and: [scopeCases(viewer), { $or: [{ id: like }, { externalProcessorReference: like }] }] }, { sort: { requestDate: -1 }, limit: PER_GROUP })
          .toArray();
        const names = await customerNames(rows.map((r) => r.customerId));
        return {
          type: "chargebacks",
          label: "Recharge / Chargeback cases",
          items: rows.map((r) => {
            const ext = r.externalProcessorReference;
            return {
              id: r.id,
              title: `${r.id}${r.caseType === "intercompany_recharge" ? " · intercompany" : ""}`,
              subtitle: [names.get(r.customerId), formatMoney(r.amount, r.currency), r.status.replace(/_/g, " "), ext ? (txView ? ext : maskReference(ext)) : null]
                .filter(Boolean)
                .join(" · "),
              href: `/recharge/${r.id}`,
              brand: brand(r.brandId),
            };
          }),
        };
      })(),
    );
  }

  if (can(viewer, "agents.view")) {
    const viewerBrands = brandFilter(viewer, null);
    groups.push(
      (async () => {
        const visible = (await getAgents()).filter((a) => a.brandIds.some((b) => viewerBrands.includes(b)));
        const lower = q.toLowerCase();
        const rows = visible
          .filter((a) => a.name.toLowerCase().includes(lower) || a.email.toLowerCase().includes(lower) || a.agentCode.toLowerCase().includes(lower))
          .slice(0, PER_GROUP);
        return {
          type: "agents",
          label: "Sales agents",
          items: rows.map((r) => ({
            id: r.id,
            title: r.name,
            subtitle: `${r.agentCode} · ${r.team} · ${can(viewer, "users.manage") || can(viewer, "agents.manage") ? r.email : maskEmail(r.email)}${r.status !== "active" ? " · suspended" : ""}`,
            href: `/admin/agents/${r.id}`,
          })),
        };
      })(),
    );
  }

  const results = await Promise.all(groups);
  return results.filter((g): g is SearchGroup => !!g && g.items.length > 0);
}
