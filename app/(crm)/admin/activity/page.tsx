import type { Metadata } from "next";
import { Activity } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/crm/page-header";
import { FilterBar } from "@/components/crm/filter-bar";
import { SectionCard } from "@/components/crm/section-card";
import { Pagination } from "@/components/crm/pagination";
import { EmptyState } from "@/components/crm/empty-state";
import { BrandBadge } from "@/components/crm/brand-badge";
import { ExportButton } from "@/components/crm/export-button";
import { AccessDenied } from "@/components/crm/access-denied";
import { can, requireViewer } from "@/lib/auth/viewer";
import { ACTIVITY_PAGE_SIZE, getActivityFacets, listActivity } from "@/lib/data/admin";
import { brandOptions, getBrandMap, getViewerBrands } from "@/lib/data/reference";
import { parseFilters } from "@/lib/filters";
import { fmtDateTime, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Activity log" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim().slice(0, 80) || null;

function tone(action: string) {
  if (/(failed|locked|suspended|revoked|rejected|deactivated|ended|deleted)/.test(action)) return "bg-red-500";
  if (/(export|password|permission|settings|merge)/.test(action)) return "bg-amber-500";
  if (/(created|approved|completed|resolved|granted)/.test(action)) return "bg-emerald-500";
  return "bg-muted-foreground/50";
}

export default async function ActivityPage(props: PageProps<"/admin/activity">) {
  const viewer = await requireViewer();
  if (!can(viewer, "audit.view")) return <AccessDenied />;
  const sp = await props.searchParams;
  const now = new Date();
  const base = parseFilters(sp, now);
  const brand = base.brand && viewer.brandIds.includes(base.brand) ? base.brand : null;
  const f = {
    q: base.q,
    actor: one(sp.actor),
    action: one(sp.action),
    entityType: one(sp.type),
    brand,
    from: base.from,
    to: base.to,
    page: base.page,
  };
  const [{ rows, total }, facets, brandMap, brands] = await Promise.all([listActivity(viewer, f), getActivityFacets(), getBrandMap(), getViewerBrands(viewer)]);

  return (
    <>
      <PageHeader eyebrow="Administration"
        title="Activity log"
        description="Immutable audit trail of sign-ins, changes, approvals and exports. Entries cannot be edited or deleted. Secrets are never logged."
        actions={can(viewer, "reports.export") ? <ExportButton dataset="activity" searchParams={sp} /> : undefined}
      />
      <SectionCard
        actions={
          <FilterBar
            fields={[
              { kind: "search", placeholder: "Entity ID or summary" },
              {
                kind: "select",
                param: "actor",
                label: "Actor",
                options: [{ value: "system", label: "System" }, ...facets.actors.map((a) => ({ value: a.id, label: a.name }))],
                allLabel: "All actors",
              },
              { kind: "select", param: "action", label: "Action", options: facets.prefixes, allLabel: "All actions" },
              { kind: "select", param: "type", label: "Entity type", options: facets.entityTypes.map((t) => ({ value: t, label: titleCase(t) })), allLabel: "All entity types" },
              { kind: "select", param: "brand", label: "Brand", options: brandOptions(brands), allLabel: "All brands" },
              { kind: "range" },
            ]}
          />
        }
      >
        {rows.length === 0 ? (
          <EmptyState icon={Activity} title="No activity matches these filters" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Event</TableHead>
                <TableHead className="hidden md:table-cell">Actor</TableHead>
                <TableHead className="hidden lg:table-cell">Record</TableHead>
                <TableHead className="pr-4 text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className="align-top">
                  <TableCell className="max-w-[560px] pl-4 whitespace-normal">
                    <div className="flex items-center gap-2">
                      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone(r.action))} />
                      <code className="text-xs font-medium">{r.action}</code>
                      {r.brandId && <BrandBadge brand={brandMap.get(r.brandId)} />}
                    </div>
                    <div className="mt-0.5 text-sm">{r.summary}</div>
                    <div className="text-xs text-muted-foreground md:hidden">
                      {r.actor ?? "System"} · {r.entityType}
                      {r.entityId ? ` ${r.entityId}` : ""}
                    </div>
                    {r.metadata != null && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs text-primary hover:underline">Metadata</summary>
                        <pre className="mt-1.5 max-h-72 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
                          {JSON.stringify(r.metadata, null, 2)}
                        </pre>
                      </details>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-sm md:table-cell">
                    {r.actor ?? <span className="text-muted-foreground">System</span>}
                    {r.ip && <div className="font-mono text-[11px] text-muted-foreground">{r.ip}</div>}
                  </TableCell>
                  <TableCell className="hidden text-xs lg:table-cell">
                    <div className="text-muted-foreground">{titleCase(r.entityType)}</div>
                    {r.entityId && <div className="font-mono">{r.entityId}</div>}
                  </TableCell>
                  <TableCell className="pr-4 text-right text-xs whitespace-nowrap text-muted-foreground">
                    <time dateTime={r.createdAt.toISOString()}>{fmtDateTime(r.createdAt)}</time>
                    <div className="font-mono text-[10px]">#{r.id}</div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pagination basePath="/admin/activity" searchParams={sp} page={f.page} total={total} pageSize={ACTIVITY_PAGE_SIZE} />
      </SectionCard>
    </>
  );
}
