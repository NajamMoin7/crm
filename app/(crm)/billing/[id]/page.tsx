import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Ban, CalendarClock, FileCheck2, Info, Lock, ReceiptText, RotateCcw } from "lucide-react";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/crm/page-header";
import { DetailList, SectionCard } from "@/components/crm/section-card";
import { BrandBadge } from "@/components/crm/brand-badge";
import { StatusBadge, VocabBadge } from "@/components/crm/status-badge";
import { AccessDenied } from "@/components/crm/access-denied";
import { EmptyState } from "@/components/crm/empty-state";
import { Timeline } from "@/components/crm/timeline";
import { ActionButton } from "@/components/crm/action-button";
import { CreatedToast, RecordPaymentDialog, RefundDialog, type RefundablePayment } from "@/components/billing/invoice-actions";
import { localIsoDate } from "@/components/billing/schema";
import { MANUAL_TRANSITIONS, PAYABLE_STATUSES, type InvoiceStatus } from "@/components/billing/math";
import { transitionInvoiceAction } from "@/app/(crm)/billing/actions";
import { can, requireViewer } from "@/lib/auth/viewer";
import { getInvoiceDetail } from "@/lib/data/billing";
import { getBrandMap } from "@/lib/data/reference";
import { CASE_STATUS, CASE_TYPE, INVOICE_STATUS, PAYMENT_METHOD, TRANSACTION_STATUS, TRANSACTION_TYPE } from "@/lib/domain/vocab";
import { formatCents, formatMoney, toCents } from "@/lib/money";
import { maskReference } from "@/lib/mask";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export async function generateMetadata(props: PageProps<"/billing/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  return { title: `Invoice ${id}` };
}

export default async function InvoiceDetailPage(props: PageProps<"/billing/[id]">) {
  const viewer = await requireViewer();
  if (!can(viewer, "billing.view")) return <AccessDenied />;
  const { id } = await props.params;
  const d = await getInvoiceDetail(viewer, decodeURIComponent(id));
  if (!d) notFound();
  const now = new Date();
  const brandMap = await getBrandMap();
  const inv = d.invoice;
  const brand = brandMap.get(inv.brandId);
  const { total, paid, approvedAdj, balance } = d.money;
  const status = inv.status as InvoiceStatus;
  const showRefs = can(viewer, "transactions.view");
  const canManage = can(viewer, "billing.manage");
  const hasPayments = d.ledger.some((t) => t.type === "payment");
  const canRaiseCase = can(viewer, "chargebacks.create");
  const pastDue = inv.dueDate < now;

  // Per-payment refundable amounts (payment − refunds − chargebacks booked against it).
  const used = new Map<string, number>();
  for (const t of d.ledger) {
    if ((t.type === "refund" || t.type === "chargeback") && t.status === "succeeded" && t.relatedTransactionId) {
      used.set(t.relatedTransactionId, (used.get(t.relatedTransactionId) ?? 0) + toCents(t.amount));
    }
  }
  const payments: RefundablePayment[] = d.ledger
    .filter((t) => t.type === "payment" && t.status === "succeeded")
    .map((t) => ({
      id: t.id,
      amount: toCents(t.amount),
      refundable: Math.max(0, toCents(t.amount) - (used.get(t.id) ?? 0)),
      reference: showRefs ? (t.paymentReference ?? "") : maskReference(t.paymentReference),
      occurredAt: t.occurredAt.toISOString(),
    }));
  const refunded = d.ledger.filter((t) => t.type === "refund" && t.status === "succeeded").reduce((s, t) => s + toCents(t.amount), 0);
  const chargedBack = d.ledger.filter((t) => t.type === "chargeback" && t.status === "succeeded").reduce((s, t) => s + toCents(t.amount), 0);

  const canPay = canManage && PAYABLE_STATUSES.includes(status) && balance > 0;
  const canRefund = canManage && paid > 0 && payments.some((p) => p.refundable > 0);
  const canIssue = canManage && MANUAL_TRANSITIONS.issue.from.includes(status);
  const canOverdue = canManage && MANUAL_TRANSITIONS.mark_overdue.from.includes(status) && pastDue;
  const canCancel = canManage && MANUAL_TRANSITIONS.cancel.from.includes(status) && !hasPayments && paid === 0;

  return (
    <>
      <CreatedToast invoiceNumber={inv.invoiceNumber} />
      <PageHeader
        breadcrumbs={[{ label: "Billing Records", href: "/billing" }, { label: inv.invoiceNumber }]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{inv.invoiceNumber}</span>
            <VocabBadge map={INVOICE_STATUS} value={inv.status} />
          </span>
        }
        description={
          <>
            {d.customerName}
            {d.customerCompany ? ` · ${d.customerCompany}` : ""} · billed {fmtDate(inv.billingDate)} · due {fmtDate(inv.dueDate)}
          </>
        }
        meta={
          <>
            <BrandBadge brand={brand} full />
            <span className="text-xs text-muted-foreground">{inv.id}</span>
          </>
        }
        actions={
          canManage ? (
            <>
              {canIssue && (
                <ActionButton
                  action={transitionInvoiceAction.bind(null, inv.id, "issue")}
                  label={
                    <>
                      <FileCheck2 /> Issue invoice
                    </>
                  }
                  confirmTitle={`Issue ${inv.invoiceNumber}?`}
                  confirmDescription="The draft becomes a Pending invoice and can receive payments."
                  confirmLabel="Issue invoice"
                  withNote
                />
              )}
              {canPay && (
                <RecordPaymentDialog
                  invoiceId={inv.id}
                  balance={balance}
                  currency={inv.currency}
                  methods={d.allowedPaymentMethods}
                  defaultMethod={inv.paymentMethod}
                  today={localIsoDate(now)}
                  minDate={localIsoDate(inv.billingDate)}
                />
              )}
              {canRefund && <RefundDialog invoiceId={inv.id} currency={inv.currency} payments={payments} paid={paid} />}
              {canOverdue && (
                <ActionButton
                  action={transitionInvoiceAction.bind(null, inv.id, "mark_overdue")}
                  variant="outline"
                  label={
                    <>
                      <CalendarClock /> Mark overdue
                    </>
                  }
                  confirmTitle="Mark this invoice overdue?"
                  confirmDescription={`It was due ${fmtDate(inv.dueDate)}. The balance of ${formatCents(balance, inv.currency)} stays collectable.`}
                  confirmLabel="Mark overdue"
                  withNote
                />
              )}
              {canCancel && (
                <ActionButton
                  action={transitionInvoiceAction.bind(null, inv.id, "cancel")}
                  variant="destructive"
                  destructive
                  label={
                    <>
                      <Ban /> Cancel
                    </>
                  }
                  confirmTitle={`Cancel ${inv.invoiceNumber}?`}
                  confirmDescription="Cancelled invoices are kept for audit but no longer collectable. The related sale is cancelled too. This cannot be undone."
                  confirmLabel="Cancel invoice"
                  withNote
                  noteRequired
                  noteLabel="Reason"
                />
              )}
            </>
          ) : undefined
        }
      />

      {!canManage && (
        <p className="mb-4 flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          Read-only. Payments, refunds and status changes are recorded by a Super Admin.
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <SectionCard title="Line items" description="Legal snapshot of what was billed.">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Description</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Unit price</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Discount</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Tax rate</TableHead>
                  <TableHead className="pr-4 text-right">Line total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.items.map((it) => {
                  const sl = d.saleLines.find((s) => s.id === it.saleItemId);
                  return (
                    <TableRow key={it.id}>
                      <TableCell className="pl-4">{it.description}</TableCell>
                      <TableCell className="text-right tabular">{it.quantity}</TableCell>
                      <TableCell className="hidden text-right tabular sm:table-cell">{formatMoney(it.unitPrice, inv.currency)}</TableCell>
                      <TableCell className="hidden text-right tabular md:table-cell">{sl ? formatMoney(sl.discount, inv.currency) : "—"}</TableCell>
                      <TableCell className="hidden text-right tabular md:table-cell">{sl ? `${Number(sl.taxRate).toFixed(2)}%` : "—"}</TableCell>
                      <TableCell className="pr-4 text-right tabular">{formatMoney(it.lineTotal, inv.currency)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableFooter className="bg-transparent">
                <TotalRow label="Subtotal" value={formatMoney(inv.subtotal, inv.currency)} />
                <TotalRow label="Discount" value={`−${formatMoney(inv.discount, inv.currency)}`} />
                <TotalRow label="Tax" value={formatMoney(inv.tax, inv.currency)} />
                <TotalRow label="Total" value={formatMoney(inv.total, inv.currency)} strong testId="invoice-total" />
              </TableFooter>
            </Table>
          </SectionCard>

          <SectionCard
            title="Payments & ledger"
            description="Every money movement on this invoice. Ledger rows are append-only; corrections are new rows."
          >
            {d.ledger.length === 0 ? (
              <EmptyState icon={ReceiptText} title="No ledger activity yet" description={status === "draft" ? "Issue the invoice to start collecting." : "Payments, refunds, chargebacks and adjustments appear here."} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Transaction</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="hidden md:table-cell">Method / reference</TableHead>
                    <TableHead className="hidden sm:table-cell">Status</TableHead>
                    <TableHead className="pr-4 text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.ledger.map((t) => {
                    const meta = TRANSACTION_TYPE[t.type];
                    const signed = toCents(t.amount) * (meta?.sign ?? 1);
                    return (
                      <TableRow key={t.id}>
                        <TableCell className="pl-4">
                          <div className="font-mono text-xs">{t.id}</div>
                          <div className="text-xs text-muted-foreground">{fmtDateTime(t.occurredAt)}</div>
                        </TableCell>
                        <TableCell>
                          <VocabBadge map={TRANSACTION_TYPE} value={t.type} />
                          {t.relatedTransactionId && <div className="mt-0.5 text-[11px] text-muted-foreground">re {t.relatedTransactionId}</div>}
                          {t.chargebackCaseId && (
                            <Link href={`/recharge/${t.chargebackCaseId}`} className="mt-0.5 block text-[11px] text-primary hover:underline">
                              {t.chargebackCaseId}
                            </Link>
                          )}
                          {t.adjustmentId && <div className="mt-0.5 text-[11px] text-muted-foreground">{t.adjustmentId}</div>}
                          {canRaiseCase && t.type === "payment" && t.status === "succeeded" && (
                            <Link href={`/recharge/new?txn=${t.id}`} className="mt-0.5 block text-[11px] text-primary hover:underline">
                              Raise recharge
                            </Link>
                          )}
                        </TableCell>
                        <TableCell className="hidden max-w-56 md:table-cell">
                          <div className="text-sm">{t.paymentMethod ? PAYMENT_METHOD[t.paymentMethod] : "—"}</div>
                          <div className="truncate font-mono text-xs text-muted-foreground" title={showRefs ? (t.paymentReference ?? undefined) : undefined}>
                            {t.processor ? `${t.processor} · ` : ""}
                            {showRefs ? (t.paymentReference ?? "—") : maskReference(t.paymentReference)}
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <VocabBadge map={TRANSACTION_STATUS} value={t.status} />
                        </TableCell>
                        <TableCell className={cn("pr-4 text-right font-medium tabular", signed < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
                          {signed < 0 ? "−" : "+"}
                          {formatCents(Math.abs(signed), t.currency)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </SectionCard>

          {(d.cases.length > 0 || can(viewer, "chargebacks.view")) && (
            <SectionCard title="Recharge / chargeback cases" description="Disputes raised against payments on this invoice.">
              {d.cases.length === 0 ? (
                <EmptyState icon={RotateCcw} title="No chargeback cases" description="No recharge or chargeback has been raised for this invoice." />
              ) : (
                <ul className="divide-y">
                  {d.cases.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                      <div>
                        <Link href={`/recharge/${c.id}`} className="font-mono font-medium hover:underline">
                          {c.id}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {CASE_TYPE[c.caseType]?.label ?? c.caseType} · reason {c.reasonCode} · {fmtDate(c.requestDate)}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <VocabBadge map={CASE_STATUS} value={c.status} />
                        <span className="tabular">{formatMoney(c.amount, c.currency)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          )}

          <SectionCard title="Activity" description="Audit trail for this invoice, its sale and ledger rows.">
            <Timeline
              entries={d.activity.map((a) => ({
                id: a.id,
                title: a.summary,
                actor: a.actor,
                at: a.createdAt,
                tone: /refund|cancel|reject/.test(a.action) ? "danger" : /payment|approved|issued/.test(a.action) ? "success" : a.action.includes("overdue") ? "warning" : "default",
              }))}
            />
          </SectionCard>
        </div>

        <div className="space-y-6">
          <SectionCard title="Balance">
            <dl className="space-y-2 p-4 text-sm tabular">
              <BalanceRow label="Invoice total" value={formatCents(total, inv.currency)} />
              <BalanceRow label="Amount paid (net of refunds)" value={`−${formatCents(paid, inv.currency)}`} />
              {refunded > 0 && <BalanceRow label="of which refunded" value={formatCents(refunded, inv.currency)} muted />}
              {approvedAdj > 0 && <BalanceRow label="Adjustments" value={`−${formatCents(approvedAdj, inv.currency)}`} />}
              {chargedBack > 0 && <BalanceRow label="Chargebacks (completed)" value={formatCents(chargedBack, inv.currency)} muted />}
              <div className="flex items-center justify-between border-t pt-2">
                <dt className="font-semibold">Balance due</dt>
                <dd className={cn("text-lg font-semibold", balance > 0 && pastDue && PAYABLE_STATUSES.includes(status) && "text-red-600 dark:text-red-400")} data-testid="balance-due">
                  {["cancelled", "draft"].includes(status) ? "—" : formatCents(balance, inv.currency)}
                </dd>
              </div>
            </dl>
            <p className="flex items-start gap-1.5 border-t px-4 py-2.5 text-[11px] text-muted-foreground">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
              Balance = total − amount paid.
            </p>
          </SectionCard>

          <SectionCard title="Details">
            <DetailList
              columns={1}
              items={[
                {
                  label: "Customer",
                  value: (
                    <Link href={`/customers/${inv.customerId}`} className="hover:underline">
                      {d.customerName} <span className="font-mono text-xs text-muted-foreground">{inv.customerId}</span>
                    </Link>
                  ),
                },
                { label: "Sales agent", value: d.agentName ?? "—" },
                {
                  label: "Sale",
                  value: (
                    <Link href={`/sales/${inv.saleId}`} className="font-mono hover:underline">
                      {inv.saleId}
                    </Link>
                  ),
                },
                { label: "Sale date", value: fmtDate(d.saleDate) },
                { label: "Agent invoice #", value: inv.sourceRecordId ?? "—" },
                { label: "Payment method", value: PAYMENT_METHOD[inv.paymentMethod] ?? inv.paymentMethod },
                { label: "Billing address", value: inv.billingAddress ?? "—" },
                { label: "Source", value: inv.sourceSystem === "crm" ? "Recorded in CRM" : `Imported (${inv.sourceSystem})` },
              ]}
            />
          </SectionCard>

          {(inv.notes || d.saleNotes) && (
            <SectionCard title="Notes">
              <div className="space-y-3 p-4 text-sm">
                {d.saleNotes && (
                  <div>
                    <div className="text-xs text-muted-foreground">Sale notes</div>
                    <p className="whitespace-pre-wrap">{d.saleNotes}</p>
                  </div>
                )}
                {inv.notes && (
                  <div>
                    <div className="text-xs text-muted-foreground">Billing notes</div>
                    <p className="whitespace-pre-wrap">{inv.notes}</p>
                  </div>
                )}
              </div>
            </SectionCard>
          )}
          <p className="px-1 text-[11px] text-muted-foreground">
            <StatusBadge tone="warning" label="Demo" className="mr-1.5" />
            Payments are simulated — no live processor is contacted.
          </p>
        </div>
      </div>
    </>
  );
}

function TotalRow({ label, value, strong, testId }: { label: string; value: string; strong?: boolean; testId?: string }) {
  return (
    <TableRow className="border-0 hover:bg-transparent">
      <TableCell colSpan={5} className={cn("hidden py-1 text-right md:table-cell", strong ? "font-semibold" : "text-muted-foreground")}>
        {label}
      </TableCell>
      <TableCell colSpan={2} className={cn("py-1 text-right md:hidden", strong ? "font-semibold" : "text-muted-foreground")}>
        {label}
      </TableCell>
      <TableCell className={cn("py-1 pr-4 text-right tabular", strong && "text-base font-semibold")} data-testid={testId}>
        {value}
      </TableCell>
    </TableRow>
  );
}

function BalanceRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={cn("flex items-center justify-between gap-3", muted && "text-xs text-muted-foreground")}>
      <dt className={muted ? "pl-3" : "text-muted-foreground"}>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
