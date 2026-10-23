import type { Metadata } from "next";
import Link from "next/link";
import { CircleDollarSign, ClipboardCheck, Hourglass, Inbox, Plus, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/crm/page-header";
import { SectionCard } from "@/components/crm/section-card";
import { KpiCard } from "@/components/crm/kpi-card";
import { FilterBar } from "@/components/crm/filter-bar";
import { Pagination } from "@/components/crm/pagination";
import { AccessDenied } from "@/components/crm/access-denied";
import { CaseTable } from "@/components/recharge/case-table";
import { can, requireViewer } from "@/lib/auth/viewer";
import { resolveBrand } from "@/lib/auth/scope";
import { listCases, queueCounts, type CaseQueue } from "@/lib/data/chargebacks";
import { brandOptions, getBrandMap, getViewerBrands } from "@/lib/data/reference";
import { parseFilters, toQueryString } from "@/lib/filters";
import { CASE_TYPE } from "@/lib/domain/vocab";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Recharge / Chargeback Management" };

export default async function RechargePage(props: PageProps<"/recharge">) {
  const viewer = await requireViewer();
  if (!can(viewer, "chargebacks.view")) return <AccessDenied />;
  const sp = await props.searchParams;
  const f = parseFilters(sp, new Date());
  f.brand = await resolveBrand(viewer, f.brand);

  const queues: { key: CaseQueue; label: string; show: boolean }[] = [
    { key: "review", label: "Needs my review", show: can(viewer, "chargebacks.review") },
    { key: "approval", label: "Needs my approval", show: can(viewer, "chargebacks.approve") },
    { key: "processing", label: "Approved / processing", show: can(viewer, "chargebacks.process") },
    { key: "mine", label: "My requests", show: can(viewer, "chargebacks.create") },
    { key: "open", label: "All open", show: can(viewer, "chargebacks.view_all") },
    { key: "all", label: "All", show: true },
  ];
  const visibleQueues = queues.filter((q) => q.show);
  const requested = typeof sp.queue === "string" ? (sp.queue as CaseQueue) : undefined;
  const queue: CaseQueue = visibleQueues.some((q) => q.key === requested) ? requested! : visibleQueues[0].key;

  const [list, counts, brandMap, brands, completed30] = await Promise.all([
    listCases(viewer, f, queue),
    queueCounts(viewer, f.brand),
    getBrandMap(),
    getViewerBrands(viewer),
    listCases(viewer, parseFilters({ range: "30d", status: "completed", brand: f.brand ?? undefined, type: "chargeback" }, new Date()), "all", { limit: 1 }),
  ]);
  const countFor: Partial<Record<CaseQueue, number>> = {
    review: counts.review,
    approval: counts.approval,
    processing: counts.processing,
    mine: counts.mine,
    open: counts.open,
  };

  return (
    <>
      <PageHeader eyebrow="Operations"
        title="Recharge / Chargeback Management"
        description="“Recharge” is our term for a payment chargeback. Requests move through review and independent approval before any amount is booked."
        actions={
          <>
            {can(viewer, "chargebacks.view_all") && (
              <Button asChild variant="outline" size="sm">
                <Link href="/recharge/register">Chargeback register</Link>
              </Button>
            )}
            {can(viewer, "chargebacks.create") && (
              <Button asChild size="sm">
                <Link href="/recharge/new">
                  <Plus /> New request
                </Link>
              </Button>
            )}
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {can(viewer, "chargebacks.review") && (
          <KpiCard label="Awaiting my review" value={String(counts.review)} icon={ClipboardCheck} href={`/recharge${toQueryString({}, { queue: "review" })}`} definition="Pending Review cases you may review (excluding your own requests)." />
        )}
        {can(viewer, "chargebacks.approve") && (
          <KpiCard label="Awaiting my approval" value={String(counts.approval)} icon={ShieldCheck} href={`/recharge?queue=approval`} tone={counts.approval ? "warning" : "default"} definition="Pending Approval cases you may approve. Your own requests are excluded (separation of duties)." />
        )}
        <KpiCard label="Open cases" value={String(counts.open)} icon={Hourglass} href={can(viewer, "chargebacks.view_all") ? "/recharge?queue=open" : "/recharge?queue=mine"} definition="Draft, Pending Review, Pending Approval, Approved and Processing cases in your scope." />
        <KpiCard label="My drafts" value={String(counts.drafts)} icon={Inbox} href="/recharge?queue=mine&status=draft" definition="Your requests not yet submitted (or returned for correction)." />
        <KpiCard
          label="Completed (30 days)"
          value={formatMoney(completed30.amount, "USD")}
          sub={`${completed30.total} chargebacks completed`}
          icon={CircleDollarSign}
          href="/recharge/register?status=completed&range=30d&type=chargeback"
          definition="Only Completed chargeback cases count as chargeback amounts. Pending requests are never included."
        />
      </div>

      <nav aria-label="Queues" className="mb-3 flex gap-1 overflow-x-auto border-b">
        {visibleQueues.map((q) => (
          <Link
            key={q.key}
            href={`/recharge${toQueryString({ brand: sp.brand }, { queue: q.key })}`}
            aria-current={q.key === queue ? "page" : undefined}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
              q.key === queue ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {q.label}
            {countFor[q.key] !== undefined && <span className="rounded-full bg-muted px-1.5 text-xs tabular">{countFor[q.key]}</span>}
          </Link>
        ))}
      </nav>

      <SectionCard
        actions={
          <FilterBar
            fields={[
              { kind: "search", placeholder: "Case, transaction, invoice, customer" },
              { kind: "select", param: "brand", label: "Brand", options: brandOptions(brands), allLabel: "All brands" },
              { kind: "select", param: "type", label: "Type", options: Object.entries(CASE_TYPE).map(([value, v]) => ({ value, label: v.label })), allLabel: "All types" },
              { kind: "range" },
            ]}
          />
        }
      >
        <CaseTable
          rows={list.rows}
          brandMap={brandMap}
          emptyTitle={queue === "review" || queue === "approval" ? "Nothing waiting for you" : undefined}
          emptyAction={
            can(viewer, "chargebacks.create") && queue === "mine" ? (
              <Button asChild size="sm">
                <Link href="/recharge/new">
                  <Plus /> New request
                </Link>
              </Button>
            ) : undefined
          }
        />
        <Pagination basePath="/recharge" searchParams={{ ...sp, queue }} page={f.page} total={list.total} />
      </SectionCard>
    </>
  );
}
