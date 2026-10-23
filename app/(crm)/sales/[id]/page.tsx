import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Receipt, UserRound } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/crm/page-header";
import { DetailList, SectionCard } from "@/components/crm/section-card";
import { BrandBadge } from "@/components/crm/brand-badge";
import { VocabBadge } from "@/components/crm/status-badge";
import { AccessDenied } from "@/components/crm/access-denied";
import { EmptyState } from "@/components/crm/empty-state";
import { Timeline } from "@/components/crm/timeline";
import { SALE_STATUS } from "@/components/sales/vocab";
import { can, requireViewer } from "@/lib/auth/viewer";
import { getSaleDetail } from "@/lib/data/sales";
import { getBrandMap } from "@/lib/data/reference";
import { INVOICE_STATUS } from "@/lib/domain/vocab";
import { formatMoney, toCents, formatCents } from "@/lib/money";
import { fmtDate, fmtDateTime, titleCase } from "@/lib/format";

export const metadata: Metadata = { title: "Sale" };

export default async function SaleDetailPage(props: PageProps<"/sales/[id]">) {
  const viewer = await requireViewer();
  if (!can(viewer, "sales.view")) return <AccessDenied />;
  const { id } = await props.params;
  if (!/^[A-Z]{3}-\d{1,10}$/.test(id)) notFound();
  const [detail, brandMap] = await Promise.all([getSaleDetail(viewer, id), getBrandMap()]);
  if (!detail) {
    return <AccessDenied message="This sale doesn't exist or is outside your authorised brands or assigned records." />;
  }
  const { sale } = detail;
  const brand = brandMap.get(sale.brandId);
  const cur = sale.currency;
  const backHref = "/sales";

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: can(viewer, "sales.view_all") ? "All Sales" : "My Sales", href: backHref }, { label: sale.id }]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{sale.id}</span>
            <VocabBadge map={SALE_STATUS} value={sale.status} />
          </span>
        }
        description={
          <>
            Sold to{" "}
            <Link href={`/customers/${sale.customerId}`} className="font-medium text-foreground hover:underline">
              {detail.customerName}
            </Link>{" "}
            on {fmtDate(sale.saleDate)} · {formatMoney(sale.total, cur)}
          </>
        }
        meta={
          <>
            <BrandBadge brand={brand} full />
            {sale.sourceSystem !== "crm" && (
              <span className="text-xs text-muted-foreground">
                Imported from {sale.sourceSystem}
                {sale.sourceRecordId ? ` (${sale.sourceRecordId})` : ""}
              </span>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <SectionCard title="Line items" description={`${detail.items.length} item${detail.items.length === 1 ? "" : "s"} · amounts in ${cur}`}>
            <div className="relative overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Product / service</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Unit price</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Discount</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Tax rate</TableHead>
                    <TableHead className="pr-4 text-right">Line total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.items.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell className="pl-4">
                        <div className="font-medium">{it.description}</div>
                        <div className="font-mono text-xs text-muted-foreground">{it.sku ?? it.productId}</div>
                      </TableCell>
                      <TableCell className="text-right tabular">{it.quantity}</TableCell>
                      <TableCell className="hidden text-right tabular sm:table-cell">{formatMoney(it.unitPrice, cur)}</TableCell>
                      <TableCell className="hidden text-right tabular md:table-cell">
                        {toCents(it.discount) ? `−${formatMoney(it.discount, cur)}` : "—"}
                      </TableCell>
                      <TableCell className="hidden text-right tabular md:table-cell">{Number(it.taxRate) ? `${it.taxRate}%` : "—"}</TableCell>
                      <TableCell className="pr-4 text-right tabular font-medium">{formatMoney(it.lineTotal, cur)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>

              </Table>
            </div>
            <dl className="ml-auto w-full space-y-1.5 border-t px-4 py-3 text-sm sm:max-w-xs">
              <AmountRow label="Subtotal" value={formatMoney(sale.subtotal, cur)} />
              <AmountRow label="Discount" value={toCents(sale.discount) ? `−${formatMoney(sale.discount, cur)}` : formatCents(0, cur)} />
              <AmountRow label="Tax" value={formatMoney(sale.tax, cur)} />
              <AmountRow label="Total" value={formatMoney(sale.total, cur)} strong />
            </dl>
          </SectionCard>

          {can(viewer, "billing.view") && (
            <SectionCard title="Billing records" description="Invoices issued for this sale. Each keeps the brand it was booked with.">
              {detail.invoices.length === 0 ? (
                <EmptyState icon={Receipt} title="No billing record visible" description="This sale hasn't been invoiced, or the invoice is outside your billing scope." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Invoice</TableHead>
                      <TableHead className="hidden sm:table-cell">Billed</TableHead>
                      <TableHead className="hidden md:table-cell">Due</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Paid</TableHead>
                      <TableHead className="pr-4">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.invoices.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell className="pl-4">
                          <Link href={`/billing/${inv.id}`} className="font-mono text-xs font-medium hover:underline">
                            {inv.invoiceNumber}
                          </Link>
                          <div className="font-mono text-xs text-muted-foreground">{inv.id}</div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">{fmtDate(inv.billingDate)}</TableCell>
                        <TableCell className="hidden md:table-cell">{fmtDate(inv.dueDate)}</TableCell>
                        <TableCell className="text-right tabular">{formatMoney(inv.total, inv.currency)}</TableCell>
                        <TableCell className="hidden text-right tabular sm:table-cell">{formatMoney(inv.amountPaid, inv.currency)}</TableCell>
                        <TableCell className="pr-4">
                          <VocabBadge map={INVOICE_STATUS} value={inv.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </SectionCard>
          )}

          {sale.notes && (
            <SectionCard title="Sale notes">
              <p className="p-4 text-sm whitespace-pre-wrap">{sale.notes}</p>
            </SectionCard>
          )}
        </div>

        <div className="space-y-4">
          <SectionCard title="Attribution">
            <DetailList
              columns={1}
              items={[
                {
                  label: "Sales agent (credited)",
                  value: (
                    <span className="flex items-center gap-1.5">
                      <UserRound className="size-3.5 text-muted-foreground" aria-hidden />
                      {can(viewer, "users.manage") ? (
                        <Link href={`/admin/agents/${sale.agentId}`} className="hover:underline">
                          {detail.agentName}
                        </Link>
                      ) : (
                        detail.agentName
                      )}
                    </span>
                  ),
                },
                {
                  label: "Customer",
                  value: (
                    <Link href={`/customers/${sale.customerId}`} className="hover:underline">
                      {detail.customerName} <span className="font-mono text-xs text-muted-foreground">{sale.customerId}</span>
                    </Link>
                  ),
                },
                { label: "Company", value: detail.customerCompany },
                { label: "Brand", value: <BrandBadge brand={brand} full /> },
                { label: "Sale date", value: fmtDateTime(sale.saleDate) },
                { label: "Recorded by", value: detail.createdByName },
                { label: "Source", value: sale.sourceSystem === "crm" ? "Unified CRM" : titleCase(sale.sourceSystem) },
                ...(sale.leadId ? [{ label: "Originating lead", value: <span className="font-mono text-xs">{sale.leadId}</span> }] : []),
              ]}
            />
          </SectionCard>
          <SectionCard title="Activity" description="Audit trail for this sale and its billing records">
            <Timeline
              entries={detail.activity.map((a) => ({
                id: a.id,
                title: a.summary,
                actor: a.actor,
                at: a.createdAt,
                tone: a.action.includes("cancel") || a.action.includes("chargeback") ? "danger" : a.action.includes("paid") || a.action.includes("payment") ? "success" : "default",
              }))}
            />
          </SectionCard>
        </div>
      </div>
    </>
  );
}

function AmountRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-4 ${strong ? "border-t pt-1.5 text-base font-semibold" : ""}`}>
      <dt className={strong ? "" : "text-muted-foreground"}>{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
