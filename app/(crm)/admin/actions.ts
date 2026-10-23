"use server";

import { refresh } from "next/cache";
import { getDb, withTransaction } from "@/lib/db";
import { authorize } from "@/lib/auth/viewer";
import { revokeUserSessions } from "@/lib/auth/session";
import { BusinessRuleError, runAction } from "@/lib/actions";
import type { ActionResult } from "@/lib/action-result";
import {
  createUser,
  resetUserPassword,
  updateSettings,
  updateUser,
  type CreateUserInput,
  type UpdateUserInput,
} from "@/lib/services/admin";

export async function createUserAction(input: CreateUserInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const viewer = await authorize("users.manage");
    const res = await withTransaction(() => createUser(viewer, input));
    refresh();
    return { ok: true, data: { id: res.id }, message: `User ${res.id} created${res.agentCode ? ` with agent code ${res.agentCode}` : ""}.` };
  });
}

export async function updateUserAction(id: string, input: UpdateUserInput): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("users.manage");
    const res = await withTransaction(() => updateUser(viewer, String(id), input));
    // Suspension takes effect immediately: every session of the user is deleted.
    if (res.suspended) await revokeUserSessions(String(id));
    refresh();
    if (!res.changed) return { ok: true, message: "No changes to save." };
    return { ok: true, message: res.suspended ? "User suspended and signed out everywhere." : "User updated." };
  });
}

/** One-click activate / deactivate. Runs through updateUser, so every safeguard applies. */
export async function setUserStatusAction(id: string, status: "active" | "suspended"): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("users.manage");
    const C = await getDb();
    const res = await withTransaction(async () => {
      const u = await C.users.findOne({ id: String(id) });
      if (!u) throw new BusinessRuleError("Agent not found.");
      const roleRows = await C.userRoles.find({ userId: u.id }).toArray();
      const brandRows = await C.userBrandAccess.find({ userId: u.id }).toArray();
      return updateUser(viewer, u.id, {
        name: u.name,
        email: u.email,
        role: roleRows.some((r) => r.roleId === "super_admin") ? "super_admin" : "sales_agent",
        brandIds: brandRows.map((b) => b.brandId),
        status: status === "suspended" ? "suspended" : "active",
      });
    });
    if (res.suspended) await revokeUserSessions(String(id));
    refresh();
    return { ok: true, message: status === "suspended" ? "Account deactivated and signed out." : "Account activated." };
  });
}

export async function resetPasswordAction(id: string, password: string): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("users.manage");
    await withTransaction(() => resetUserPassword(viewer, String(id), String(password ?? "")));
    await revokeUserSessions(String(id));
    refresh();
    return { ok: true, message: "Temporary password set. The user was signed out of all sessions." };
  });
}

export async function updateSettingsAction(values: Record<string, unknown>): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("settings.manage");
    const safe = values && typeof values === "object" ? values : {};
    const res = await withTransaction(() => updateSettings(viewer, safe));
    refresh();
    return { ok: true, message: res.changed.length ? `Saved ${res.changed.length} setting${res.changed.length > 1 ? "s" : ""}.` : "No changes to save." };
  });
}
