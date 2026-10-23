import type { Metadata } from "next";
import Link from "next/link";
import { FileClock, Receipt, RotateCcw, ShoppingBag, Target, Users, UsersRound } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/crm/page-header";
import { KpiCard } from "@/components/crm/kpi-card";
import { SectionCard } from "@/components/crm/section-card";
import { EmptyState } from "@/components/crm/empty-state";
import { BrandBadge } from "@/components/crm/brand-badge";
import { VocabBadge } from "@/components/crm/status-badge";
import { AccessDenied } from "@/components/crm/access-denied";
import { FilterBar, type FilterField } from "@/components/crm/filter-bar";
import { ChartCard } from "@/components/charts/chart-card";
import { HBarChart, TimeSeriesChart } from "@/components/charts/chart-kit";
import { can, requireViewer } from "@/lib/auth/viewer";
import { filterQuery, getKpis, resolveMetricFilters, revenueByBrand, salesTrend } from "@/lib/data/metrics";
import { listSales } from "@/lib/data/sales";
import { listCases } from "@/lib/data/chargebacks";
import { brandOptions, getAgentOptions, getBrandMap, getViewerBrands } from "@/lib/data/reference";
import { CASE_STATUS } from "@/lib/domain/vocab";
import { formatCents, formatMoney } from "@/lib/money";
import { fmtDate, fmtNumber } from "@/lib/format";
import { RANGE_PRESETS } from "@/lib/filters";

export const metadata: Metadata = { title: "Dashboard" };

const money = (c: number) => formatCents(c, "USD");

export default async function DashboardPage(props: PageProps<"/dashboard">) {
  const viewer = await requireViewer();
  if (!can(viewer, "sales.view")) return <AccessDenied />;
  const sp = await props.searchParams;
  const now = new Date();
  // Small demo dataset: default to all records so every seeded row is visible.
  const f = await resolveMetricFilters(viewer, sp, now, "all");
  const isAdmin = can(viewer, "sales.view_all");

  const [kpis, trend, byBrand, recentSales, recentCases, brandMap, brands, agents] = await Promise.all([
    getKpis(viewer, f),
    salesTrend(viewer, f, now),
    revenueByBrand(viewer, f),
    listSales(viewer, { ...f, page: 1, status: null }, { mine: !isAdmin }),
    listCases(viewer, { ...f, page: 1, status: null, agent: isAdmin ? f.agent : null }, isAdmin ? "all" : "mine", { limit: 5, paginate: false }),
    getBrandMap(),
    getViewerBrands(viewer),
    isAdmin ? getAgentOptions(viewer) : Promise.resolve(null),
  ]);

  const brandColor = (id: string) => {
    const b = brandMap.get(id);
    return b ? `var(--brand-${b.code}, ${b.color})` : "var(--chart-1)";
  };
  const brandName = (id: string) => brandMap.get(id)?.name ?? id;
  const series = trend.brandIds.map((id) => ({ key: id, label: brandName(id), color: brandColor(id) }));
  const rangeLabel = RANGE_PRESETS.find((r) => r.value === f.range)?.label ?? "Selected range";
  const q = (extra: Record<string, string | null> = {}) => filterQuery(f, extra);
  const unit = trend.unit === "day" ? "daily" : trend.unit === "week" ? "weekly" : "monthly";
  const trendEmpty = trend.rows.every((r) => trend.brandIds.every((b) => !Number(r[b])));

  const filterFields: FilterField[] = [
    { kind: "range", defaultValue: "all" },
    { kind: "select", param: "brand", label: "Brand", options: brandOptions(brands), allLabel: brands.length > 1 ? "All brands" : "My brand" },
  ];
  if (agents) filterFields.push({ kind: "select", param: "agent", label: "Agent", options: agents, allLabel: "All agents" });

  const kpiCards = [
    {
      label: "Total Customers",
      value: fmtNumber(kpis.totalCustomers),
      sub: isAdmin ? "All brands in view" : "Your customers",
      icon: Users,
      href: `/customers${q({ range: null })}`,
      definition: "Distinct, non-merged customers linked to the selected brand(s). Not limited by the date range.",
    },
    {
      label: "Total Sales",
      value: fmtNumber(kpis.salesCount),
      sub: `${money(kpis.grossCents)} gross · ${rangeLabel}`,
      icon: ShoppingBag,
      href: `/sales${q()}`,
      definition: "Sales dated in the range, excluding cancelled sales. Gross = sale totals after discount, incl. tax.",
    },
    {
      label: "Total Billed Amount",
      value: money(kpis.billedCents),
      sub: `${fmtNumber(kpis.invoiceCount)} issued invoices · ${money(kpis.collectedCents)} collected`,
      icon: Receipt,
      href: `/billing${q()}`,
      definition: "Sum of issued invoice totals billed in the range (draft and cancelled excluded). Collected = succeeded payments.",
    },
    {
      label: "Pending Billing",
      value: fmtNumber(kpis.pendingBilling),
      sub: `${kpis.pendingDraft} draft · ${kpis.pendingPending} pending · ${money(kpis.outstandingCents)} outstanding`,
      icon: FileClock,
      tone: kpis.pendingBilling ? ("warning" as const) : undefined,
      href: `/billing${q({ status: "pending" })}`,
      definition: "Invoices in Draft or Pending status. Outstanding = unpaid balance of pending, partially paid and overdue invoices.",
    },
    {
      label: "Recharge / Chargeback Cases",
      value: fmtNumber(kpis.cbCases),
      sub: `${kpis.cbOpen} open · ${kpis.cbCompleted} completed (${money(kpis.cbCompletedCents)})`,
      icon: RotateCcw,
      href: `/recharge${q({ queue: isAdmin ? "all" : "mine" })}`,
      definition: "Chargeback cases requested in the range (any status). Only completed cases count as chargeback amounts.",
    },
    isAdmin
      ? {
          label: "Active Sales Agents",
          value: `${kpis.activeAgents} / ${kpis.totalAgents}`,
          sub: "With ≥1 sale in range / active agents",
          icon: UsersRound,
          href: "/admin/agents?role=sales_agent",
          definition: "Agents with at least one non-cancelled sale in the range, out of active agents with access to the selected brand(s).",
        }
      : {
          label: "My Collected Payments",
          value: money(kpis.collectedCents),
          sub: `${fmtNumber(kpis.paymentsCount)} payments · ${rangeLabel}`,
          icon: Target,
          href: `/billing${q({ status: "paid" })}`,
          definition: "Succeeded payments on your own billing records in the range.",
        },
  ];

  return (
    <>
      <PageHeader eyebrow="Overview"
        title="Dashboard"
        description={
          isAdmin
            ? "All three brands at a glance. Every figure is calculated from the records and opens them when clicked."
            : `Your performance in ${brands.map((b) => b.name).join(" and ")}. Only your own records are counted.`
        }
      />
      <div className="mb-4">
        <FilterBar fields={filterFields} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-testid="kpis">
        {kpiCards.map((k) => (
          <KpiCard key={k.label} {...k} />
        ))}
      </div>

      <div className="mt-4 grid grid-cols-12 gap-4">
        <ChartCard
          className="col-span-12 lg:col-span-5"
          title="Sales by Brand"
          description={`Gross sales · ${rangeLabel}`}
          info="Sum of non-cancelled sale totals per brand in the selected range."
          empty={byBrand.every((r) => !r.grossCents)}
          table={{
            columns: [{ label: "Brand" }, { label: "Sales", align: "right" }, { label: "Gross", align: "right" }],
            rows: byBrand.map((r) => [brandName(r.brandId), r.salesCount, money(r.grossCents)]),
          }}
        >
          <HBarChart
            data={byBrand.map((r) => ({ label: brandName(r.brandId), value: r.grossCents / 100, color: brandColor(r.brandId), note: `${r.salesCount} sales` }))}
            valueName="Gross sales"
            labelWidth={130}
            ariaLabel="Bar chart of gross sales by brand"
          />
        </ChartCard>
        <ChartCard
          className="col-span-12 lg:col-span-7"
          title="Sales Activity Over Time"
          description={`Gross sales by brand, ${unit} · ${rangeLabel}`}
          info="Buckets adapt to the range: daily up to 35 days, weekly up to 6 months, otherwise monthly."
          empty={trendEmpty}
          table={{
            columns: [{ label: "Period" }, ...series.map((s) => ({ label: s.label, align: "right" as const }))],
            rows: trend.rows.map((r) => [String(r.label), ...series.map((s) => money(Math.round(Number(r[s.key]) * 100)))]),
          }}
        >
          <TimeSeriesChart data={trend.rows} series={series} ariaLabel={`Line chart of gross sales by brand, ${unit}`} />
        </ChartCard>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <SectionCard
          title="Recent Sales"
          description={isAdmin ? "Latest sales across the brands in view" : "Your latest sales"}
          actions={
            <Link href={`/sales${q()}`} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
              View all
            </Link>
          }
        >
          {recentSales.rows.length === 0 ? (
            <EmptyState icon={ShoppingBag} title="No sales in this range" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Sale</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Brand</TableHead>
                  {isAdmin && <TableHead className="hidden md:table-cell">Agent</TableHead>}
                  <TableHead className="pr-4 text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentSales.rows.slice(0, 5).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="pl-4">
                      <Link href={`/sales/${s.id}`} className="font-mono text-sm hover:underline">
                        {s.id}
                      </Link>
                      <div className="text-xs text-muted-foreground">{fmtDate(s.saleDate)}</div>
                    </TableCell>
                    <TableCell className="max-w-40 truncate text-sm">
                      <Link href={`/customers/${s.customerId}`} className="hover:underline">
                        {s.customerName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <BrandBadge brand={brandMap.get(s.brandId)} />
                    </TableCell>
                    {isAdmin && <TableCell className="hidden text-sm md:table-cell">{s.agentName}</TableCell>}
                    <TableCell className="pr-4 text-right tabular">{formatMoney(s.total, s.currency)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>

        <SectionCard
          title="Recent Recharge / Chargeback Requests"
          description={isAdmin ? "Latest requests; pending ones need your review" : "Your latest requests"}
          actions={
            <Link href="/recharge" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
              View all
            </Link>
          }
        >
          {recentCases.rows.length === 0 ? (
            <EmptyState icon={RotateCcw} title="No recharge / chargeback requests" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Case</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Brand</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="pr-4 text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentCases.rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="pl-4">
                      <Link href={`/recharge/${c.id}`} className="font-mono text-sm hover:underline">
                        {c.id}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {fmtDate(c.requestDate)} · {c.requesterName}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-40 truncate text-sm">{c.customerName}</TableCell>
                    <TableCell>
                      <BrandBadge brand={brandMap.get(c.brandId)} />
                    </TableCell>
                    <TableCell>
                      <VocabBadge map={CASE_STATUS} value={c.status} />
                    </TableCell>
                    <TableCell className="pr-4 text-right tabular">{formatMoney(c.amount, c.currency)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </SectionCard>
      </div>
    </>
  );
}
