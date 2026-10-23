import type { Metadata } from "next";
import { Cable, Database, Info, ListChecks } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/crm/page-header";
import { SectionCard } from "@/components/crm/section-card";
import { VocabBadge } from "@/components/crm/status-badge";
import { BrandBadge } from "@/components/crm/brand-badge";
import { EmptyState } from "@/components/crm/empty-state";
import { AccessDenied } from "@/components/crm/access-denied";
import { BrandLogo } from "@/components/brands/brand-logo";
import { DryRunButton, SyncConfigDialog, TestConnectionButton } from "@/components/admin/integration-controls";
import { INTEGRATION_STATUS, RUN_KIND, RUN_STATUS } from "@/components/admin/vocab";
import { can, requireViewer } from "@/lib/auth/viewer";
import { listIntegrations } from "@/lib/data/brands";
import { fmtDateTime, fmtNumber, fmtRelative } from "@/lib/format";

export const metadata: Metadata = { title: "Integrations" };

const PLAN: [string, string][] = [
  ["Inspect source databases", "Read-only access to each brand's existing database; catalogue tables, volumes and data quality."],
  ["Map schemas", "Map source tables/fields to CRM customers, sales, invoices, payments and chargebacks; document transforms."],
  ["Preserve source IDs", "Keep every original identifier (source_system + source_record_id) on imported rows."],
  ["External record mappings", "Record source → CRM id pairs in external_record_mappings so re-runs are idempotent."],
  ["Duplicate detection", "Match customers across brands by email / phone / name; queue candidates for human review — never auto-merge."],
  ["Dry run", "Run the full pipeline without writing; produce counts, flagged records and validation errors."],
  ["Reconciliation reports", "Compare source vs. imported totals per brand, entity and period before sign-off."],
  ["Authorisation", "Finance and brand owners approve the dry-run results."],
  ["Batched import", "Import in idempotent batches with checkpoints; ledger rows are append-only."],
  ["Verification", "Re-run reconciliation and spot-check records with each brand team."],
  ["Ongoing sync", "Keep systems in step via source APIs, signed webhooks and scheduled jobs."],
  ["Monitoring & retry", "Alert on failures, retry with backoff, dead-letter queue for rejected records."],
  ["Backups & rollback", "Point-in-time backups before each import; documented rollback per batch."],
  ["Cut-over", "Freeze legacy writes, final delta sync, switch users to the CRM and archive read-only access."],
];

export default async function IntegrationsPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "integrations.view")) return <AccessDenied />;
  const now = new Date();
  const sources = await listIntegrations(viewer);
  const canManage = can(viewer, "integrations.manage");
  const allRuns = sources.flatMap((s) => s.runs.map((r) => ({ ...r, brand: s.brand }))).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  return (
    <>
      <PageHeader eyebrow="Settings"
        title="Integration settings"
        description="Connections to each brand's existing billing systems for import and ongoing sync."
      />
      <div role="note" className="mb-5 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          <span className="font-medium">Demo — simulated, no live system contacted.</span> Test connections and dry runs generate sample results only.
          Credentials are referenced by server environment variable name and never stored in the database or shown in the browser.
        </p>
      </div>

      {sources.length === 0 ? (
        <div className="rounded-xl border bg-card">
          <EmptyState icon={Cable} title="No integration sources in your brands" />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {sources.map((s) => {
            const lastTest = s.runs.find((r) => r.kind === "test_connection");
            const lastDry = s.runs.find((r) => r.kind === "dry_run");
            return (
              <article key={s.id} id={s.id} className="flex scroll-mt-20 flex-col overflow-hidden rounded-xl border bg-card shadow-xs" aria-labelledby={`${s.id}-title`}>
                <header className="flex items-start gap-3 p-4">
                  <BrandLogo color={s.brand.color} text={s.brand.logoText} name={s.brand.name} />
                  <div className="min-w-0 flex-1">
                    <h2 id={`${s.id}-title`} className="truncate text-sm font-semibold">
                      {s.brand.name}
                    </h2>
                    <div className="truncate text-xs text-muted-foreground">
                      {s.systemName} · {s.domain}
                    </div>
                  </div>
                  <VocabBadge map={INTEGRATION_STATUS} value={s.status} />
                </header>
                <dl className="grid grid-cols-3 gap-px border-y bg-border">
                  <div className="bg-card px-4 py-2.5">
                    <dt className="text-[11px] text-muted-foreground">Imported</dt>
                    <dd className="text-base font-semibold tabular">{fmtNumber(s.importedCount)}</dd>
                  </div>
                  <div className="bg-card px-4 py-2.5">
                    <dt className="text-[11px] text-muted-foreground">Needs review</dt>
                    <dd className="text-base font-semibold tabular text-amber-700 dark:text-amber-400">{fmtNumber(s.reviewCount)}</dd>
                  </div>
                  <div className="bg-card px-4 py-2.5">
                    <dt className="text-[11px] text-muted-foreground">Errors</dt>
                    <dd className="text-base font-semibold tabular text-red-600 dark:text-red-400" data-testid={`errors-${s.id}`}>
                      {fmtNumber(s.errorCount)}
                    </dd>
                  </div>
                </dl>
                <dl className="grid flex-1 gap-2 p-4 text-xs">
                  <Row label="Last sync" value={s.lastSyncAt ? `${fmtDateTime(s.lastSyncAt)} (${fmtRelative(s.lastSyncAt, now)})` : "Never"} />
                  <Row label="Last test" value={lastTest ? `${RUN_STATUS[lastTest.status]?.label} · ${fmtRelative(lastTest.startedAt, now)}` : "—"} />
                  <Row label="Last dry run" value={lastDry ? `${lastDry.recordsRead} read · ${lastDry.recordsFlagged} flagged` : "—"} />
                  <Row label="Mode · schedule" value={`${s.config.mode === "pull" ? "Pull" : "Webhook"} · ${s.config.schedule}`} />
                  <Row label="Credentials" value={<code className="text-[11px]">{s.config.credentialsRef}</code>} />
                </dl>
                <footer className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-2.5">
                  {canManage && <TestConnectionButton sourceId={s.id} />}
                  {canManage && <DryRunButton sourceId={s.id} brandName={s.brand.name} />}
                  <span className="ml-auto">
                    <SyncConfigDialog sourceId={s.id} brandName={s.brand.name} config={s.config} canEdit={canManage} />
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <SectionCard title="Import history" description="Every simulated test, dry run and import. Expand a row to see its errors.">
          {allRuns.length === 0 ? (
            <EmptyState icon={Database} title="No runs yet" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Run</TableHead>
                  <TableHead className="hidden sm:table-cell">Brand</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Read / imported / flagged</TableHead>
                  <TableHead className="pr-4 text-right">Errors</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {allRuns.map((r) => {
                  const errors = Array.isArray(r.errors) ? (r.errors as { message?: string }[]) : [];
                  return (
                    <TableRow key={r.id} data-run={r.id}>
                      <TableCell className="pl-4 align-top">
                        <div className="text-sm font-medium">{RUN_KIND[r.kind] ?? r.kind}</div>
                        <div className="text-xs text-muted-foreground">
                          <span className="font-mono">{r.id}</span> · {fmtDateTime(r.startedAt)}
                          {r.triggeredByName ? ` · ${r.triggeredByName}` : ""}
                        </div>
                        {errors.length > 0 ? (
                          <details className="group mt-1">
                            <summary className="cursor-pointer text-xs text-primary hover:underline">
                              {r.message ?? "Details"} — show {errors.length} message{errors.length > 1 ? "s" : ""}
                            </summary>
                            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                              {errors.map((e, i) => (
                                <li key={i}>{e.message ?? JSON.stringify(e)}</li>
                              ))}
                            </ul>
                          </details>
                        ) : (
                          r.message && <div className="mt-1 text-xs text-muted-foreground">{r.message}</div>
                        )}
                      </TableCell>
                      <TableCell className="hidden align-top sm:table-cell">
                        <BrandBadge brand={r.brand} />
                      </TableCell>
                      <TableCell className="align-top">
                        <VocabBadge map={RUN_STATUS} value={r.status} />
                      </TableCell>
                      <TableCell className="hidden text-right align-top text-xs tabular md:table-cell">
                        {r.recordsRead} / {r.recordsImported} / {r.recordsFlagged}
                      </TableCell>
                      <TableCell className="pr-4 text-right align-top tabular">{r.errorCount}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </SectionCard>

        <SectionCard title={<span className="flex items-center gap-2"><ListChecks className="size-4" aria-hidden /> Production migration plan</span>} description="How the brands' live systems will be connected before go-live.">
          <ol className="divide-y">
            {PLAN.map(([title, body], i) => (
              <li key={title} className="flex gap-3 px-4 py-2.5">
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold tabular">{i + 1}</span>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{title}</div>
                  <p className="text-xs text-muted-foreground">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </SectionCard>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}
