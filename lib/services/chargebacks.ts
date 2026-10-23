import "server-only";
import { z } from "zod";
import { getDb, type InsertOf } from "@/lib/db";
import { ids } from "@/lib/db/query";
import { nextCaseId, nextId, nextSequence } from "@/lib/db/ids";
import { BusinessRuleError } from "@/lib/actions";
import { logActivity, notify } from "@/lib/audit";
import { can, canAccessBrand, canAccessEntity, canTransactInBrand, type Viewer } from "@/lib/auth/viewer";
import { chargeableBalance, getOriginalTransaction } from "@/lib/data/chargebacks";
import { evaluate, type CaseStatus, type WorkflowAction, type WorkflowPolicy } from "@/lib/domain/chargeback-workflow";
import { REASON_CODES } from "@/lib/domain/vocab";
import { fromCents, toCents } from "@/lib/money";
import { moneyString } from "@/lib/validation";
import type { Permission } from "@/lib/domain/permissions";

/* ---------------------------------------------------------------- policy */

export type ChargebackPolicy = WorkflowPolicy & { allowPartial: boolean; allowMultiple: boolean; maxDaysAfterPayment: number };

export async function readPolicy(): Promise<ChargebackPolicy> {
  const C = await getDb();
  const rows = await C.systemSettings.find({ key: /^chargeback\./ }).toArray();
  const get = <T,>(key: string, fallback: T): T => {
    const v = rows.find((r) => r.key === key)?.value;
    return v === undefined || v === null ? fallback : (v as T);
  };
  return {
    requireIndependentReview: get("chargeback.require_independent_review", true),
    requireIndependentApproval: get("chargeback.require_independent_approval", true),
    allowPartial: get("chargeback.allow_partial", true),
    allowMultiple: get("chargeback.allow_multiple", true),
    maxDaysAfterPayment: Number(get("chargeback.max_days_after_payment", 540)),
  };
}

/* --------------------------------------------------- legal entity rules */

type CaseType = "chargeback" | "intercompany_recharge";

/**
 * Entities eligible to be the *responsible* LLC for a case, from the
 * configurable brand→LLC mapping (scope chargeback|all, effective on the
 * request date, entity active and permitted to book this type).
 */
export async function eligibleResponsibleEntities(brandId: string, caseType: CaseType, originalEntityId: string, at: Date) {
  const C = await getDb();
  const day = at.toISOString().slice(0, 10);
  const requiredType = caseType === "chargeback" ? "chargeback" : "intercompany_recharge";
  const maps = await C.brandLegalEntities
    .find({ brandId, scope: { $in: ["chargeback", "all"] }, effectiveFrom: { $lte: day }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: day } }] })
    .toArray();
  const entities = await C.legalEntities.find({ id: { $in: ids([...maps.map((m) => m.legalEntityId), originalEntityId]) } }).toArray();
  const asRow = (e: (typeof entities)[number]) => ({
    id: e.id,
    registeredName: e.registeredName,
    internalCode: e.internalCode,
    status: e.status,
    permitted: e.permittedTransactionTypes,
  });
  const mapped = maps.flatMap((m) => {
    const e = entities.find((x) => x.id === m.legalEntityId);
    return e ? [{ ...asRow(e), isDefault: m.isDefault }] : [];
  });
  const origDoc = entities.find((e) => e.id === originalEntityId);
  const orig = origDoc ? asRow(origDoc) : undefined;

  const byId = new Map<string, { id: string; registeredName: string; internalCode: string; isDefault: boolean; isOriginal: boolean }>();
  const ok = (e: { status: string; permitted: string[] }) => e.status === "active" && e.permitted.includes(requiredType);
  if (orig && ok(orig) && caseType === "chargeback") byId.set(orig.id, { ...orig, isDefault: false, isOriginal: true });
  for (const m of mapped) {
    if (!ok(m)) continue;
    if (caseType === "intercompany_recharge" && m.id === originalEntityId) continue;
    const prev = byId.get(m.id);
    byId.set(m.id, { id: m.id, registeredName: m.registeredName, internalCode: m.internalCode, isDefault: m.isDefault || !!prev?.isDefault, isOriginal: m.id === originalEntityId });
  }
  return [...byId.values()].sort((a, b) => Number(b.isOriginal) - Number(a.isOriginal) || Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id));
}

/** Choosing an LLC other than the original one is a controlled, finance-level decision. */
export function canAssignEntity(viewer: Viewer) {
  return can(viewer, "billing.assign_entity") || can(viewer, "chargebacks.approve");
}

/* ------------------------------------------------------------- validation */

const reasonCodes = REASON_CODES.map((r) => r.code);

export const caseInputSchema = z
  .object({
    caseType: z.enum(["chargeback", "intercompany_recharge"]),
    brandId: z.string().min(1, "Select a brand."),
    originalTransactionId: z.string().min(1, "Select the original transaction."),
    responsibleLegalEntityId: z.string().min(1, "Select the responsible legal entity."),
    amount: moneyString,
    currency: z.string().regex(/^[A-Z]{3}$/),
    reasonCode: z.string().refine((v) => reasonCodes.includes(v), "Select a valid reason code."),
    notes: z.string().trim().min(5, "Add supporting notes (min. 5 characters).").max(3000),
    requestDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the request date."),
    origin: z.enum(["crm", "processor"]),
    externalProcessorReference: z
      .string()
      .trim()
      .max(80)
      .regex(/^[A-Za-z0-9_\-.:]*$/, "Use letters, numbers and - _ . : only.")
      .optional()
      .transform((v) => (v ? v : undefined)),
    evidenceSummary: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .transform((v) => (v ? v : undefined)),
  })
  .superRefine((v, ctx) => {
    if (v.origin === "processor" && !v.externalProcessorReference)
      ctx.addIssue({ code: "custom", path: ["externalProcessorReference"], message: "A processor-originated case needs the external case reference." });
    const internal = REASON_CODES.find((r) => r.code === v.reasonCode)?.network === "Internal";
    if (v.caseType === "intercompany_recharge" && !internal)
      ctx.addIssue({ code: "custom", path: ["reasonCode"], message: "Intercompany recharges use an internal (IC-) reason code." });
    if (v.caseType === "chargeback" && internal)
      ctx.addIssue({ code: "custom", path: ["reasonCode"], message: "Internal reason codes are only for intercompany recharges." });
  });
export type CaseInput = z.input<typeof caseInputSchema>;

/** Validates a case against the original payment and configured business rules. */
async function validateAgainstOriginal(viewer: Viewer, input: z.output<typeof caseInputSchema>, policy: ChargebackPolicy, excludeCaseId?: string, previousResponsible?: string) {
  if (!canTransactInBrand(viewer, input.brandId)) throw new BusinessRuleError("This brand is inactive or you are not authorised for it.", { brandId: ["Select an active brand you are assigned to."] });
  const orig = await getOriginalTransaction(viewer, input.originalTransactionId);
  if (!orig) throw new BusinessRuleError("Original transaction not found or not accessible to you.", { originalTransactionId: ["Not found in your scope."] });
  if (orig.status !== "succeeded") throw new BusinessRuleError("Only succeeded payments can be charged back.");
  if (orig.brandId !== input.brandId)
    throw new BusinessRuleError(`This transaction belongs to brand ${orig.brandId}. Switch the selected brand to raise a case for it.`, { brandId: ["Brand does not match the original transaction."] });
  if (input.currency !== orig.currency)
    throw new BusinessRuleError(`Currency must match the original transaction (${orig.currency}).`, { currency: [`Must be ${orig.currency}.`] });

  const requestDate = new Date(`${input.requestDate}T12:00:00Z`);
  if (requestDate.getTime() > Date.now() + 86_400_000) throw new BusinessRuleError("Request date cannot be in the future.", { requestDate: ["Cannot be in the future."] });
  if (requestDate.getTime() < orig.occurredAt.getTime() - 86_400_000)
    throw new BusinessRuleError("Request date is before the original payment.", { requestDate: ["Before the original payment."] });
  const ageDays = (requestDate.getTime() - orig.occurredAt.getTime()) / 86_400_000;
  if (input.caseType === "chargeback" && ageDays > policy.maxDaysAfterPayment)
    throw new BusinessRuleError(`The original payment is ${Math.floor(ageDays)} days old; policy allows ${policy.maxDaysAfterPayment} days.`);

  if (input.caseType === "intercompany_recharge" && !(can(viewer, "transactions.view") && canAssignEntity(viewer)))
    throw new BusinessRuleError("Intercompany recharges can only be raised by a Super Admin.");

  const eligible = await eligibleResponsibleEntities(input.brandId, input.caseType, orig.legalEntityId, requestDate);
  const chosen = eligible.find((e) => e.id === input.responsibleLegalEntityId);
  if (!chosen)
    throw new BusinessRuleError("The selected legal entity is not configured to handle this type of case for this brand.", {
      responsibleLegalEntityId: ["Not an eligible entity for this brand / case type."],
    });
  const changingEntity = input.responsibleLegalEntityId !== (previousResponsible ?? defaultResponsible(eligible, orig.legalEntityId, input.caseType));
  if (changingEntity && input.responsibleLegalEntityId !== orig.legalEntityId && !canAssignEntity(viewer))
    throw new BusinessRuleError("Only a Super Admin can assign a different responsible legal entity.", { responsibleLegalEntityId: ["Requires entity assignment permission."] });
  if (!canAccessEntity(viewer, input.responsibleLegalEntityId) && !canAccessEntity(viewer, orig.legalEntityId))
    throw new BusinessRuleError("You do not have access to these legal entities.");

  // Serialise concurrent requests on the same payment (write-conflict lock), then check the cap.
  await lockOriginal(orig.id);
  const balance = (await chargeableBalance(orig.id, input.caseType, excludeCaseId))!;
  const amount = toCents(input.amount);
  if (amount <= 0) throw new BusinessRuleError("Amount must be greater than zero.", { amount: ["Must be greater than zero."] });
  if (!policy.allowMultiple && balance.activeCases > 0)
    throw new BusinessRuleError("Policy allows only one active case per original transaction, and one already exists.");
  if (amount > balance.remaining)
    throw new BusinessRuleError(
      `Amount exceeds the chargeable balance of ${fromCents(balance.remaining)} ${orig.currency} (original ${fromCents(balance.original)} − refunds ${fromCents(balance.refunded)} − other active cases ${fromCents(balance.committed)}).`,
      { amount: [`Maximum ${fromCents(balance.remaining)} ${orig.currency}.`] },
    );
  if (!policy.allowPartial && amount !== balance.remaining)
    throw new BusinessRuleError("Policy does not allow partial chargebacks; the amount must equal the full chargeable balance.", { amount: ["Partial amounts are disabled."] });
  return { orig, requestDate, amount, balance };
}

export function defaultResponsible(eligible: { id: string; isDefault: boolean; isOriginal: boolean }[], originalEntityId: string, caseType: CaseType) {
  if (caseType === "chargeback" && eligible.some((e) => e.id === originalEntityId)) return originalEntityId;
  return (eligible.find((e) => e.isDefault) ?? eligible[0])?.id ?? originalEntityId;
}

/* ----------------------------------------------------------- recipients */

async function usersWithPermission(perm: Permission, brandId: string, exclude: string[] = []) {
  const C = await getDb();
  const roleIds = await C.rolePermissions.distinct("roleId", { permissionKey: perm });
  const withRole = await C.userRoles.distinct("userId", { roleId: { $in: ids(roleIds) } });
  const withBrand = await C.userBrandAccess.distinct("userId", { brandId, userId: { $in: ids(withRole) } });
  return C.users.distinct("id", { id: { $in: ids(withBrand), $nin: exclude }, status: "active" });
}

/** Restrict finance recipients to those who can see one of the case's entities. */
async function filterByEntityAccess(userIds: string[], entityIds: string[]) {
  if (!userIds.length) return [];
  const C = await getDb();
  const allRoles = await C.rolePermissions.distinct("roleId", { permissionKey: "entities.all_access" });
  const allAccess = await C.userRoles.distinct("userId", { userId: { $in: userIds }, roleId: { $in: ids(allRoles) } });
  const scoped = await C.userLegalEntityAccess.distinct("userId", { userId: { $in: userIds }, legalEntityId: { $in: ids(entityIds) } });
  const ok = new Set([...allAccess, ...scoped]);
  return userIds.filter((u) => ok.has(u));
}

/**
 * Concurrency guard for the chargeable balance: every transaction that checks
 * or consumes the balance of a payment first writes the same lock document, so
 * concurrent ones conflict and are retried (and then see each other's cases).
 */
async function lockOriginal(originalTxnId: string) {
  await nextSequence(`lock:chargeback:${originalTxnId}`);
}

/* ----------------------------------------------------------- operations */

export async function createCase(viewer: Viewer, raw: CaseInput, submit: boolean) {
  if (!can(viewer, "chargebacks.create")) throw new BusinessRuleError("You do not have permission to raise recharge / chargeback requests.");
  const input = caseInputSchema.parse(raw);
  const C = await getDb();
  const policy = await readPolicy();
  const { orig, requestDate, amount } = await validateAgainstOriginal(viewer, input, policy);

  const id = await nextCaseId(requestDate);
  const now = new Date();
  await C.chargebackCases.insertOne({
    id,
    caseType: input.caseType,
    origin: input.origin,
    brandId: input.brandId,
    customerId: orig.customerId!,
    invoiceId: orig.invoiceId!,
    originalTransactionId: orig.id,
    originalLegalEntityId: orig.legalEntityId,
    responsibleLegalEntityId: input.responsibleLegalEntityId,
    amount: fromCents(amount),
    currency: input.currency,
    reasonCode: input.reasonCode,
    notes: input.notes,
    requestDate,
    requestedBy: viewer.id,
    status: "draft",
    externalProcessorReference: input.externalProcessorReference ?? null,
    evidenceSummary: input.evidenceSummary ?? null,
    createdAt: now,
    updatedAt: now,
  });
  await C.chargebackEvents.insertOne({
    caseId: id,
    action: "created",
    toStatus: "draft",
    actorId: viewer.id,
    note: input.origin === "processor" ? `Recorded from processor case ${input.externalProcessorReference}` : null,
    changes: {
      amount: fromCents(amount),
      originalLegalEntityId: orig.legalEntityId,
      responsibleLegalEntityId: input.responsibleLegalEntityId,
    },
  });
  await logActivity({
    actorId: viewer.id,
    action: "chargeback.created",
    entityType: "chargeback",
    entityId: id,
    brandId: input.brandId,
    legalEntityId: input.responsibleLegalEntityId,
    summary: `${input.caseType === "chargeback" ? "Recharge / chargeback" : "Intercompany recharge"} ${id} opened for ${fromCents(amount)} ${input.currency} against ${orig.id}`,
    metadata: {
      customerId: orig.customerId,
      invoiceId: orig.invoiceId,
      originalTransactionId: orig.id,
      originalLegalEntityId: orig.legalEntityId,
      responsibleLegalEntityId: input.responsibleLegalEntityId,
      entityOverride: input.responsibleLegalEntityId !== orig.legalEntityId,
    },
  });
  if (submit) await transition(viewer, id, "submit", "");
  return id;
}

export async function updateDraft(viewer: Viewer, id: string, raw: CaseInput) {
  const C = await getDb();
  const c = await C.chargebackCases.findOne({ id });
  if (!c) throw new BusinessRuleError("Case not found.");
  const policy = await readPolicy();
  const check = evaluate("edit", viewer, c, policy);
  if (!check.allowed) throw new BusinessRuleError(check.reason!);
  const input = caseInputSchema.parse(raw);
  if (input.originalTransactionId !== c.originalTransactionId || input.brandId !== c.brandId || input.caseType !== c.caseType)
    throw new BusinessRuleError("Brand, case type and original transaction cannot change — cancel and raise a new request instead.");
  const { amount, requestDate } = await validateAgainstOriginal(viewer, input, policy, id, c.responsibleLegalEntityId);

  const next = {
    amount: fromCents(amount),
    reasonCode: input.reasonCode,
    notes: input.notes,
    requestDate,
    origin: input.origin,
    responsibleLegalEntityId: input.responsibleLegalEntityId,
    externalProcessorReference: input.externalProcessorReference ?? null,
    evidenceSummary: input.evidenceSummary ?? null,
  };
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(next)) {
    const before = c[k as keyof typeof c];
    const a = before instanceof Date ? before.toISOString().slice(0, 10) : before;
    const b = v instanceof Date ? v.toISOString().slice(0, 10) : v;
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) changes[k] = { from: a, to: b };
  }
  if (!Object.keys(changes).length) return { changed: false };
  await C.chargebackCases.updateOne({ id }, { $set: { ...next, updatedAt: new Date() } });
  await C.chargebackEvents.insertOne({ caseId: id, action: "edited", fromStatus: "draft", toStatus: "draft", actorId: viewer.id, changes });
  await logActivity({
    actorId: viewer.id,
    action: "chargeback.updated",
    entityType: "chargeback",
    entityId: id,
    brandId: c.brandId,
    legalEntityId: next.responsibleLegalEntityId,
    summary: `Draft updated: ${Object.keys(changes).join(", ")}`,
    metadata: { changes, customerId: c.customerId },
  });
  return { changed: true };
}

export type TransitionExtra = { processorReference?: string; outcomeDate?: string };

export async function transition(viewer: Viewer, id: string, action: WorkflowAction, note: string, extra: TransitionExtra = {}) {
  const C = await getDb();
  // Write first, so two approvers acting on the same case concurrently conflict
  // (one transaction is retried and then sees the other's change).
  const touched = await C.chargebackCases.updateOne({ id }, { $set: { updatedAt: new Date() } });
  if (!touched.matchedCount) throw new BusinessRuleError("Case not found.");
  const c = (await C.chargebackCases.findOne({ id }))!;
  if (!canAccessBrand(viewer, c.brandId)) throw new BusinessRuleError("You are not authorised for this brand.");
  if (!canAccessEntity(viewer, c.originalLegalEntityId) && !canAccessEntity(viewer, c.responsibleLegalEntityId))
    throw new BusinessRuleError("You do not have access to this case's legal entities.");
  if (!can(viewer, "chargebacks.view_all") && c.requestedBy !== viewer.id) throw new BusinessRuleError("Case not accessible.");

  const policy = await readPolicy();
  const check = evaluate(action, viewer, c, policy);
  if (!check.allowed) throw new BusinessRuleError(check.reason ?? "Action not allowed.");
  const trimmed = note.trim().slice(0, 2000);
  if (check.noteRequired && trimmed.length < 3) throw new BusinessRuleError("Please add a note explaining this decision.");

  const now = new Date();
  const from = c.status as CaseStatus;
  const to = (check.to ?? from) as CaseStatus;
  const patch: Partial<InsertOf<"chargebackCases">> = { status: to, updatedAt: now };
  let ledgerId: string | null = null;

  switch (action) {
    case "submit": {
      // Re-validate the cumulative cap at submission — other cases may have been raised meanwhile.
      await lockOriginal(c.originalTransactionId);
      const bal = (await chargeableBalance(c.originalTransactionId, c.caseType, c.id))!;
      if (toCents(c.amount) > bal.remaining)
        throw new BusinessRuleError(`Amount now exceeds the chargeable balance (${fromCents(bal.remaining)} ${c.currency}). Edit the draft first.`);
      break;
    }
    case "forward":
      Object.assign(patch, { reviewedBy: viewer.id, reviewedAt: now });
      break;
    case "approve":
      Object.assign(patch, { decidedBy: viewer.id, decidedAt: now });
      break;
    case "reject":
      Object.assign(patch, from === "pending_review" ? { reviewedBy: viewer.id, reviewedAt: now } : {}, {
        decidedBy: viewer.id,
        decidedAt: now,
        outcomeNote: trimmed,
      });
      break;
    case "return":
      Object.assign(patch, { reviewedBy: null, reviewedAt: null, decidedBy: null, decidedAt: null });
      break;
    case "start_processing":
      Object.assign(patch, { processedBy: viewer.id });
      break;
    case "fail":
      Object.assign(patch, { processedBy: viewer.id, completedAt: now, outcomeNote: trimmed });
      break;
    case "cancel":
      Object.assign(patch, { outcomeNote: trimmed });
      break;
    case "complete": {
      const orig = await C.transactions.findOne({ id: c.originalTransactionId });
      // Cap is re-checked against *completed + other active* cases at the moment money moves.
      await lockOriginal(c.originalTransactionId);
      const bal = (await chargeableBalance(c.originalTransactionId, c.caseType, c.id))!;
      if (toCents(c.amount) > bal.remaining) throw new BusinessRuleError("Completing this case would exceed the original transaction amount.");
      const ref = extra.processorReference?.trim() || null;
      if (ref && !/^[A-Za-z0-9_\-.:]{4,80}$/.test(ref)) throw new BusinessRuleError("Processor reference has an invalid format.");
      if (ref) {
        const dupe = await C.transactions.findOne({ paymentReference: ref }, { projection: { id: 1 } });
        if (dupe) throw new BusinessRuleError(`Processor reference already recorded on ${dupe.id}.`);
      }
      const occurredAt = extra.outcomeDate ? new Date(`${extra.outcomeDate}T12:00:00Z`) : now;
      if (occurredAt.getTime() > now.getTime() + 86_400_000) throw new BusinessRuleError("Outcome date cannot be in the future.");
      ledgerId = await nextId("transaction");
      if (c.caseType === "chargeback") {
        // Booked against the ORIGINAL entity. A different responsible entity handles the case but does
        // not silently absorb the loss — that needs a separate, approved intercompany recharge.
        await C.transactions.insertOne({
          id: ledgerId,
          type: "chargeback",
          status: "succeeded",
          brandId: c.brandId,
          legalEntityId: c.originalLegalEntityId,
          customerId: c.customerId,
          invoiceId: c.invoiceId,
          relatedTransactionId: c.originalTransactionId,
          chargebackCaseId: c.id,
          amount: c.amount,
          currency: c.currency,
          processor: orig?.processor ?? null,
          paymentReference: ref ?? `cb_${c.id.toLowerCase()}`,
          occurredAt,
          notes:
            c.responsibleLegalEntityId !== c.originalLegalEntityId
              ? `Handled by ${c.responsibleLegalEntityId}; booked against original entity ${c.originalLegalEntityId}.`
              : null,
          createdBy: viewer.id,
        });
      } else {
        await C.transactions.insertOne({
          id: ledgerId,
          type: "intercompany_recharge",
          status: "succeeded",
          brandId: c.brandId,
          legalEntityId: c.responsibleLegalEntityId,
          counterpartyEntityId: c.originalLegalEntityId,
          relatedTransactionId: c.originalTransactionId,
          chargebackCaseId: c.id,
          amount: c.amount,
          currency: c.currency,
          paymentReference: ref,
          occurredAt,
          notes: "Internal transfer between legal entities — excluded from sales and revenue.",
          createdBy: viewer.id,
        });
      }
      Object.assign(patch, { processedBy: viewer.id, completedAt: occurredAt, ledgerTransactionId: ledgerId, outcomeNote: trimmed || null });
      if (ref && !c.externalProcessorReference) patch.externalProcessorReference = ref;
      break;
    }
  }

  if (check.to) await C.chargebackCases.updateOne({ id }, { $set: patch });
  else await C.chargebackCases.updateOne({ id }, { $set: { updatedAt: now } });
  await C.chargebackEvents.insertOne({
    caseId: id,
    action: action === "note" ? "note" : action === "forward" ? "reviewed" : action === "complete" ? "completed" : action === "fail" ? "failed" : action === "approve" ? "approved" : action === "reject" ? "rejected" : action === "cancel" ? "cancelled" : action === "return" ? "returned" : action === "submit" ? "submitted" : action === "start_processing" ? "processing_started" : action,
    fromStatus: from,
    toStatus: to,
    actorId: viewer.id,
    note: trimmed || null,
    changes: ledgerId ? { ledgerTransactionId: ledgerId } : null,
  });
  await logActivity({
    actorId: viewer.id,
    action: action === "note" ? "chargeback.note" : `chargeback.${to === from ? action : to}`,
    entityType: "chargeback",
    entityId: id,
    brandId: c.brandId,
    legalEntityId: c.responsibleLegalEntityId,
    summary: action === "note" ? `Note added to ${id}` : `${id}: ${from.replace(/_/g, " ")} → ${to.replace(/_/g, " ")}${trimmed ? ` — ${trimmed.slice(0, 120)}` : ""}`,
    metadata: {
      customerId: c.customerId,
      fromStatus: from,
      toStatus: to,
      originalLegalEntityId: c.originalLegalEntityId,
      responsibleLegalEntityId: c.responsibleLegalEntityId,
      ledgerTransactionId: ledgerId,
    },
  });

  // Notifications
  const href = `/recharge/${id}`;
  const label = c.caseType === "chargeback" ? "recharge / chargeback" : "intercompany recharge";
  if (action === "submit") {
    const reviewers = await filterByEntityAccess(await usersWithPermission("chargebacks.review", c.brandId, [viewer.id]), [c.originalLegalEntityId, c.responsibleLegalEntityId]);
    await notify(reviewers, { kind: "approval_needed", title: `Review requested: ${id}`, body: `${c.amount} ${c.currency} ${label} awaiting review.`, href });
  } else if (action === "forward") {
    const approvers = await filterByEntityAccess(
      await usersWithPermission("chargebacks.approve", c.brandId, policy.requireIndependentApproval ? [viewer.id, c.requestedBy] : [viewer.id]),
      [c.originalLegalEntityId, c.responsibleLegalEntityId],
    );
    await notify(approvers, { kind: "approval_needed", title: `Approval needed: ${id}`, body: `${c.amount} ${c.currency} ${label} reviewed and awaiting approval.`, href });
  }
  if (["forward", "return", "reject", "approve", "complete", "fail", "cancel"].includes(action) && c.requestedBy !== viewer.id) {
    await notify([c.requestedBy], {
      kind: "case_update",
      title: `${id} ${to.replace(/_/g, " ")}`,
      body: trimmed ? `Note: ${trimmed.slice(0, 160)}` : `Your ${label} request moved to ${to.replace(/_/g, " ")}.`,
      href,
    });
  }
  return { from, to, ledgerId };
}

/** Record or update an external processor reference / evidence while the case is open. */
export async function recordEvidence(viewer: Viewer, id: string, input: { externalProcessorReference?: string; evidenceSummary?: string }) {
  if (!(can(viewer, "chargebacks.review") || can(viewer, "chargebacks.process"))) throw new BusinessRuleError("Requires review or processing permission.");
  const C = await getDb();
  const c = await C.chargebackCases.findOne({ id });
  if (!c) throw new BusinessRuleError("Case not found.");
  if (!canAccessBrand(viewer, c.brandId) || (!canAccessEntity(viewer, c.originalLegalEntityId) && !canAccessEntity(viewer, c.responsibleLegalEntityId)))
    throw new BusinessRuleError("Case not accessible.");
  if (["completed", "rejected", "cancelled", "failed"].includes(c.status)) throw new BusinessRuleError("Closed cases cannot be changed.");
  const ref = input.externalProcessorReference?.trim() || null;
  if (ref && !/^[A-Za-z0-9_\-.:]{4,80}$/.test(ref)) throw new BusinessRuleError("External reference has an invalid format.");
  const ev = input.evidenceSummary?.trim().slice(0, 2000) || null;
  await C.chargebackCases.updateOne(
    { id, status: { $ne: "completed" } },
    { $set: { externalProcessorReference: ref ?? c.externalProcessorReference, evidenceSummary: ev ?? c.evidenceSummary, updatedAt: new Date() } },
  );
  await C.chargebackEvents.insertOne({
    caseId: id,
    action: "evidence_recorded",
    fromStatus: c.status,
    toStatus: c.status,
    actorId: viewer.id,
    changes: { externalProcessorReference: ref, evidenceSummary: ev ? "updated" : undefined },
  });
  await logActivity({
    actorId: viewer.id,
    action: "chargeback.evidence",
    entityType: "chargeback",
    entityId: id,
    brandId: c.brandId,
    summary: `External reference / evidence recorded on ${id}`,
    metadata: { customerId: c.customerId, externalProcessorReference: ref },
  });
}
