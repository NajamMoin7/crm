import type { Metadata } from "next";
import { asc, sql } from "drizzle-orm";
import { Building2, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/crm/page-header";
import { EmptyState } from "@/components/crm/empty-state";
import { BrandMark } from "@/components/crm/brand-badge";
import { ActionButton } from "@/components/crm/action-button";
import { AccessDenied } from "@/components/crm/access-denied";
import { BrandDialog } from "@/components/brands/brand-dialog";
import { can, requireViewer } from "@/lib/auth/viewer";
import { getDb } from "@/lib/db";
import { brands } from "@/lib/db/schema";
import { deleteBrandAction } from "./actions";
import { fmtDate, fmtNumber } from "@/lib/format";

export const metadata: Metadata = { title: "Brands" };

export default async function BrandsPage() {
  const viewer = await requireViewer();
  if (!can(viewer, "brands.manage")) return <AccessDenied />;
  const db = await getDb();
  const rows = await db
    .select({
      id: brands.id,
      code: brands.code,
      name: brands.name,
      color: brands.color,
      logoUrl: brands.logoUrl,
      createdAt: brands.createdAt,
      // Explicit aliases: in single-table selects Drizzle emits bare column names.
      customers: sql<number>`(select count(*)::int from customer_brand_relationships cbr where cbr.brand_id = "brands"."id")`,
      salesCount: sql<number>`(select count(*)::int from sales s where s.brand_id = "brands"."id")`,
    })
    .from(brands)
    .orderBy(asc(brands.createdAt), asc(brands.name));

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
