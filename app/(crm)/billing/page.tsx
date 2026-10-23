import type { Metadata } from "next";
import Link from "next/link";
import { CircleDollarSign, Clock, FileText, Plus, Receipt, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/crm/page-header";
import { FilterBar } from "@/components/crm/filter-bar";
import { SectionCard } from "@/components/crm/section-card";
import { Pagination } from "@/components/crm/pagination";
import { EmptyState } from "@/components/crm/empty-state";
import { BrandBadge } from "@/components/crm/brand-badge";
import { VocabBadge } from "@/components/crm/status-badge";
import { ExportButton } from "@/components/crm/export-button";
import { AccessDenied } from "@/components/crm/access-denied";
import { KpiCard } from "@/components/crm/kpi-card";
import { can, requireViewer } from "@/lib/auth/viewer";
import { resolveBrand } from "@/lib/auth/scope";
import { invoiceKpis, listInvoices } from "@/lib/data/billing";
import { brandOptions, getAgentOptions, getBrandMap, getViewerBrands } from "@/lib/data/reference";
import { parseFilters, toQueryString } from "@/lib/filters";
import { INVOICE_STATUS } from "@/lib/domain/vocab";
import { formatCents, formatMoney, toCents } from "@/lib/money";
import { fmtDate, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Billing Records" };

export default async function BillingPage(props: PageProps<"/billing">) {
  const viewer = await requireViewer();
  if (!can(viewer, "billing.view")) return <AccessDenied />;
  const sp = await props.searchParams;
  const now = new Date();
  const f = parseFilters(sp, now);
  f.brand = await resolveBrand(viewer, f.brand);

  const [{ rows, total }, kpis, brandMap, brands, agents] = await Promise.all([
    listInvoices(viewer, f),
    invoiceKpis(viewer, f),
    getBrandMap(),
    getViewerBrands(viewer),
    getAgentOptions(viewer),
  ]);
  const viewAll = can(viewer, "billing.view_all");
  const statusHref = (status: string) => `/billing${toQueryString(sp, { status, page: null })}`;

  return (
    <>
      <PageHeader eyebrow="Operations"
        title="Billing Records"
        description={
          viewAll
            ? "Every order's invoice across your brands, with the agent who took it."
            : "Invoices for the orders you took."
        }
        actions={
          <>
            {can(viewer, "reports.export") && <ExportButton dataset="invoices" searchParams={sp} />}
            {can(viewer, "billing.create") && (
              <Button asChild size="sm">
                <Link href="/billing/new">
                  <Plus /> New order
                </Link>
              </Button>
            )}
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiCard
          label="Billed"
          icon={Receipt}
          value={formatCents(kpis.billed, "USD", { compact: kpis.billed >= 10_000_000 })}
          sub={`${fmtNumber(kpis.n)} invoices match`}
          definition="Sum of invoice totals for issued invoices (excludes Draft and Cancelled), using the filters below."
        />
        <KpiCard
          label="Collected"
          icon={Wallet}
          value={formatCents(kpis.collected, "USD", { compact: kpis.collected >= 10_000_000 })}
          sub="Amount paid, net of refunds"
          definition="Sum of amount paid on matching invoices — succeeded payments minus refunds. Chargebacks and adjustments are reported separately."
        />
        <KpiCard
          label="Outstanding"
          icon={CircleDollarSign}
          tone={kpis.overdueCount ? "warning" : "default"}
          value={formatCents(kpis.outstanding, "USD", { compact: kpis.outstanding >= 10_000_000 })}
          sub={`${fmtNumber(kpis.overdueCount)} overdue`}
          href={statusHref("overdue")}
          definition="Total − amount paid − approved adjustments, for Pending, Partially Paid and Overdue invoices."
        />
        <KpiCard
          label="Pending / Draft"
          icon={Clock}
          value={`${fmtNumber(kpis.pendingCount)} / ${fmtNumber(kpis.draftCount)}`}
          sub="Awaiting payment / not yet issued"
          href={statusHref("pending")}
          definition="Number of invoices with status Pending (issued, unpaid) and Draft (not yet issued)."
        />
      </div>

      <SectionCard
        actions={
          <FilterBar
            fields={[
              { kind: "search", placeholder: can(viewer, "transactions.view") ? "Invoice #, customer, payment ref" : "Invoice # or customer" },
              { kind: "select", param: "brand", label: "Brand", options: brandOptions(brands), allLabel: "All brands" },
              { kind: "select", param: "status", label: "Status", options: Object.entries(INVOICE_STATUS).map(([value, v]) => ({ value, label: v.label })), allLabel: "All statuses" },
              ...(viewAll ? [{ kind: "select" as const, param: "agent", label: "Agent", options: agents, allLabel: "All agents" }] : []),
              { kind: "range" },
            ]}
          />
        }
      >
        {rows.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No billing records match these filters"
            description={viewAll ? "Try a different search, status or date range." : "Billing records you create appear here. Try clearing the filters."}
            action={
              can(viewer, "billing.create") ? (
                <Button asChild size="sm">
                  <Link href="/billing/new">
                    <Plus /> New order
                  </Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Invoice</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="hidden sm:table-cell">Brand</TableHead>
                <TableHead className="hidden md:table-cell">Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="hidden text-right md:table-cell">Balance</TableHead>
                <TableHead className="hidden pr-4 md:table-cell">Billed / due</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const balance = toCents(r.balance);
                const open = ["pending", "partially_paid", "overdue"].includes(r.status);
                const pastDue = open && r.dueDate < now;
                return (
                  <TableRow key={r.id}>
                    <TableCell className="pl-4">
                      <Link href={`/billing/${r.id}`} className="font-mono text-[13px] font-medium hover:underline focus-visible:underline focus-visible:outline-none">
                        {r.invoiceNumber}
                      </Link>
                      <div className="text-xs text-muted-foreground">{r.id}</div>
                    </TableCell>
                    <TableCell className="max-w-48">
                      <div className="truncate text-sm">{r.customerName}</div>
                      <div className="truncate text-xs text-muted-foreground">{r.companyName ?? r.customerId}</div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <BrandBadge brand={brandMap.get(r.brandId)} />
                    </TableCell>
                    <TableCell className="hidden text-sm md:table-cell">{r.agentName ?? "—"}</TableCell>
                    <TableCell>
                      <VocabBadge map={INVOICE_STATUS} value={r.status} />
                    </TableCell>
                    <TableCell className="text-right tabular">{formatMoney(r.total, r.currency)}</TableCell>
                    <TableCell className={cn("hidden text-right tabular md:table-cell", open && balance > 0 ? "" : "text-muted-foreground")}>
                      {open ? formatCents(balance, r.currency) : "—"}
                      {toCents(r.adjusted) > 0 && <div className="text-[11px] text-muted-foreground">adj. −{formatMoney(r.adjusted, r.currency)}</div>}
                    </TableCell>
                    <TableCell className="hidden pr-4 text-xs md:table-cell">
                      <div>{fmtDate(r.billingDate)}</div>
                      <div className={cn(pastDue ? "font-medium text-red-600 dark:text-red-400" : "text-muted-foreground")}>Due {fmtDate(r.dueDate)}</div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <Pagination basePath="/billing" searchParams={sp} page={f.page} total={total} />
      </SectionCard>
    </>
  );
}
