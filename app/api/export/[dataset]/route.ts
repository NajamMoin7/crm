import type { NextRequest } from "next/server";
import { format } from "date-fns";
import { getDb } from "@/lib/db";
import { can, getViewer } from "@/lib/auth/viewer";
import { logActivity } from "@/lib/audit";
import { csvStream, type CsvColumn } from "@/lib/csv";
import { resolveMetricFilters } from "@/lib/data/metrics";
import { DATASETS, MAX_ROWS, buildDataset, canRunReport, getReportDef, reportCsvColumns, runReport } from "@/lib/data/reports";
import type { RawSearchParams } from "@/lib/filters";

/**
 * GET /api/export/<dataset>?<same filters as the page>
 * Re-authenticates, re-applies row-level scope, streams an RFC 4180 CSV and
 * writes an `export.csv` audit entry for every download.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/export/[dataset]">) {
  const viewer = await getViewer();
  if (!viewer) return Response.json({ error: "Unauthenticated" }, { status: 401 });
  if (!can(viewer, "reports.export")) return Response.json({ error: "You do not have permission to export data." }, { status: 403 });

  const { dataset } = await ctx.params;
  const now = new Date();
  const sp: RawSearchParams = {};
  for (const [k, v] of request.nextUrl.searchParams) if (sp[k] === undefined) sp[k] = v;

  let columns: CsvColumn<Record<string, unknown>>[];
  let rows: Record<string, unknown>[];
  let financial: boolean;
  let filtersMeta: Record<string, unknown>;

  if (dataset.startsWith("report-")) {
    const def = getReportDef(dataset.slice(7));
    if (!def) return Response.json({ error: "Unknown dataset" }, { status: 404 });
    if (!canRunReport(viewer, def)) return Response.json({ error: "You do not have permission to export this report." }, { status: 403 });
    const f = await resolveMetricFilters(viewer, sp, now, def.defaultRange);
    const result = await runReport(viewer, def, f, now);
    columns = reportCsvColumns(result.columns) as CsvColumn<Record<string, unknown>>[];
    rows = result.rows;
    financial = def.financial;
    filtersMeta = metaOf(f);
  } else {
    const ds = DATASETS[dataset];
    if (!ds) return Response.json({ error: "Unknown dataset" }, { status: 404 });
    if (!can(viewer, ...ds.perms)) return Response.json({ error: "You do not have permission to export this dataset." }, { status: 403 });
    const f = await resolveMetricFilters(viewer, sp, now, ds.defaultRange);
    // Same default range ("all") as the list pages, so the CSV matches what the list shows.
    const built = await buildDataset(viewer, dataset, f, sp);
    columns = built.columns;
    rows = built.rows.slice(0, MAX_ROWS);
    financial = ds.financial;
    filtersMeta = metaOf(f);
  }

  const db = await getDb();
  await logActivity(db, {
    actorId: viewer.id,
    action: "export.csv",
    entityType: "export",
    entityId: dataset,
    summary: `Exported ${rows.length} ${financial ? "financial " : ""}row${rows.length === 1 ? "" : "s"} from ${dataset} to CSV`,
    metadata: { dataset, filters: filtersMeta, rowCount: rows.length, financial, capped: rows.length >= MAX_ROWS },
  });

  const filename = `${dataset}-${format(now, "yyyyMMdd-HHmm")}.csv`;
  return new Response(csvStream(columns, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Row-Count": String(rows.length),
    },
  });
}

function metaOf(f: Awaited<ReturnType<typeof resolveMetricFilters>>) {
  return {
    q: f.q || undefined,
    brand: f.brand,
    status: f.status,
    agent: f.agent,
    entity: f.entity,
    type: f.type,
    customer: f.customer,
    range: f.range,
    from: f.from?.toISOString() ?? null,
    to: f.to?.toISOString() ?? null,
  };
}
