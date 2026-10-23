"use server";

import { refresh } from "next/cache";
import { getDb, withTransaction } from "@/lib/db";
import { nextId } from "@/lib/db/ids";
import { authorize } from "@/lib/auth/viewer";
import { getCustomerForViewer, findCustomerMatches } from "@/lib/data/customers";
import { mergeCustomers } from "@/lib/services/customers";
import { BusinessRuleError, runAction } from "@/lib/actions";
import { logActivity } from "@/lib/audit";
import type { ActionResult } from "@/lib/action-result";
import { customerUpdateSchema, noteSchema } from "@/lib/validation";
import { maskEmail, maskPhone } from "@/lib/mask";
import { can } from "@/lib/auth/viewer";

export type MatchResult = {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  companyName: string | null;
  billingAddress: string | null;
  brandIds: string[];
  reasons: string[];
  merged: string | null;
  canOpen: boolean;
};

/** Customer lookup used by the customer & billing workflows (by ID, email or phone). */
export async function lookupCustomersAction(query: { query?: string; email?: string; phone?: string; name?: string }): Promise<ActionResult<MatchResult[]>> {
  return runAction(async () => {
    const viewer = await authorize("customers.view");
    const rows = await findCustomerMatches(viewer, query);
    const visible = new Set<string>();
    for (const r of rows) if (await getCustomerForViewer(viewer, r.id)) visible.add(r.id);
    return {
      ok: true,
      data: rows.map((r) => {
        const full = visible.has(r.id) || can(viewer, "customers.view_all");
        return {
          id: r.id,
          fullName: r.fullName,
          email: full ? (r.email ?? "—") : maskEmail(r.email),
          phone: full ? (r.phone ?? "—") : maskPhone(r.phone),
          companyName: r.companyName,
          billingAddress: full ? r.billingAddress : null,
          brandIds: r.brandIds ?? [],
          reasons: r.reasons,
          merged: r.mergedIntoId,
          canOpen: visible.has(r.id),
        };
      }),
    };
  });
}

export async function updateCustomerAction(id: string, raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("customers.edit");
    const existing = await getCustomerForViewer(viewer, id);
    if (!existing) throw new BusinessRuleError("Customer not found or not accessible.");
    if (existing.mergedIntoId) throw new BusinessRuleError(`This record was merged into ${existing.mergedIntoId} and is read-only.`);
    const input = customerUpdateSchema.parse(raw);
    const patch = {
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
      phoneNormalized: input.phone.replace(/\D/g, ""),
      companyName: input.companyName ?? null,
      status: input.status,
      // Reassignment is a Super Admin capability; agents keep the current owner.
      assignedAgentId: can(viewer, "agents.manage") ? (input.assignedAgentId ?? existing.assignedAgentId) : existing.assignedAgentId,
    };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(patch)) {
      const before = existing[k as keyof typeof existing];
      if (JSON.stringify(before ?? null) !== JSON.stringify(v ?? null)) changes[k] = { from: k === "phoneNormalized" ? undefined : before, to: v };
    }
    delete changes.phoneNormalized;
    if (Object.keys(changes).length === 0) return { ok: true, message: "No changes to save." };
    const C = await getDb();
    await withTransaction(async () => {
      await C.customers.updateOne({ id }, { $set: { ...patch, updatedAt: new Date() } });
      await logActivity({
        actorId: viewer.id,
        action: "customer.updated",
        entityType: "customer",
        entityId: id,
        brandId: existing.firstBrandId,
        summary: `Updated ${Object.keys(changes).join(", ")}`,
        metadata: { changes },
      });
    });
    refresh();
    return { ok: true, message: "Customer updated." };
  });
}

export async function addCustomerNoteAction(customerId: string, raw: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("customers.view");
    const input = noteSchema.parse(raw);
    if (input.visibility === "finance" && !can(viewer, "transactions.view")) throw new BusinessRuleError("Only a Super Admin can add restricted notes.");
    const customer = await getCustomerForViewer(viewer, customerId);
    if (!customer) throw new BusinessRuleError("Customer not found or not accessible.");
    const C = await getDb();
    await withTransaction(async () => {
      const id = await nextId("note");
      await C.notes.insertOne({ id, entityType: "customer", entityId: customerId, body: input.body, visibility: input.visibility, authorId: viewer.id });
      await C.customers.updateOne({ id: customerId }, { $set: { lastActivityAt: new Date() } });
      await logActivity({ actorId: viewer.id, action: "note.added", entityType: "customer", entityId: customerId, summary: "Internal note added" });
    });
    refresh();
    return { ok: true, message: "Note added." };
  });
}

export async function mergeDuplicateAction(candidateId: string, survivorId: string, reason: string): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("customers.merge");
    if (reason.trim().length < 5) throw new BusinessRuleError("Explain why these records are the same customer (min. 5 characters).");
    const C = await getDb();
    const cand = await C.duplicateCandidates.findOne({ id: candidateId });
    if (!cand) throw new BusinessRuleError("Candidate not found.");
    for (const cid of [cand.customerAId, cand.customerBId]) {
      if (!(await getCustomerForViewer(viewer, cid))) throw new BusinessRuleError("You don't have access to both records.");
    }
    const res = await withTransaction(() => mergeCustomers(viewer, candidateId, survivorId, reason.trim()));
    refresh();
    return { ok: true, message: `Merged ${res.mergedId} into ${res.survivorId}.` };
  });
}

export async function dismissDuplicateAction(candidateId: string, note: string): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("customers.merge");
    if (note.trim().length < 3) throw new BusinessRuleError("Add a short note explaining why these are different customers.");
    const C = await getDb();
    await withTransaction(async () => {
      const res = await C.duplicateCandidates.findOneAndUpdate(
        { id: candidateId, status: "open" },
        { $set: { status: "dismissed", reviewedBy: viewer.id, reviewedAt: new Date(), resolutionNote: note.trim() } },
      );
      if (!res) throw new BusinessRuleError("This candidate is no longer open.");
      await logActivity({
        actorId: viewer.id,
        action: "customer.duplicate_dismissed",
        entityType: "customer",
        entityId: res.customerAId,
        summary: `Marked ${res.customerAId} and ${res.customerBId} as different customers`,
        metadata: { candidateId, note: note.trim() },
      });
    });
    refresh();
    return { ok: true, message: "Marked as different customers." };
  });
}
