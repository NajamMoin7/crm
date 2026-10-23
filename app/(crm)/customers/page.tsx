import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, GitMerge, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { resolveBrand } from "@/lib/auth/scope";
import { listCustomers } from "@/lib/data/customers";
import { brandOptions, getBrandMap, getViewerBrands } from "@/lib/data/reference";
import { parseFilters } from "@/lib/filters";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage(props: PageProps<"/customers">) {
  const viewer = await requireViewer();
  if (!can(viewer, "customers.view")) return <AccessDenied />;
  const sp = await props.searchParams;
  const f = parseFilters(sp, new Date());
  f.brand = await resolveBrand(viewer, f.brand);
  const [{ rows, total }, brandMap, brands] = await Promise.all([listCustomers(viewer, f), getBrandMap(), getViewerBrands(viewer)]);
  const canOrder = can(viewer, "billing.create");
  const newOrder = (
    <Button asChild size="sm">
      <Link href="/billing/new">
        <Plus /> New order
      </Link>
    </Button>
  );

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Customers"
        description={
          can(viewer, "customers.view_all")
            ? "One customer record across every brand. Customers are added automatically when an agent saves an order."
            : "Customers you own or have sold to."
        }
        actions={
          <>
            {can(viewer, "customers.merge") && (
              <Button asChild variant="ghost" size="sm">
                <Link href="/customers/duplicates">
                  <GitMerge /> Duplicates
                </Link>
              </Button>
            )}
            {can(viewer, "reports.export") && <ExportButton dataset="customers" searchParams={sp} />}
            {canOrder && newOrder}
          </>
        }
      />
      <SectionCard
        actions={
          <FilterBar
            fields={[
              { kind: "search", placeholder: "Name, email, phone or ID" },
              ...(brands.length > 1 ? [{ kind: "select" as const, param: "brand", label: "Brand", options: brandOptions(brands), allLabel: "All brands" }] : []),
            ]}
          />
        }
      >
        {rows.length === 0 ? (
          <EmptyState icon={Users} title="No customers found" description="Customers appear here once an order is saved for them." action={canOrder ? newOrder : undefined} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Customer</TableHead>
                <TableHead className="hidden md:table-cell">Email</TableHead>
                <TableHead className="hidden sm:table-cell">Phone</TableHead>
                <TableHead>Brands</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id} className="group">
                  <TableCell className="pl-4">
                    <Link href={`/customers/${c.id}`} className="font-medium hover:text-primary focus-visible:underline focus-visible:outline-none">
                      {c.fullName}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      <span className="font-mono">{c.id}</span>
                      {c.companyName ? ` · ${c.companyName}` : ""}
                    </div>
                  </TableCell>
                  <TableCell className="hidden max-w-64 truncate text-sm md:table-cell">{c.email ?? "—"}</TableCell>
                  <TableCell className="hidden text-sm whitespace-nowrap sm:table-cell">{c.phone ?? "—"}</TableCell>
                  <TableCell>
                    {(c.brandIds ?? []).length ? (
                      <div className="flex flex-wrap gap-1">
                        {(c.brandIds ?? []).map((b) => (
                          <BrandBadge key={b} brand={brandMap.get(b)} />
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">Not billed yet</span>
                    )}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/customers/${c.id}`} aria-label={`Open ${c.fullName}`}>
                        View <ChevronRight />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pagination basePath="/customers" searchParams={sp} page={f.page} total={total} />
      </SectionCard>
    </>
  );
}
