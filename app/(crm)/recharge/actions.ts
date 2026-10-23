"use server";

import { refresh } from "next/cache";
import { getDb } from "@/lib/db";
import { authorize, can, canAccessBrand } from "@/lib/auth/viewer";
import { BusinessRuleError, runAction } from "@/lib/actions";
import type { ActionResult } from "@/lib/action-result";
import { getOriginalTransaction, searchOriginalTransactions } from "@/lib/data/chargebacks";
import {
  canAssignEntity,
  createCase,
  defaultResponsible,
  eligibleResponsibleEntities,
  readPolicy,
  recordEvidence,
  transition,
  updateDraft,
  type CaseInput,
  type TransitionExtra,
} from "@/lib/services/chargebacks";
import type { WorkflowAction } from "@/lib/domain/chargeback-workflow";
import { maskReference } from "@/lib/mask";

export type OriginalTxnResult = {
  id: string;
  brandId: string;
  legalEntityId: string;
  customerId: string | null;
  customerName: string | null;
  invoiceId: string | null;
  invoiceNumber: string;
  invoiceStatus: string;
  amount: string;
  currency: string;
  paymentMethod: string | null;
  processor: string | null;
  paymentReference: string;
  occurredAt: string;
  originalCents: number;
  refundedCents: number;
  committedCents: number;
  remainingCents: number;
  activeCases: number;
};

/** Step 2: find the original transaction by txn id, invoice #, customer id/email or payment reference. */
export async function searchOriginalAction(query: string): Promise<ActionResult<OriginalTxnResult[]>> {
  return runAction(async () => {
    const viewer = await authorize("chargebacks.create");
    const rows = await searchOriginalTransactions(viewer, query.slice(0, 120));
    const showRef = can(viewer, "transactions.view");
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        brandId: r.brandId,
        legalEntityId: r.legalEntityId,
        customerId: r.customerId,
        customerName: r.customerName,
        invoiceId: r.invoiceId,
        invoiceNumber: r.invoiceNumber,
        invoiceStatus: r.invoiceStatus,
        amount: r.amount,
        currency: r.currency,
        paymentMethod: r.paymentMethod,
        processor: r.processor,
        paymentReference: showRef ? (r.paymentReference ?? "—") : maskReference(r.paymentReference),
        occurredAt: r.occurredAt.toISOString(),
        originalCents: r.balance.original,
        refundedCents: r.balance.refunded,
        committedCents: r.balance.committed,
        remainingCents: r.balance.remaining,
        activeCases: r.balance.activeCases,
      })),
    };
  });
}

export type EntityOptions = {
  options: { id: string; registeredName: string; internalCode: string; isDefault: boolean; isOriginal: boolean }[];
  defaultId: string;
  canAssign: boolean;
  policy: { allowPartial: boolean; allowMultiple: boolean; maxDaysAfterPayment: number };
};

/** Step 4: eligible responsible LLCs for this brand / case type / date, from the configured mapping. */
export async function entityOptionsAction(input: { brandId: string; caseType: "chargeback" | "intercompany_recharge"; originalTransactionId: string; requestDate: string }): Promise<ActionResult<EntityOptions>> {
  return runAction(async () => {
    const viewer = await authorize("chargebacks.create");
    if (!canAccessBrand(viewer, input.brandId)) throw new BusinessRuleError("You are not authorised for this brand.");
    const db = await getDb();
    const orig = await getOriginalTransaction(viewer, input.originalTransactionId, db);
    if (!orig) throw new BusinessRuleError("Original transaction not accessible.");
    const at = /^\d{4}-\d{2}-\d{2}$/.test(input.requestDate) ? new Date(`${input.requestDate}T12:00:00Z`) : new Date();
    const options = await eligibleResponsibleEntities(db, input.brandId, input.caseType, orig.legalEntityId, at);
    const policy = await readPolicy(db);
    return {
      ok: true,
      data: {
        options,
        defaultId: defaultResponsible(options, orig.legalEntityId, input.caseType),
        canAssign: canAssignEntity(viewer),
        policy: { allowPartial: policy.allowPartial, allowMultiple: policy.allowMultiple, maxDaysAfterPayment: policy.maxDaysAfterPayment },
      },
    };
  });
}

export async function createCaseAction(input: CaseInput, submit: boolean): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const viewer = await authorize("chargebacks.create");
    const db = await getDb();
    const id = await db.transaction((tx) => createCase(tx, viewer, input, submit));
    return { ok: true, data: { id }, message: submit ? `${id} submitted for review.` : `${id} saved as draft.` };
  });
}

export async function updateDraftAction(id: string, input: CaseInput): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("chargebacks.create");
    const db = await getDb();
    const res = await db.transaction((tx) => updateDraft(tx, viewer, id, input));
    refresh();
    return { ok: true, message: res.changed ? "Draft updated." : "No changes to save." };
  });
}

const ALLOWED: WorkflowAction[] = ["submit", "forward", "return", "reject", "approve", "start_processing", "complete", "fail", "cancel", "note"];

export async function transitionAction(id: string, action: WorkflowAction, note: string, extra: TransitionExtra = {}): Promise<ActionResult> {
  return runAction(async () => {
    if (!ALLOWED.includes(action)) throw new BusinessRuleError("Unknown action.");
    const viewer = await authorize("chargebacks.view");
    const db = await getDb();
    const res = await db.transaction((tx) => transition(tx, viewer, id, action, String(note ?? ""), extra));
    refresh();
    const msg: Partial<Record<WorkflowAction, string>> = {
      submit: "Submitted for review.",
      forward: "Forwarded for approval.",
      return: "Returned to the requester for correction.",
      reject: "Request rejected.",
      approve: "Request approved.",
      start_processing: "Processing started.",
      complete: res.ledgerId ? `Completed — ledger entry ${res.ledgerId} booked.` : "Completed.",
      fail: "Recorded as failed.",
      cancel: "Request cancelled.",
      note: "Note added.",
    };
    return { ok: true, message: msg[action] };
  });
}

export async function recordEvidenceAction(id: string, input: { externalProcessorReference?: string; evidenceSummary?: string }): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("chargebacks.view");
    const db = await getDb();
    await db.transaction((tx) => recordEvidence(tx, viewer, id, input));
    refresh();
    return { ok: true, message: "Evidence recorded." };
  });
}
