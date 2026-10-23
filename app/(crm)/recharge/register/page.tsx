import type { Metadata } from "next";
import { PageHeader } from "@/components/crm/page-header";
import { SectionCard } from "@/components/crm/section-card";
import { FilterBar } from "@/components/crm/filter-bar";
import { Pagination } from "@/components/crm/pagination";
import { ExportButton } from "@/components/crm/export-button";
import { AccessDenied } from "@/components/crm/access-denied";
import { CaseTable } from "@/components/recharge/case-table";
import { can, requireViewer } from "@/lib/auth/viewer";
import { resolveBrand } from "@/lib/auth/scope";
import { listCases } from "@/lib/data/chargebacks";
import { brandOptions, getAgentOptions, getBrandMap, getViewerBrands } from "@/lib/data/reference";
import { parseFilters } from "@/lib/filters";
import { CASE_STATUS } from "@/lib/domain/vocab";
import { formatMoney } from "@/lib/money";
import { fmtNumber } from "@/lib/format";

export const metadata: Metadata = { title: "Chargeback Register" };

export default async function RegisterPage(props: PageProps<"/recharge/register">) {
  const viewer = await requireViewer();
  if (!can(viewer, "chargebacks.view_all")) return <AccessDenied />;
  const sp = await props.searchParams;
  const f = parseFilters(sp, new Date());
  f.brand = await resolveBrand(viewer, f.brand);
  const [list, brandMap, brands, agents] = await Promise.all([
    listCases(viewer, f, "all"),
    getBrandMap(),
    getViewerBrands(viewer),
    getAgentOptions(viewer),
  ]);

  return (
    <>
      <PageHeader eyebrow="Recharge / Chargeback"
        title="Chargeback Register"
        description="Every chargeback in your scope, with the agent whose order it was raised on."
        actions={can(viewer, "reports.export") ? <ExportButton dataset="chargebacks" searchParams={sp} /> : undefined}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ["Cases", fmtNumber(list.total)],
          ["Requested amount", formatMoney(list.amount, "USD")],
          ["Completed amount", formatMoney(list.completedAmount, "USD")],
          ["Open (not yet booked)", formatMoney(list.openAmount, "USD")],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border bg-card px-4 py-3 shadow-xs">
            <p className="text-xs text-muted-foreground">{k}</p>
            <p className="mt-1 text-lg font-semibold tabular">{v}</p>
          </div>
        ))}
      </div>
      <SectionCard
        actions={
          <FilterBar
            fields={[
              { kind: "search", placeholder: "Case, transaction, invoice, customer, external ref" },
              { kind: "select", param: "brand", label: "Brand", options: brandOptions(brands), allLabel: "All brands" },
              { kind: "select", param: "status", label: "Status", options: Object.entries(CASE_STATUS).map(([value, v]) => ({ value, label: v.label })) },
              { kind: "select", param: "agent", label: "Agent", options: agents, allLabel: "All agents" },
              { kind: "range" },
            ]}
          />
        }
      >
        <CaseTable rows={list.rows} brandMap={brandMap} />
        <Pagination basePath="/recharge/register" searchParams={sp} page={f.page} total={list.total} />
      </SectionCard>
      <p className="mt-3 text-xs text-muted-foreground">
        Requested amount includes every status. Only <strong>Completed</strong> cases are counted as chargeback amounts in dashboards and reports.
      </p>
    </>
  );
}
