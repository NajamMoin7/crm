import type { Metadata } from "next";
import Link from "next/link";
import { format, subMonths } from "date-fns";
import { ChevronDown, Plus, RotateCcw, ShoppingBag, TrendingDown, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/crm/page-header";
import { FilterBar } from "@/components/crm/filter-bar";
import { Pagination } from "@/components/crm/pagination";
import { EmptyState } from "@/components/crm/empty-state";
import { BrandBadge } from "@/components/crm/brand-badge";
import { VocabBadge } from "@/components/crm/status-badge";
import { ExportButton } from "@/components/crm/export-button";
import { AccessDenied } from "@/components/crm/access-denied";
import { can, requireViewer } from "@/lib/auth/viewer";
import { resolveBrand } from "@/lib/auth/scope";
import { getAgentTotals, listOrders, ORDERS_PAGE_SIZE, type AgentTotals, type PeriodTotal } from "@/lib/data/orders";
import { brandOptions, getAgentOptions, getBrandMap, getViewerBrands } from "@/lib/data/reference";
import { INVOICE_STATUS, PAYMENT_METHOD } from "@/lib/domain/vocab";
import { formatCents, formatMoney } from "@/lib/money";
import { maskReference } from "@/lib/mask";
import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Sales" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim().slice(0, 100) || null;

export default async function SalesPage(props: PageProps<"/sales">) {
  const viewer = await requireViewer();
  if (!can(viewer, "sales.view")) return <AccessDenied />;
  const sp = await props.searchParams;
  const now = new Date();
  const isAdmin = can(viewer, "sales.view_all");
  const brand = await resolveBrand(viewer, one(sp.brand));
  const f = { q: one(sp.q) ?? "", brand, agent: one(sp.agent), page: Math.max(1, Number.parseInt(one(sp.page) ?? "1", 10) || 1) };

  const [totals, { rows, total }, brandMap, brands, agents] = await Promise.all([
    getAgentTotals(viewer, brand),
    listOrders(viewer, f),
    getBrandMap(),
    getViewerBrands(viewer),
    isAdmin ? getAgentOptions(viewer) : Promise.resolve([]),
  ]);
  const showRefs = can(viewer, "transactions.view");
  const canChargeback = can(viewer, "chargebacks.create");
  const prevLabel = format(subMonths(now, 1), "MMM").toUpperCase();
  const monthLabel = format(now, "MMM").toUpperCase();
  const yearLabel = format(now, "yy");

  return (
    <>
      <PageHeader
        eyebrow="Orders"
        title={isAdmin ? "Sales" : "My sales"}
        description={isAdmin ? "Every order, newest first, with the agent who took it." : "Your orders, newest first."}
        actions={
          <>
            {can(viewer, "reports.export") && <ExportButton dataset="sales" searchParams={sp} />}
            {can(viewer, "billing.create") && (
              <Button asChild className="rounded-full px-5 tracking-[0.12em] uppercase">
                <Link href="/billing/new">
                  <Plus /> New order
                </Link>
              </Button>
            )}
          </>
        }
      />

      <section aria-labelledby="agent-totals" className="mb-8">
        <p id="agent-totals" className="eyebrow mb-3 text-primary">
          {isAdmin ? "Agent totals" : "My totals"}
        </p>
        <div className="overflow-x-auto rounded-xl border bg-card shadow-xs">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
                <th className="px-5 py-4 text-left font-medium">Agent</th>
                <th className="px-5 py-4 text-right font-medium">Today</th>
                <th className="px-5 py-4 text-right font-medium">Previous month ({prevLabel})</th>
                <th className="px-5 py-4 text-right font-medium text-primary">This month ({monthLabel})</th>
                <th className="px-5 py-4 text-right font-medium">Year ({yearLabel})</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((t) => (
                <TotalsRow key={t.agentId} t={t} />
              ))}
              {isAdmin && totals.length > 1 && <TotalsRow t={sumTotals(totals)} total />}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Non-cancelled sales by sale date.</p>
      </section>

      <section aria-labelledby="all-orders">
        <p id="all-orders" className="eyebrow mb-3 text-primary">
          {isAdmin ? "All orders" : "My orders"}
        </p>
        <FilterBar
          className="mb-3"
          fields={[
            { kind: "search", placeholder: "Search by name, email, phone, invoice, reference…" },
            ...(brands.length > 1 ? [{ kind: "select" as const, param: "brand", label: "Brand", options: brandOptions(brands), allLabel: "All brands" }] : []),
            ...(isAdmin ? [{ kind: "select" as const, param: "agent", label: "Agent", options: agents, allLabel: "All agents" }] : []),
          ]}
        />
        {rows.length === 0 ? (
          <div className="rounded-xl border bg-card">
            <EmptyState icon={ShoppingBag} title="No orders found" description="Try another search, or record a new order." />
          </div>
        ) : (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-2" aria-label="Orders">
            {rows.map((o) => (
              <li key={o.invoiceId}>
                <details className="group rounded-xl border bg-card shadow-xs open:border-primary/40">
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{o.customerName}</span>
                        <span className="font-mono text-xs text-muted-foreground">{o.invoiceNumber}</span>
                        <VocabBadge map={INVOICE_STATUS} value={o.status} />
                        {isAdmin && (
                          <span className="inline-flex h-5 items-center rounded-full border border-primary/40 px-2 text-[10px] font-semibold tracking-wider text-primary uppercase">
                            {o.agentName}
                          </span>
                        )}
                        {o.chargebacks > 0 && (
                          <span className="inline-flex h-5 items-center gap-1 rounded-full border border-red-500/40 px-2 text-[10px] font-semibold tracking-wider text-red-400 uppercase">
                            <RotateCcw className="size-3" aria-hidden /> {o.chargebacks} chargeback{o.chargebacks > 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {fmtDateTime(o.createdAt)}
                        {o.agentInvoiceNumber ? ` · Inv. ${o.agentInvoiceNumber}` : ""}
                        {o.description ? ` · ${o.description}` : ""} · {PAYMENT_METHOD[o.paymentMethod] ?? o.paymentMethod}
                      </p>
                    </div>
                    <BrandBadge brand={brandMap.get(o.brandId)} className="hidden sm:inline-flex" />
                    <span className="text-right font-semibold text-primary tabular">{formatMoney(o.total, o.currency)}</span>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
                  </summary>
                  <div className="grid gap-4 border-t px-4 py-4 text-sm sm:grid-cols-[1fr_auto]">
                    <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3">
                      <Item k="Email" v={o.customerEmail} />
                      <Item k="Phone" v={o.customerPhone} />
                      <Item k="Brand" v={brandMap.get(o.brandId)?.name} />
                      <Item k="Agent" v={o.agentName} />
                      <Item k="Paid" v={`${formatMoney(o.amountPaid, o.currency)} of ${formatMoney(o.total, o.currency)}`} />
                      <Item k="Payment reference" v={showRefs ? o.paymentReference : maskReference(o.paymentReference)} mono />
                      {o.billingAddress && <Item k="Billing address" v={o.billingAddress} className="sm:col-span-3" />}
                    </dl>
                    <div className="flex flex-wrap items-start gap-2 sm:flex-col sm:items-stretch">
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/billing/${o.invoiceId}`}>View invoice</Link>
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/customers/${o.customerId}`}>Customer</Link>
                      </Button>
                      {canChargeback &&
                        (o.paymentId ? (
                          <Button asChild variant="destructive" size="sm">
                            <Link href={`/recharge/new?txn=${o.paymentId}`}>
                              <RotateCcw /> Chargeback
                            </Link>
                          </Button>
                        ) : (
                          <Button variant="destructive" size="sm" disabled title="Only paid orders can be charged back">
                            <RotateCcw /> Chargeback
                          </Button>
                        ))}
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 overflow-hidden rounded-xl border bg-card">
          <Pagination basePath="/sales" searchParams={sp} page={f.page} total={total} pageSize={ORDERS_PAGE_SIZE} />
        </div>
      </section>
    </>
  );
}

function Item({ k, v, mono, className }: { k: string; v?: string | null; mono?: boolean; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-xs text-muted-foreground">{k}</dt>
      <dd className={cn("truncate", mono && "font-mono text-xs")}>{v || "—"}</dd>
    </div>
  );
}

function sumTotals(list: AgentTotals[]): AgentTotals {
  const add = (k: keyof Omit<AgentTotals, "agentId" | "name">): PeriodTotal => ({
    cents: list.reduce((a, t) => a + t[k].cents, 0),
    count: list.reduce((a, t) => a + t[k].count, 0),
  });
  return { agentId: "total", name: "Total", today: add("today"), prevMonth: add("prevMonth"), thisMonth: add("thisMonth"), year: add("year") };
}

function Cell({ p, highlight }: { p: PeriodTotal; highlight?: boolean }) {
  return (
    <>
      <div className={cn("font-semibold tabular", p.cents > 0 ? (highlight ? "text-primary" : "text-foreground") : "text-muted-foreground")}>{formatCents(p.cents)}</div>
      <div className="text-xs text-muted-foreground tabular">
        {p.count} order{p.count === 1 ? "" : "s"}
      </div>
    </>
  );
}

function TotalsRow({ t, total }: { t: AgentTotals; total?: boolean }) {
  const delta = t.thisMonth.cents - t.prevMonth.cents;
  const pct = t.prevMonth.cents ? Math.round((delta / t.prevMonth.cents) * 100) : null;
  return (
    <tr className={cn("border-t", total && "bg-muted/40")}>
      <td className={cn("px-5 py-4", total ? "text-[11px] font-semibold tracking-[0.16em] uppercase" : "font-medium")}>{t.name}</td>
      <td className="px-5 py-4 text-right">
        <Cell p={t.today} />
      </td>
      <td className="px-5 py-4 text-right">
        <Cell p={t.prevMonth} />
      </td>
      <td className="px-5 py-4 text-right">
        <Cell p={t.thisMonth} highlight />
        {delta !== 0 ? (
          <div className={cn("mt-0.5 inline-flex items-center gap-1 text-xs tabular", delta > 0 ? "text-emerald-500" : "text-red-400")}>
            {delta > 0 ? <TrendingUp className="size-3" aria-hidden /> : <TrendingDown className="size-3" aria-hidden />}
            {formatCents(Math.abs(delta))}
            {pct !== null && ` (${delta > 0 ? "+" : "−"}${Math.abs(pct)}%)`}
          </div>
        ) : (
          <div className="mt-0.5 text-xs text-muted-foreground">Level with last month</div>
        )}
      </td>
      <td className="px-5 py-4 text-right">
        <Cell p={t.year} highlight />
      </td>
    </tr>
  );
}
