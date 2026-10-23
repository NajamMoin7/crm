import type { Metadata } from "next";
import { Building2, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/crm/page-header";
import { EmptyState } from "@/components/crm/empty-state";
import { BrandMark } from "@/components/crm/brand-badge";
import { ActionButton } from "@/components/crm/action-button";
import { AccessDenied } from "@/components/crm/access-denied";
import { BrandDialog } from "@/components/brands/brand-dialog";
import { can, requireViewer } from "@/lib/auth/viewer";
import { getDb } from "@/lib/db";
import { deleteBrandAction } from "./actions";
import { fmtDate, fmtNumber } from "@/lib/format";

export const metadata: Metadata = { title: "Brands" };

export default async function BrandsPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "brands.manage")) return <AccessDenied />;
  const C = await getDb();
  const [list, customerCounts, saleCounts] = await Promise.all([
    C.brands.find({}, { sort: { createdAt: 1, name: 1 }, projection: { id: 1, code: 1, name: 1, color: 1, logoUrl: 1, createdAt: 1 } }).toArray(),
    C.customerBrandRelationships.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$brandId", n: { $sum: 1 } } }]).toArray(),
    C.sales.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$brandId", n: { $sum: 1 } } }]).toArray(),
  ]);
  const count = (rows: { _id: string; n: number }[], id: string) => rows.find((r) => r._id === id)?.n ?? 0;
  const rows = list.map((b) => ({ ...b, customers: count(customerCounts, b.id), salesCount: count(saleCounts, b.id) }));

  return (
    <>
      <PageHeader eyebrow="Administration" title="Brands" description="The brands your team sells under — a name and a logo. Agents get access to brands on the Agents page." />
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{fmtNumber(rows.length)} brands</p>
        <BrandDialog />
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={Building2} title="No brands yet" description="Create your first brand to start recording sales." />
      ) : (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-3" aria-label="Brands">
          {rows.map((b) => {
            const inUse = b.customers + b.salesCount > 0;
            return (
              <li key={b.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs sm:flex-row sm:items-center">
                <BrandMark brand={b} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{b.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <span className="font-mono">{b.id}</span> · {fmtNumber(b.customers)} customers · {fmtNumber(b.salesCount)} sales · since {fmtDate(b.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-1 sm:justify-end">
                  <BrandDialog brand={{ id: b.id, name: b.name, code: b.code, color: b.color, logoUrl: b.logoUrl }} />
                  <ActionButton
                    variant="ghost"
                    label={
                      <>
                        <Trash2 /> Delete
                      </>
                    }
                    confirmTitle={`Delete ${b.name}?`}
                    confirmDescription={
                      inUse
                        ? "This brand has customers or sales. Brands with business history can't be deleted — their records must be kept."
                        : "The brand and its agent access are removed. This can't be undone."
                    }
                    confirmLabel="Delete brand"
                    destructive
                    action={deleteBrandAction.bind(null, b.id)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
