import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, FileBarChart, Lock } from "lucide-react";
import { PageHeader } from "@/components/crm/page-header";
import { SectionCard } from "@/components/crm/section-card";
import { EmptyState } from "@/components/crm/empty-state";
import { AccessDenied } from "@/components/crm/access-denied";
import { ExportButton } from "@/components/crm/export-button";
import { ReportFilters, type ReportFilterField } from "@/components/dashboard/report-filters";
import { ReportSummaryRow, ReportTable } from "@/components/dashboard/report-table";
import { can, requireViewer } from "@/lib/auth/viewer";
import { resolveMetricFilters } from "@/lib/data/metrics";
import { REPORTS, SCREEN_ROWS, canRunReport, getReportDef, runReport, type ReportDef } from "@/lib/data/reports";
import { brandOptions, getAgentOptions, getBrandMap, getViewerBrands } from "@/lib/data/reference";
import { fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Reports" };

const GROUPS: ReportDef["group"][] = ["Sales", "Billing & collections", "Recharge / Chargeback", "Data quality & integrations"];

export default async function ReportsPage(props: PageProps<"/reports">) {
  const viewer = await requireViewer();
  if (!can(viewer, "reports.view")) return <AccessDenied />;
  const sp = await props.searchParams;
  const key = typeof sp.report === "string" ? sp.report : null;
  const def = getReportDef(key);

  if (!def) return <Catalogue viewer={viewer} unknown={!!key} />;
  if (!canRunReport(viewer, def))
    return <AccessDenied message={def.financial ? "This is a financial report. Your role does not include financial reporting access." : undefined} />;

  const now = new Date();
  const f = await resolveMetricFilters(viewer, sp, now, def.defaultRange);
  const [result, brandMap, brands, agents] = await Promise.all([
    runReport(viewer, def, f, now),
    getBrandMap(),
    getViewerBrands(viewer),
    def.filters.includes("agent") && can(viewer, "sales.view_all") ? getAgentOptions(viewer) : Promise.resolve(null),
  ]);

  const fields: ReportFilterField[] = [];
  for (const k of def.filters) {
    if (k === "range") fields.push({ kind: "range", defaultValue: def.defaultRange });
    if (k === "brand") fields.push({ kind: "select", param: "brand", label: "Brand", options: brandOptions(brands), allLabel: "All brands" });
    if (k === "agent" && agents) fields.push({ kind: "select", param: "agent", label: "Agent", options: agents, allLabel: "All agents" });
    if (k === "customer") fields.push({ kind: "customer" });
    if (k === "type" && def.typeOptions) fields.push({ kind: "select", param: "type", label: def.typeLabel ?? "Type", options: def.typeOptions, allLabel: "All types" });
    if (k === "status" && def.statusOptions)
      fields.push({ kind: "select", param: "status", label: def.statusLabel ?? "Status", options: def.statusOptions, allLabel: "All statuses", defaultValue: def.defaultStatus });
  }
  const shown = result.rows.slice(0, SCREEN_ROWS);

  return (
    <>
      <PageHeader eyebrow="Administration"
        title={def.title}
        description={def.description}
        breadcrumbs={[{ label: "Reports", href: "/reports" }, { label: def.title }]}
        meta={
          def.financial ? (
            <span className="inline-flex h-5 items-center gap-1 rounded-full bg-muted px-2 text-xs text-muted-foreground">
              <Lock className="size-3" aria-hidden /> Financial report
            </span>
          ) : undefined
        }
        actions={can(viewer, "reports.export") ? <ExportButton dataset={`report-${def.key}`} searchParams={sp} /> : undefined}
      />
      <div className="mb-4">
        <ReportFilters fields={fields} />
      </div>
      <ReportSummaryRow items={result.summary} />
      <SectionCard
        className="mt-4"
        title={`${fmtNumber(result.total)} row${result.total === 1 ? "" : "s"}${result.truncated ? " (capped at 10,000)" : ""}`}
        description={result.note}
      >
        {shown.length === 0 ? (
          <EmptyState icon={FileBarChart} title="No records match these filters" description="Widen the date range or clear a filter." />
        ) : (
          <div className="relative overflow-x-auto">
            <ReportTable columns={result.columns} rows={shown} brandMap={brandMap} />
          </div>
        )}
        {result.total > shown.length && (
          <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
            Showing the first {fmtNumber(shown.length)} of {fmtNumber(result.total)} rows. Export CSV for the complete report.
          </p>
        )}
      </SectionCard>
    </>
  );
}

function Catalogue({ viewer, unknown }: { viewer: Awaited<ReturnType<typeof requireViewer>>; unknown: boolean }) {
  return (
    <>
      <PageHeader
        title="Reports"
        description="Operational and financial reports, calculated live from the records you are authorised to see. Every report can be filtered and exported to CSV (exports are audited)."
      />
      {unknown && <p className="mb-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">That report does not exist. Choose one below.</p>}
      <div className="space-y-6">
        {GROUPS.map((g) => (
          <section key={g} aria-labelledby={`grp-${g}`}>
            <h2 id={`grp-${g}`} className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {g}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {REPORTS.filter((r) => r.group === g).map((r) => {
                const ok = canRunReport(viewer, r);
                const body = (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{r.title}</span>
                      {ok ? <ChevronRight className="size-4 text-muted-foreground" aria-hidden /> : <Lock className="size-3.5 text-muted-foreground" aria-label="Restricted" />}
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{r.description}</p>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      {r.financial ? "Financial · " : ""}
                      {ok ? "Available" : r.financial ? "Requires financial reporting access" : "Requires additional permission"}
                    </p>
                  </>
                );
                return (
                  <li key={r.key}>
                    {ok ? (
                      <Link
                        href={`/reports?report=${r.key}`}
                        className="block h-full rounded-xl border bg-card p-4 shadow-xs transition-colors hover:border-foreground/20 hover:bg-accent/30 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                      >
                        {body}
                      </Link>
                    ) : (
                      <div className={cn("h-full rounded-xl border bg-card p-4 opacity-60")} aria-disabled="true">
                        {body}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
