import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Check, CircleX } from "lucide-react";
import { PageHeader } from "@/components/crm/page-header";
import { DetailList, SectionCard } from "@/components/crm/section-card";
import { BrandBadge } from "@/components/crm/brand-badge";
import { StatusBadge, VocabBadge } from "@/components/crm/status-badge";
import { Timeline } from "@/components/crm/timeline";
import { AccessDenied } from "@/components/crm/access-denied";
import { AddCaseNote, CaseActions, EvidenceForm } from "@/components/recharge/case-actions";
import { Callout } from "@/components/recharge/case-wizard";
import { can, requireViewer } from "@/lib/auth/viewer";
import { getCaseDetail } from "@/lib/data/chargebacks";
import { getBrandMap } from "@/lib/data/reference";
import { availableActions, STAGES, TERMINAL, type CaseStatus } from "@/lib/domain/chargeback-workflow";
import { readPolicy } from "@/lib/services/chargebacks";
import { CASE_STATUS, INVOICE_STATUS, PAYMENT_METHOD, REASON_CODES } from "@/lib/domain/vocab";
import { formatCents, formatMoney, toCents } from "@/lib/money";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { maskReference } from "@/lib/mask";
import { cn } from "@/lib/utils";

export async function generateMetadata(props: PageProps<"/recharge/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  return { title: id };
}

const EVENT_LABEL: Record<string, string> = {
  created: "Request created",
  edited: "Draft edited",
  submitted: "Submitted for review",
  reviewed: "Reviewed and forwarded for approval",
  returned: "Returned for correction",
  approved: "Approved",
  rejected: "Rejected",
  processing_started: "Processing started",
  completed: "Completed",
  failed: "Processing failed",
  cancelled: "Cancelled",
  note: "Note",
  evidence_recorded: "External reference / evidence recorded",
};

export default async function CasePage(props: PageProps<"/recharge/[id]">) {
  const viewer = await requireViewer();
  if (!can(viewer, "chargebacks.view")) return <AccessDenied />;
  const { id } = await props.params;
  if (!/^RCB-\d{4}-\d{4,}$/.test(id)) notFound();
  const detail = await getCaseDetail(viewer, id);
  if (!detail) return <AccessDenied message="This case does not exist or is outside your brands or ownership scope." />;

  const { case: c, events, original, invoice, customer, ledger, balance, siblings } = detail;
  const [brandMap, policy] = await Promise.all([getBrandMap(), readPolicy()]);
  const actions = availableActions(viewer, c, policy);
  const reason = REASON_CODES.find((r) => r.code === c.reasonCode);
  const showRef = can(viewer, "transactions.view");
  const thisCents = toCents(c.amount);
  const status = c.status as CaseStatus;
  const terminalBad = ["rejected", "failed", "cancelled"].includes(status);
  const stageIndex = STAGES.findIndex((s) => s.status === status);
  const lastGood = terminalBad
    ? Math.max(...events.filter((e) => STAGES.some((s) => s.status === e.fromStatus)).map((e) => STAGES.findIndex((s) => s.status === e.fromStatus)), 0)
    : stageIndex;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="font-mono">{c.id}</span>
            <VocabBadge map={CASE_STATUS} value={c.status} />
          </span>
        }
        description={`Chargeback · ${formatMoney(c.amount, c.currency)} · agent ${invoice?.agentName ?? "—"} · requested ${fmtDate(c.requestDate)}`}
        breadcrumbs={[
          { label: "Recharge / Chargeback", href: "/recharge" },
          ...(can(viewer, "chargebacks.view_all") ? [{ label: "Register", href: "/recharge/register" }] : []),
          { label: c.id },
        ]}
        meta={
          <>
            <BrandBadge brand={brandMap.get(c.brandId)} full />
            {invoice?.agentName && <StatusBadge tone="info" label={`Agent: ${invoice.agentName}`} />}
            <StatusBadge tone="neutral" label={c.origin === "processor" ? "Origin: processor / bank" : "Origin: CRM"} />
          </>
        }
      />

      {/* Progress */}
      <ol className="mb-6 grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Workflow progress">
        {STAGES.map((s, i) => {
          const done = !terminalBad && (i < stageIndex || status === "completed");
          const current = !terminalBad && i === stageIndex && status !== "completed";
          const stoppedHere = terminalBad && i === lastGood;
          return (
            <li
              key={s.status}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs",
                done && "border-emerald-600/30 bg-emerald-500/5",
                current && "border-foreground font-medium",
                stoppedHere && "border-red-600/40 bg-red-500/5",
                !done && !current && !stoppedHere && "text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3.5 text-emerald-600" /> : stoppedHere ? <CircleX className="size-3.5 text-red-600" /> : <span className="tabular">{i + 1}</span>}
              {stoppedHere ? CASE_STATUS[status].label : s.label}
            </li>
          );
        })}
      </ol>

      {c.status === "draft" && events.some((e) => e.action === "returned") && (
        <div className="mb-4">
          <Callout tone="warning">
            Returned for correction: “{[...events].reverse().find((e) => e.action === "returned")?.note}”. Edit the draft and submit again.
          </Callout>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-6">
          <SectionCard title="Request details">
            <DetailList
              columns={3}
              items={[
                { label: "Chargeback / Recharge ID", value: <span className="font-mono">{c.id}</span> },
                { label: "Agent (took the order)", value: invoice?.agentName ?? "—" },
                { label: "Approval status", value: <VocabBadge map={CASE_STATUS} value={c.status} /> },
                { label: "Amount", value: <span className="font-semibold tabular">{formatMoney(c.amount, c.currency)}</span> },
                { label: "Currency", value: c.currency },
                { label: "Reason code", value: reason ? `${reason.code} — ${reason.label} (${reason.network})` : c.reasonCode },
                { label: "Request date", value: fmtDate(c.requestDate) },
                { label: "Requested by", value: events.find((e) => e.action === "created")?.actorName ?? c.requestedBy },
                { label: "External processor reference", value: c.externalProcessorReference ? <span className="font-mono text-xs">{c.externalProcessorReference}</span> : "—" },
                { label: "Reviewed", value: c.reviewedAt ? `${events.findLast((e) => e.action === "reviewed")?.actorName ?? ""} · ${fmtDate(c.reviewedAt)}` : "—" },
                { label: "Decision", value: c.decidedAt ? `${events.findLast((e) => ["approved", "rejected"].includes(e.action))?.actorName ?? ""} · ${fmtDate(c.decidedAt)}` : "—" },
                { label: "Completed", value: c.completedAt ? fmtDateTime(c.completedAt) : "—" },
              ]}
            />
            <div className="border-t p-4 text-sm">
              <p className="text-xs text-muted-foreground">Supporting notes</p>
              <p className="mt-1 whitespace-pre-wrap">{c.notes ?? "—"}</p>
              {c.evidenceSummary && (
                <>
                  <p className="mt-3 text-xs text-muted-foreground">Evidence</p>
                  <p className="mt-1 whitespace-pre-wrap">{c.evidenceSummary}</p>
                </>
              )}
              {c.outcomeNote && (
                <>
                  <p className="mt-3 text-xs text-muted-foreground">Outcome</p>
                  <p className="mt-1">{c.outcomeNote}</p>
                </>
              )}
            </div>
          </SectionCard>

          <SectionCard title="Original transaction & ownership" description="Facts from the original payment — immutable.">
            <DetailList
              columns={3}
              items={[
                { label: "Original customer", value: customer ? <Link className="hover:underline" href={`/customers/${customer.id}`}>{customer.fullName} <span className="font-mono text-xs text-muted-foreground">{customer.id}</span></Link> : c.customerId },
                { label: "Original brand", value: <BrandBadge brand={brandMap.get(original?.brandId ?? c.brandId)} full /> },
                { label: "Original invoice", value: invoice ? <span className="flex flex-wrap items-center gap-2"><Link className="hover:underline" href={`/billing/${invoice.id}`}>{invoice.invoiceNumber}</Link><VocabBadge map={INVOICE_STATUS} value={invoice.status} /></span> : "—" },
                { label: "Original transaction", value: <span className="font-mono text-xs">{c.originalTransactionId}</span> },
                { label: "Original amount", value: original ? <span className="tabular">{formatMoney(original.amount, original.currency)}</span> : "—" },
                { label: "Payment reference", value: <span className="font-mono text-xs">{showRef ? (original?.paymentReference ?? "—") : maskReference(original?.paymentReference)}</span> },
                { label: "Payment method", value: original ? `${PAYMENT_METHOD[original.paymentMethod ?? ""] ?? "—"} · ${original.processor ?? ""}` : "—" },
                { label: "Paid on", value: original ? fmtDate(original.occurredAt) : "—" },
                { label: "Current transaction status", value: original ? <StatusBadge tone={original.status === "succeeded" ? "success" : "neutral"} label={original.status} /> : "—" },
              ]}
            />
          </SectionCard>

          <SectionCard title="Amount validation" description="Cumulative amounts on the original transaction (same case type).">
            <dl className="grid gap-px overflow-hidden bg-border text-sm sm:grid-cols-5">
              {[
                ["Original", balance.original],
                ["Refunded", balance.refunded],
                ["Other active cases", balance.committed],
                ["This case", thisCents],
                ["Still chargeable", Math.max(0, balance.remaining - (["draft", "pending_review", "pending_approval", "approved", "processing", "completed"].includes(c.status) ? thisCents : 0))],
              ].map(([k, v]) => (
                <div key={k as string} className="bg-card p-3">
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd className="mt-0.5 font-medium tabular">{formatCents(v as number, c.currency)}</dd>
                </div>
              ))}
            </dl>
            {siblings.length > 0 && (
              <ul className="divide-y border-t text-sm">
                {siblings.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-2">
                    <Link href={`/recharge/${s.id}`} className="font-mono text-xs hover:underline">
                      {s.id}
                    </Link>
                    <span className="flex items-center gap-2">
                      <VocabBadge map={CASE_STATUS} value={s.status} />
                      <span className="tabular">{formatMoney(s.amount, c.currency)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {ledger && (
            <SectionCard title="Ledger entry" description="Booked when the case completed. Append-only — corrections require a reversal entry.">
              <DetailList
                columns={3}
                items={[
                  { label: "Transaction", value: <span className="font-mono text-xs">{ledger.id}</span> },
                  { label: "Type", value: "Chargeback (debit)" },
                  { label: "Amount", value: <span className="tabular">{formatMoney(ledger.amount, ledger.currency)}</span> },
                  { label: "Occurred", value: fmtDateTime(ledger.occurredAt) },
                ]}
              />
            </SectionCard>
          )}
        </div>

        <div className="space-y-6">
          <SectionCard title="Workflow actions" description={TERMINAL.includes(status) ? "This case is closed." : undefined}>
            <div className="p-4">
              <CaseActions
                caseId={c.id}
                today={format(new Date(), "yyyy-MM-dd")}
                actions={actions.filter((a) => a.action !== "note").map(({ action, label, allowed, reason, noteRequired, description, tone }) => ({ action, label, allowed, reason, noteRequired, description, tone }))}
              />
              {policy.requireIndependentApproval && (
                <p className="mt-3 text-xs text-muted-foreground">Policy: requesters cannot review or approve their own requests.</p>
              )}
            </div>
          </SectionCard>

          {!TERMINAL.includes(status) && (can(viewer, "chargebacks.review") || can(viewer, "chargebacks.process")) && (
            <SectionCard title="External case & evidence" description="For disputes originating at the processor or issuing bank.">
              <div className="p-4">
                <EvidenceForm caseId={c.id} externalRef={c.externalProcessorReference ?? ""} evidence={c.evidenceSummary ?? ""} />
              </div>
            </SectionCard>
          )}

          <SectionCard title="Audit trail" description="Who did what, and when. Append-only.">
            <Timeline
              entries={events.map((e) => ({
                id: e.id,
                title: (
                  <span>
                    <span className="font-medium">{EVENT_LABEL[e.action] ?? e.action}</span>
                    {e.fromStatus && e.fromStatus !== e.toStatus && (
                      <span className="text-muted-foreground">
                        {" "}
                        · {CASE_STATUS[e.fromStatus]?.label} → {CASE_STATUS[e.toStatus]?.label}
                      </span>
                    )}
                  </span>
                ),
                body: (
                  <>
                    {e.note && <span className="block whitespace-pre-wrap">“{e.note}”</span>}
                    {e.changes && e.action === "edited" && (
                      <span className="block text-xs">Changed: {Object.keys(e.changes as object).join(", ")}</span>
                    )}
                  </>
                ),
                actor: e.actorName,
                at: e.createdAt,
                tone: ["approved", "completed"].includes(e.action) ? "success" : ["rejected", "failed", "cancelled"].includes(e.action) ? "danger" : e.action === "returned" ? "warning" : "default",
              }))}
            />
            {actions.find((a) => a.action === "note")?.allowed && (
              <div className="border-t p-4">
                <AddCaseNote caseId={c.id} />
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </>
  );
}
