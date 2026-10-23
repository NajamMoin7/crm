import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowRight, GitMerge, Lock, Receipt, RotateCcw, ShoppingBag, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/crm/page-header";
import { DetailList, SectionCard } from "@/components/crm/section-card";
import { KpiCard } from "@/components/crm/kpi-card";
import { BrandBadge, BrandMark } from "@/components/crm/brand-badge";
import { StatusBadge, VocabBadge } from "@/components/crm/status-badge";
import { EmptyState } from "@/components/crm/empty-state";
import { Timeline } from "@/components/crm/timeline";
import { AccessDenied } from "@/components/crm/access-denied";
import { ProfileTabs } from "@/components/customers/profile-tabs";
import { NoteForm } from "@/components/customers/note-form";
import { EditCustomerDialog } from "@/components/customers/customer-form";
import { SALE_STATUS } from "@/components/sales/vocab";
import { can, requireViewer } from "@/lib/auth/viewer";
import { getCustomerProfile } from "@/lib/data/customers";
import { getAgents, getBrandMap } from "@/lib/data/reference";
import { CASE_STATUS, CUSTOMER_STATUS, INVOICE_STATUS, PAYMENT_METHOD, TRANSACTION_STATUS, TRANSACTION_TYPE } from "@/lib/domain/vocab";
import { formatCents, formatMoney, toCents } from "@/lib/money";
import { maskReference } from "@/lib/mask";
import { fmtDate, fmtDateTime, fmtNumber, fmtRelative } from "@/lib/format";

export const metadata: Metadata = { title: "Customer profile" };

export default async function CustomerProfilePage(props: PageProps<"/customers/[id]">) {
  const viewer = await requireViewer();
  if (!can(viewer, "customers.view")) return <AccessDenied />;
  const { id } = await props.params;
  if (!/^CUS-\d{1,12}$/i.test(id)) notFound();
  const profile = await getCustomerProfile(viewer, id.toUpperCase());
  if (!profile) {
    return <AccessDenied message="This customer doesn't exist or isn't linked to your authorised brands and assigned records." />;
  }
  const { customer: c, brandRels, saleRows, invoiceRows, caseRows, paymentRows, noteRows, activity, agent, dupes } = profile;
  const now = new Date();
  const [brandMap, agents] = await Promise.all([getBrandMap(), can(viewer, "agents.manage") ? getAgents() : Promise.resolve(null)]);

  const merged = !!c.mergedIntoId;
  const currency = saleRows[0]?.currency ?? invoiceRows[0]?.currency ?? "USD";
  const liveSales = saleRows.filter((s) => s.status !== "cancelled");
  const salesCents = liveSales.reduce((a, s) => a + toCents(s.total), 0);
  const billable = invoiceRows.filter((i) => i.status !== "cancelled" && i.status !== "draft");
  const billedCents = billable.reduce((a, i) => a + toCents(i.total), 0);
  const collectedCents = billable.reduce((a, i) => a + toCents(i.amountPaid), 0);
  const outstandingCents = billable
    .filter((i) => ["pending", "partially_paid", "overdue"].includes(i.status))
    .reduce((a, i) => a + Math.max(0, toCents(i.total) - toCents(i.amountPaid)), 0);
  const completedCb = caseRows.filter((k) => k.caseType === "chargeback" && k.status === "completed");
  const cbCents = completedCb.reduce((a, k) => a + toCents(k.amount), 0);
  const overdue = invoiceRows.filter((i) => i.status === "overdue").length;

  const brandSummary = brandRels.map((r) => {
    const s = liveSales.filter((x) => x.brandId === r.brandId);
    const inv = billable.filter((x) => x.brandId === r.brandId);
    return {
      ...r,
      count: s.length,
      sales: s.reduce((a, x) => a + toCents(x.total), 0),
      collected: inv.reduce((a, x) => a + toCents(x.amountPaid), 0),
      last: s[0]?.saleDate ?? null,
    };
  });
  const showRefs = can(viewer, "transactions.view");
  const canEdit = can(viewer, "customers.edit") && !merged;
  const customerBrands = brandRels.map((r) => r.brandId);
  const agentOptions = agents
    ? agents.filter((a) => a.status === "active" && (customerBrands.length === 0 || a.brandIds.some((b) => customerBrands.includes(b)))).map((a) => ({ id: a.id, name: a.name }))
    : null;

  const overview = (
    <div className="grid gap-4 lg:grid-cols-3">
      <SectionCard
        className="lg:col-span-2"
        title="Customer details"
        actions={
          canEdit ? (
            <EditCustomerDialog
              customer={{ id: c.id, fullName: c.fullName, email: c.email, phone: c.phone, companyName: c.companyName, status: c.status, assignedAgentId: c.assignedAgentId }}
              agents={agentOptions}
            />
          ) : merged ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Lock className="size-3" aria-hidden /> Read-only (merged)
            </span>
          ) : undefined
        }
      >
        <DetailList
          items={[
            { label: "Email", value: c.email ? <a href={`mailto:${c.email}`} className="hover:underline">{c.email}</a> : "—" },
            { label: "Phone", value: c.phone ?? "—" },
            { label: "Company", value: c.companyName ?? "—" },
            { label: "Billing address", value: c.billingAddress ?? "Added when billed" },
            { label: "Assigned agent", value: agent ? agent.name : "Unassigned" },
            { label: "Created", value: fmtDateTime(c.createdAt) },
            { label: "Last activity", value: c.lastActivityAt ? fmtRelative(c.lastActivityAt, now) : "—" },
          ]}
        />
      </SectionCard>
      <SectionCard title="Sales by brand" description="Non-cancelled sales visible to you">
        {brandSummary.length === 0 ? (
          <EmptyState title="No brand relationships" />
        ) : (
          <ul className="divide-y">
            {brandSummary.map((b) => {
              const brand = brandMap.get(b.brandId);
              return (
                <li key={b.brandId} className="flex items-center gap-3 px-4 py-3">
                  {brand && <BrandMark brand={brand} size="md" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{brand?.name ?? b.brandId}</div>
                    <div className="text-xs text-muted-foreground">
                      {fmtNumber(b.count)} sale{b.count === 1 ? "" : "s"}
                      {b.last ? ` · last ${fmtDate(b.last)}` : ""}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium tabular">{formatCents(b.sales, currency)}</div>
                    <div className="text-xs text-muted-foreground tabular">{formatCents(b.collected, currency)} collected</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );

  const brandsTab = (
    <SectionCard title="Associated brands" description="Brands this customer has bought from. Relationships are created automatically with the first sale under a brand.">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Brand</TableHead>
            <TableHead>First seen</TableHead>
            <TableHead className="hidden sm:table-cell">Source system ID</TableHead>
            <TableHead className="pr-4 text-right">Sales</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {brandSummary.map((b) => (
            <TableRow key={b.brandId}>
              <TableCell className="pl-4">
                <BrandBadge brand={brandMap.get(b.brandId)} full />
              </TableCell>
              <TableCell>{fmtDate(b.firstSeenAt)}</TableCell>
              <TableCell className="hidden font-mono text-xs sm:table-cell">{b.sourceSystemId ?? <span className="text-muted-foreground">Created in CRM</span>}</TableCell>
              <TableCell className="pr-4 text-right tabular">{formatCents(b.sales, currency)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );

  const salesTab = (
    <SectionCard
      title="Sales"
      description={can(viewer, "sales.view_all") ? "All sales for this customer in your scope" : "Sales you closed for this customer"}
    >
      {saleRows.length === 0 ? (
        <EmptyState icon={ShoppingBag} title="No sales visible" />
      ) : (
        <div className="relative overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Sale</TableHead>
                <TableHead>Brand</TableHead>
                <TableHead className="hidden md:table-cell">Agent</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {saleRows.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="pl-4">
                    <Link href={`/sales/${s.id}`} className="font-mono text-xs font-medium hover:underline">
                      {s.id}
                    </Link>
                    <div className="text-xs text-muted-foreground">{fmtDate(s.saleDate)}</div>
                  </TableCell>
                  <TableCell>
                    <BrandBadge brand={brandMap.get(s.brandId)} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{s.agentName ?? "—"}</TableCell>
                  <TableCell className="text-right tabular">{formatMoney(s.total, s.currency)}</TableCell>
                  <TableCell className="pr-4">
                    <VocabBadge map={SALE_STATUS} value={s.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SectionCard>
  );

  const billingTab = can(viewer, "billing.view") ? (
    <>
      <SectionCard title="Invoices" description={overdue ? `${overdue} overdue` : "Billing records in your scope"}>
        {invoiceRows.length === 0 ? (
          <EmptyState icon={Receipt} title="No billing records visible" />
        ) : (
          <div className="relative overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Invoice</TableHead>
                  <TableHead>Brand</TableHead>
                  <TableHead className="hidden sm:table-cell">Due</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Paid</TableHead>
                  <TableHead className="pr-4">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoiceRows.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="pl-4">
                      <Link href={`/billing/${i.id}`} className="font-mono text-xs font-medium hover:underline">
                        {i.invoiceNumber}
                      </Link>
                      <div className="text-xs text-muted-foreground">{fmtDate(i.billingDate)}</div>
                    </TableCell>
                    <TableCell>
                      <BrandBadge brand={brandMap.get(i.brandId)} />
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">{fmtDate(i.dueDate)}</TableCell>
                    <TableCell className="text-right tabular">{formatMoney(i.total, i.currency)}</TableCell>
                    <TableCell className="hidden text-right tabular md:table-cell">{formatMoney(i.amountPaid, i.currency)}</TableCell>
                    <TableCell className="pr-4">
                      <VocabBadge map={INVOICE_STATUS} value={i.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
      <SectionCard
        title="Payments & transactions"
        description={showRefs ? "Ledger entries linked to this customer's invoices" : "Payment references are masked for your role"}
      >
        {paymentRows.length === 0 ? (
          <EmptyState title="No transactions recorded" />
        ) : (
          <div className="relative overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Transaction</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="hidden md:table-cell">Method</TableHead>
                  <TableHead className="hidden lg:table-cell">Reference</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="hidden pr-4 sm:table-cell">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paymentRows.map((t) => {
                  const sign = TRANSACTION_TYPE[t.type]?.sign ?? 1;
                  return (
                    <TableRow key={t.id}>
                      <TableCell className="pl-4">
                        <span className="font-mono text-xs">{t.id}</span>
                        <div className="text-xs text-muted-foreground">{fmtDate(t.occurredAt)}</div>
                      </TableCell>
                      <TableCell>
                        <VocabBadge map={TRANSACTION_TYPE} value={t.type} />
                      </TableCell>
                      <TableCell className="hidden text-sm md:table-cell">{t.method ? (PAYMENT_METHOD[t.method] ?? t.method) : "—"}</TableCell>
                      <TableCell className="hidden font-mono text-xs lg:table-cell">{showRefs ? (t.paymentReference ?? "—") : maskReference(t.paymentReference)}</TableCell>
                      <TableCell className={`text-right tabular ${sign < 0 ? "text-red-600 dark:text-red-400" : ""}`}>
                        {sign < 0 ? "−" : ""}
                        {formatMoney(t.amount, t.currency)}
                      </TableCell>
                      <TableCell className="hidden pr-4 sm:table-cell">
                        <VocabBadge map={TRANSACTION_STATUS} value={t.status} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </>
  ) : null;

  const casesTab = can(viewer, "chargebacks.view") ? (
    <SectionCard title="Recharge / chargeback history" description="Only completed chargebacks count towards chargeback totals. Intercompany recharges are internal and never customer chargebacks.">
      {caseRows.length === 0 ? (
        <EmptyState icon={RotateCcw} title="No recharge or chargeback cases" />
      ) : (
        <div className="relative overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Case</TableHead>
                <TableHead className="hidden lg:table-cell">Reason</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {caseRows.map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="pl-4">
                    <Link href={`/recharge/${k.id}`} className="font-mono text-xs font-medium hover:underline">
                      {k.id}
                    </Link>
                    <div className="text-xs text-muted-foreground">{fmtDate(k.requestDate)}</div>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs lg:table-cell">{k.reasonCode}</TableCell>
                  <TableCell className="text-right tabular">{formatMoney(k.amount, k.currency)}</TableCell>
                  <TableCell className="pr-4">
                    <VocabBadge map={CASE_STATUS} value={k.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SectionCard>
  ) : null;

  const activityTab = (
    <SectionCard title="Activity" description="Audit trail for this customer (latest 50 entries)">
      <Timeline
        entries={activity.map((a) => ({
          id: a.id,
          title: a.summary,
          actor: a.actor,
          at: a.createdAt,
          tone: a.action.includes("merged") ? "warning" : a.action.includes("chargeback") ? "danger" : a.action.includes("created") ? "success" : "default",
        }))}
      />
    </SectionCard>
  );

  const notesTab = (
    <SectionCard title="Internal notes" description="Never shared with the customer.">
      {!merged && <NoteForm customerId={c.id} allowFinance={can(viewer, "transactions.view")} />}
      {noteRows.length === 0 ? (
        <EmptyState icon={StickyNote} title="No notes yet" />
      ) : (
        <ul className="divide-y border-t">
          {noteRows.map((n) => (
            <li key={n.id} className="px-4 py-3">
              <p className="text-sm whitespace-pre-wrap">{n.body}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{n.author ?? "Unknown"}</span>·<time dateTime={n.createdAt.toISOString()}>{fmtDateTime(n.createdAt)}</time>
                {n.visibility === "finance" && <StatusBadge tone="violet" label="Admin only" />}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "All Customers", href: "/customers" }, { label: c.id }]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {c.fullName}
            <VocabBadge map={CUSTOMER_STATUS} value={c.status} />
          </span>
        }
        description={
          <>
            <span className="font-mono">{c.id}</span>
            {c.companyName ? ` · ${c.companyName}` : ""} · Assigned to {agent?.name ?? "nobody"}
          </>
        }
        meta={brandRels.map((r) => (
          <BrandBadge key={r.brandId} brand={brandMap.get(r.brandId)} full />
        ))}
        actions={
          !merged && can(viewer, "billing.create") ? (
            <Button asChild size="sm">
              <Link href={`/billing/new?customer=${c.id}`}>
                <Receipt /> New order
              </Link>
            </Button>
          ) : undefined
        }
      />

      {merged && (
        <div role="status" className="mb-4 flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <GitMerge className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <div>
              <p className="font-medium">This record was merged into {c.mergedIntoId}</p>
              <p className="text-muted-foreground">It is kept read-only for audit. Operational records now live on the surviving profile.</p>
            </div>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href={`/customers/${c.mergedIntoId}`}>
              Open surviving record <ArrowRight />
            </Link>
          </Button>
        </div>
      )}

      {!merged && dupes.length > 0 && (
        <div role="status" className="mb-4 flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <div>
              <p className="font-medium">Possible duplicate customer</p>
              <p className="text-muted-foreground">
                {dupes
                  .map((d) => `${d.customerAId === c.id ? d.customerBId : d.customerAId} (${d.matchReasons.join(", ")})`)
                  .join("; ")}{" "}
                — awaiting duplicate review.
              </p>
            </div>
          </div>
          {can(viewer, "customers.merge") && (
            <Button asChild size="sm" variant="outline">
              <Link href="/customers/duplicates">
                <GitMerge /> Review duplicates
              </Link>
            </Button>
          )}
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Recorded sales" value={formatCents(salesCents, currency)} sub={`${fmtNumber(liveSales.length)} non-cancelled`} definition="Sum of non-cancelled sales visible to you." />
        <KpiCard label="Billed" value={formatCents(billedCents, currency)} sub={`${fmtNumber(billable.length)} invoices`} definition="Issued invoices (excludes drafts and cancelled)." />
        <KpiCard label="Collected" value={formatCents(collectedCents, currency)} sub="Net of refunds" />
        <KpiCard
          label="Outstanding"
          value={formatCents(outstandingCents, currency)}
          sub={overdue ? `${overdue} overdue` : "Nothing overdue"}
          tone={overdue ? "warning" : "default"}
        />
        <KpiCard
          label="Chargebacks"
          value={formatCents(cbCents, currency)}
          sub={`${completedCb.length} completed`}
          tone={cbCents ? "danger" : "default"}
          definition="Completed chargeback cases only. Pending cases and intercompany recharges are excluded."
        />
      </div>

      <ProfileTabs
        defaultTab="overview"
        tabs={[
          { value: "overview", label: "Overview", content: overview },
          { value: "brands", label: "Associated Brands", count: brandRels.length, content: brandsTab },
          { value: "sales", label: "Sales", count: saleRows.length, content: salesTab },
          ...(billingTab ? [{ value: "billing", label: "Billing", count: invoiceRows.length, content: billingTab }] : []),
          ...(casesTab ? [{ value: "chargebacks", label: "Recharge / Chargebacks", count: caseRows.length, content: casesTab }] : []),
          { value: "activity", label: "Activity", content: activityTab },
          { value: "notes", label: "Internal Notes", count: noteRows.length, content: notesTab },
        ]}
      />
    </>
  );
}
