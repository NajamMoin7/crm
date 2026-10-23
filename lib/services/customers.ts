import "server-only";
import { getDb } from "@/lib/db";
import { ids } from "@/lib/db/query";
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
export async function createCustomer(viewer: Viewer, raw: CustomerInput): Promise<CreatedCustomer> {
  if (!can(viewer, "customers.create")) throw new BusinessRuleError("You do not have permission to create customers.");
  const input = customerSchema.parse(raw);
  const C = await getDb();

  let assignedAgentId = viewer.id;
  if (input.assignedAgentId && input.assignedAgentId !== viewer.id && can(viewer, "agents.manage")) {
    const agent = await C.users.findOne({ id: input.assignedAgentId }, { projection: { id: 1, status: 1 } });
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

  const id = await nextId("customer");
  const now = new Date();
  await C.customers.insertOne({
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
    await C.notes.insertOne({ id: await nextId("note"), entityType: "customer", entityId: id, body: input.notes, visibility: "internal", authorId: viewer.id });
  }
  await logActivity({
    actorId: viewer.id,
    action: "customer.created",
    entityType: "customer",
    entityId: id,
    summary: `Customer ${input.fullName} created`,
    metadata: { assignedAgentId, confirmedNotDuplicate: matches.length > 0 },
  });

  for (const m of matches) {
    const [a, b] = [m.id, id].sort();
    // One candidate per pair (unique index); an existing pair is left as is.
    if (await C.duplicateCandidates.findOne({ customerAId: a, customerBId: b }, { projection: { id: 1 } })) continue;
    await C.duplicateCandidates.insertOne({
      id: await nextId("duplicate"),
      customerAId: a,
      customerBId: b,
      matchReasons: m.reasons.map((r) => `${r} matches`),
      score: m.reasons.length > 1 ? 90 : 70,
      detectedBy: "agent",
    });
  }
  return { id, fullName: input.fullName, possibleDuplicates: matches.map((m) => m.id) };
}

/** Ensures the customer ↔ brand relationship exists (called when billing under a new brand). */
export async function linkCustomerToBrand(viewer: Viewer, customerId: string, brandId: string) {
  const C = await getDb();
  const res = await C.customerBrandRelationships.updateOne(
    { customerId, brandId },
    { $setOnInsert: { customerId, brandId, firstSeenAt: new Date(), sourceSystemId: null } },
    { upsert: true },
  );
  // The first brand a customer is billed under becomes their "first brand".
  await C.customers.updateOne({ id: customerId, firstBrandId: null }, { $set: { firstBrandId: brandId } });
  if (res.upsertedCount) {
    await logActivity({
      actorId: viewer.id,
      action: "customer.brand_linked",
      entityType: "customer",
      entityId: customerId,
      brandId,
      summary: `Customer associated with brand ${brandId}`,
    });
  }
}

type Movable = { distinct(field: string, filter: object): Promise<string[]>; updateMany(filter: object, update: object): Promise<unknown> };

/**
 * Controlled merge: operational records move to the survivor; the merged
 * record is retained (mergedIntoId) with a full snapshot in merge history.
 * Ledger transactions are immutable and keep their original customer id —
 * the survivor's profile follows them through the moved invoices.
 */
export async function mergeCustomers(viewer: Viewer, candidateId: string, survivorId: string, reason: string) {
  const C = await getDb();
  const cand = await C.duplicateCandidates.findOne({ id: candidateId });
  if (!cand || cand.status !== "open") throw new BusinessRuleError("This duplicate candidate is no longer open.");
  if (survivorId !== cand.customerAId && survivorId !== cand.customerBId) throw new BusinessRuleError("Survivor must be one of the pair.");
  const mergedId = survivorId === cand.customerAId ? cand.customerBId : cand.customerAId;
  const survivor = await C.customers.findOne({ id: survivorId });
  const merged = await C.customers.findOne({ id: mergedId });
  if (!survivor || !merged || survivor.mergedIntoId || merged.mergedIntoId) throw new BusinessRuleError("One of these records was already merged.");

  // Sequential: this runs inside a transaction (one session, no concurrent operations).
  const move = async (coll: Movable, filter: object, set: object) => {
    const list = await coll.distinct("id", filter);
    if (list.length) await coll.updateMany({ id: { $in: list } }, { $set: set });
    return list;
  };
  const toSurvivor = { customerId: survivorId };
  const moved = {
    sales: await move(C.sales as unknown as Movable, { customerId: mergedId }, toSurvivor),
    invoices: await move(C.invoices as unknown as Movable, { customerId: mergedId }, toSurvivor),
    cases: await move(C.chargebackCases as unknown as Movable, { customerId: mergedId }, toSurvivor),
    leads: await move(C.leads as unknown as Movable, { customerId: mergedId }, toSurvivor),
    notes: await move(C.notes as unknown as Movable, { entityType: "customer", entityId: mergedId }, { entityId: survivorId }),
    tasks: await move(C.tasks as unknown as Movable, { entityType: "customer", entityId: mergedId }, { entityId: survivorId }),
  };
  const rels = await C.customerBrandRelationships.find({ customerId: mergedId }).toArray();
  for (const r of rels) {
    await C.customerBrandRelationships.updateOne(
      { customerId: survivorId, brandId: r.brandId },
      { $setOnInsert: { customerId: survivorId, brandId: r.brandId, firstSeenAt: r.firstSeenAt, sourceSystemId: r.sourceSystemId } },
      { upsert: true },
    );
  }
  const now = new Date();
  await C.customers.updateOne({ id: mergedId }, { $set: { mergedIntoId: survivorId, status: "inactive", updatedAt: now } });
  await C.customers.updateOne(
    { id: survivorId },
    {
      $set: {
        updatedAt: now,
        lastActivityAt: now,
        email: survivor.email ?? merged.email,
        phone: survivor.phone ?? merged.phone,
        phoneNormalized: survivor.phoneNormalized ?? merged.phoneNormalized,
        companyName: survivor.companyName ?? merged.companyName,
        tags: [...new Set([...survivor.tags, ...merged.tags])],
      },
    },
  );
  await C.customerMergeHistory.insertOne({
    id: await nextId("merge"),
    survivorId,
    mergedId,
    duplicateCandidateId: candidateId,
    performedBy: viewer.id,
    reason,
    snapshot: merged,
    movedRecords: moved,
  });
  await C.duplicateCandidates.updateOne(
    { id: candidateId },
    { $set: { status: "merged", reviewedBy: viewer.id, reviewedAt: now, resolutionNote: reason } },
  );
  // Other open candidates pointing at the merged record are re-evaluated by a human.
  await C.duplicateCandidates.updateMany(
    { status: "open", $or: [{ customerAId: mergedId }, { customerBId: mergedId }] },
    { $set: { status: "dismissed", reviewedBy: viewer.id, reviewedAt: now, resolutionNote: `Superseded by merge into ${survivorId}` } },
  );
  await logActivity({
    actorId: viewer.id,
    action: "customer.merged",
    entityType: "customer",
    entityId: survivorId,
    summary: `Merged ${mergedId} (${merged.fullName}) into ${survivorId}`,
    metadata: { mergedId, candidateId, reason, moved: Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, v.length])) },
  });
  await logActivity({
    actorId: viewer.id,
    action: "customer.merged_into",
    entityType: "customer",
    entityId: mergedId,
    summary: `Record merged into ${survivorId}; retained read-only for audit`,
  });
  if (survivor.assignedAgentId && survivor.assignedAgentId !== viewer.id) {
    await notify([survivor.assignedAgentId], {
      kind: "system",
      title: "Customer records merged",
      body: `${mergedId} was merged into ${survivorId} (${survivor.fullName}).`,
      href: `/customers/${survivorId}`,
    });
  }
  return { survivorId, mergedId, moved };
}

export async function customerIdsWithMerged(id: string) {
  const C = await getDb();
  return C.customers.distinct("id", { $or: [{ id }, { mergedIntoId: id }] });
}

export async function touchCustomer(customerIds: string[]) {
  if (!customerIds.length) return;
  const C = await getDb();
  await C.customers.updateMany({ id: { $in: ids(customerIds) } }, { $set: { lastActivityAt: new Date() } });
}
