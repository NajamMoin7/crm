import "server-only";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db";
import {
  chargebackCases,
  customerBrandRelationships,
  customerMergeHistory,
  customers,
  duplicateCandidates,
  invoices,
  leads,
  notes,
  sales,
  tasks,
  users,
} from "@/lib/db/schema";
import { nextId } from "@/lib/db/ids";
import { logActivity, notify } from "@/lib/audit";
import { BusinessRuleError } from "@/lib/actions";
import { can, type Viewer } from "@/lib/auth/viewer";
import { customerSchema, type CustomerInput } from "@/lib/validation";
import { findCustomerMatches } from "@/lib/data/customers";

export type CreatedCustomer = { id: string; fullName: string; possibleDuplicates: string[] };

/**
 * Creates a customer from the essentials (name, email, phone; company and a
 * note optional). Before saving, every existing customer is checked for the
 * same email or phone, not only the ones visible to this user, so agents can't
 * duplicate another agent's customer. Matches must be confirmed as a different
 * person, and even then a duplicate-review candidate is registered.
 * The brand association is created when the customer is first billed.
 */
export async function createCustomer(tx: DbOrTx, viewer: Viewer, raw: CustomerInput): Promise<CreatedCustomer> {
  if (!can(viewer, "customers.create")) throw new BusinessRuleError("You do not have permission to create customers.");
  const input = customerSchema.parse(raw);

  let assignedAgentId = viewer.id;
  if (input.assignedAgentId && input.assignedAgentId !== viewer.id && can(viewer, "agents.manage")) {
    const [agent] = await tx.select({ id: users.id, status: users.status }).from(users).where(eq(users.id, input.assignedAgentId));
    if (!agent || agent.status !== "active") throw new BusinessRuleError("The selected agent is not active.", { assignedAgentId: ["Choose an active agent."] });
    assignedAgentId = agent.id;
  }

  const matches = (await findCustomerMatches(viewer, { email: input.email, phone: input.phone }, { global: true })).filter(
    (m) => !m.mergedIntoId && (m.reasons.includes("Email") || m.reasons.includes("Phone")),
  );
  if (matches.length && !input.confirmNotDuplicate) {
    const what = matches.some((m) => m.reasons.includes("Email")) ? "email" : "phone number";
    throw new BusinessRuleError(
      `A customer with this ${what} already exists (${matches.map((m) => m.id).join(", ")}). Open the existing profile, or confirm this is a different person.`,
      { duplicates: matches.map((m) => m.id) },
    );
  }

  const id = await nextId(tx, "customer");
  const now = new Date();
  await tx.insert(customers).values({
    id,
    fullName: input.fullName,
    email: input.email,
    phone: input.phone,
    phoneNormalized: input.phone.replace(/\D/g, ""),
    companyName: input.companyName ?? null,
    customerType: input.companyName ? "business" : "individual",
    status: "active",
    assignedAgentId,
    createdBy: viewer.id,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  });
  if (input.notes) {
    await tx.insert(notes).values({ id: await nextId(tx, "note"), entityType: "customer", entityId: id, body: input.notes, visibility: "internal", authorId: viewer.id });
  }
  await logActivity(tx, {
    actorId: viewer.id,
    action: "customer.created",
    entityType: "customer",
    entityId: id,
    summary: `Customer ${input.fullName} created`,
    metadata: { assignedAgentId, confirmedNotDuplicate: matches.length > 0 },
  });

  for (const m of matches) {
    const [a, b] = [m.id, id].sort();
    await tx
      .insert(duplicateCandidates)
      .values({
        id: await nextId(tx, "duplicate"),
        customerAId: a,
        customerBId: b,
        matchReasons: m.reasons.map((r) => `${r} matches`),
        score: m.reasons.length > 1 ? 90 : 70,
        detectedBy: "agent",
      })
      .onConflictDoNothing();
  }
  return { id, fullName: input.fullName, possibleDuplicates: matches.map((m) => m.id) };
}

/** Ensures the customer ↔ brand relationship exists (called when billing under a new brand). */
export async function linkCustomerToBrand(tx: DbOrTx, viewer: Viewer, customerId: string, brandId: string) {
  const res = await tx.insert(customerBrandRelationships).values({ customerId, brandId }).onConflictDoNothing().returning();
  // The first brand a customer is billed under becomes their "first brand".
  await tx.update(customers).set({ firstBrandId: brandId }).where(and(eq(customers.id, customerId), isNull(customers.firstBrandId)));
  if (res.length) {
    await logActivity(tx, {
      actorId: viewer.id,
      action: "customer.brand_linked",
      entityType: "customer",
      entityId: customerId,
      brandId,
      summary: `Customer associated with brand ${brandId}`,
    });
  }
}

/**
 * Controlled merge: operational records move to the survivor; the merged
 * record is retained (merged_into_id) with a full snapshot in merge history.
 * Ledger transactions are immutable and keep their original customer id —
 * the survivor's profile follows them through the moved invoices.
 */
export async function mergeCustomers(tx: DbOrTx, viewer: Viewer, candidateId: string, survivorId: string, reason: string) {
  const [cand] = await tx.select().from(duplicateCandidates).where(eq(duplicateCandidates.id, candidateId));
  if (!cand || cand.status !== "open") throw new BusinessRuleError("This duplicate candidate is no longer open.");
  if (survivorId !== cand.customerAId && survivorId !== cand.customerBId) throw new BusinessRuleError("Survivor must be one of the pair.");
  const mergedId = survivorId === cand.customerAId ? cand.customerBId : cand.customerAId;
  const [survivor] = await tx.select().from(customers).where(eq(customers.id, survivorId));
  const [merged] = await tx.select().from(customers).where(eq(customers.id, mergedId));
  if (!survivor || !merged || survivor.mergedIntoId || merged.mergedIntoId) throw new BusinessRuleError("One of these records was already merged.");

  const moved = {
    sales: (await tx.update(sales).set({ customerId: survivorId }).where(eq(sales.customerId, mergedId)).returning({ id: sales.id })).map((r) => r.id),
    invoices: (await tx.update(invoices).set({ customerId: survivorId }).where(eq(invoices.customerId, mergedId)).returning({ id: invoices.id })).map((r) => r.id),
    cases: (await tx.update(chargebackCases).set({ customerId: survivorId }).where(eq(chargebackCases.customerId, mergedId)).returning({ id: chargebackCases.id })).map((r) => r.id),
    leads: (await tx.update(leads).set({ customerId: survivorId }).where(eq(leads.customerId, mergedId)).returning({ id: leads.id })).map((r) => r.id),
    notes: (await tx.update(notes).set({ entityId: survivorId }).where(and(eq(notes.entityType, "customer"), eq(notes.entityId, mergedId))).returning({ id: notes.id })).map((r) => r.id),
    tasks: (await tx.update(tasks).set({ entityId: survivorId }).where(and(eq(tasks.entityType, "customer"), eq(tasks.entityId, mergedId))).returning({ id: tasks.id })).map((r) => r.id),
  };
  const rels = await tx.select().from(customerBrandRelationships).where(eq(customerBrandRelationships.customerId, mergedId));
  for (const r of rels) {
    await tx
      .insert(customerBrandRelationships)
      .values({ customerId: survivorId, brandId: r.brandId, firstSeenAt: r.firstSeenAt, sourceSystemId: r.sourceSystemId })
      .onConflictDoNothing();
  }
  const now = new Date();
  await tx.update(customers).set({ mergedIntoId: survivorId, status: "inactive", updatedAt: now }).where(eq(customers.id, mergedId));
  await tx
    .update(customers)
    .set({
      updatedAt: now,
      lastActivityAt: now,
      email: survivor.email ?? merged.email,
      phone: survivor.phone ?? merged.phone,
      phoneNormalized: survivor.phoneNormalized ?? merged.phoneNormalized,
      companyName: survivor.companyName ?? merged.companyName,
      tags: [...new Set([...survivor.tags, ...merged.tags])],
    })
    .where(eq(customers.id, survivorId));
  await tx.insert(customerMergeHistory).values({
    id: await nextId(tx, "merge"),
    survivorId,
    mergedId,
    duplicateCandidateId: candidateId,
    performedBy: viewer.id,
    reason,
    snapshot: merged,
    movedRecords: moved,
  });
  await tx
    .update(duplicateCandidates)
    .set({ status: "merged", reviewedBy: viewer.id, reviewedAt: now, resolutionNote: reason })
    .where(eq(duplicateCandidates.id, candidateId));
  // Other open candidates pointing at the merged record are re-evaluated by a human.
  await tx
    .update(duplicateCandidates)
    .set({ status: "dismissed", reviewedBy: viewer.id, reviewedAt: now, resolutionNote: `Superseded by merge into ${survivorId}` })
    .where(
      and(
        eq(duplicateCandidates.status, "open"),
        or(eq(duplicateCandidates.customerAId, mergedId), eq(duplicateCandidates.customerBId, mergedId)),
      ),
    );
  await logActivity(tx, {
    actorId: viewer.id,
    action: "customer.merged",
    entityType: "customer",
    entityId: survivorId,
    summary: `Merged ${mergedId} (${merged.fullName}) into ${survivorId}`,
    metadata: { mergedId, candidateId, reason, moved: Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, v.length])) },
  });
  await logActivity(tx, {
    actorId: viewer.id,
    action: "customer.merged_into",
    entityType: "customer",
    entityId: mergedId,
    summary: `Record merged into ${survivorId}; retained read-only for audit`,
  });
  if (survivor.assignedAgentId && survivor.assignedAgentId !== viewer.id) {
    await notify(tx, [survivor.assignedAgentId], {
      kind: "system",
      title: "Customer records merged",
      body: `${mergedId} was merged into ${survivorId} (${survivor.fullName}).`,
      href: `/customers/${survivorId}`,
    });
  }
  return { survivorId, mergedId, moved };
}

export async function customerIdsWithMerged(tx: DbOrTx, id: string) {
  const rows = await tx.select({ id: customers.id }).from(customers).where(or(eq(customers.id, id), eq(customers.mergedIntoId, id)));
  return rows.map((r) => r.id);
}

export async function touchCustomer(tx: DbOrTx, customerIds: string[]) {
  if (!customerIds.length) return;
  await tx.update(customers).set({ lastActivityAt: sql`now()` }).where(inArray(customers.id, customerIds));
}
