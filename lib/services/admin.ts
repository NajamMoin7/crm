import "server-only";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { equalsCi } from "@/lib/db/query";
import { nextId } from "@/lib/db/ids";
import { logActivity } from "@/lib/audit";
import { BusinessRuleError } from "@/lib/actions";
import type { Viewer } from "@/lib/auth/viewer";
import { currencyCode } from "@/lib/validation";

/* --------------------------------------------------------------- helpers */

export type Changes = Record<string, { from: unknown; to: unknown }>;

/** Field-level before/after diff for audit metadata. */
export function diffFields<T extends Record<string, unknown>>(before: T, after: Partial<T>, keys?: (keyof T)[]): Changes {
  const out: Changes = {};
  for (const k of keys ?? (Object.keys(after) as (keyof T)[])) {
    if (!(k in after)) continue;
    const a = before[k] ?? null;
    const b = after[k] ?? null;
    const norm = (v: unknown) => JSON.stringify(Array.isArray(v) ? [...v].sort() : v instanceof Date ? v.toISOString() : v);
    if (norm(a) !== norm(b)) out[k as string] = { from: a, to: b };
  }
  return out;
}

function setDiff(before: string[], after: string[]) {
  return { added: after.filter((x) => !before.includes(x)), removed: before.filter((x) => !after.includes(x)) };
}

/* ----------------------------------------------------------------- users */

export const passwordSchema = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(128, "Use at most 128 characters.")
  .refine((v) => /[A-Z]/.test(v), "Include an uppercase letter.")
  .refine((v) => /[a-z]/.test(v), "Include a lowercase letter.")
  .refine((v) => /\d/.test(v), "Include a number.")
  .refine((v) => /[^A-Za-z0-9]/.test(v), "Include a symbol.");

/** Exactly two roles exist. Every user has exactly one of them. */
const roleSchema = z.enum(["super_admin", "sales_agent"], { message: "Choose Super Admin or Sales Agent." });

const userCore = {
  name: z.string().trim().min(2, "Name is required.").max(80),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .refine((v) => z.email().safeParse(v).success, "Enter a valid email address."),
  role: roleSchema,
  /** Required for Sales Agents. Super Admins always have every brand. */
  brandIds: z.array(z.string().min(1).max(40)).max(20).default([]),
};

export const createUserSchema = z.object({ ...userCore, password: passwordSchema });
export type CreateUserInput = z.input<typeof createUserSchema>;

export const updateUserSchema = z.object({ ...userCore, status: z.enum(["active", "suspended"]) });
export type UpdateUserInput = z.input<typeof updateUserSchema>;

/** Super Admins get all brands; agents get the validated subset they were assigned. */
async function resolveBrands(role: "super_admin" | "sales_agent", requested: string[]) {
  const C = await getDb();
  const all = await C.brands.find({}, { projection: { id: 1 } }).toArray();
  if (role === "super_admin") return all.map((b) => b.id);
  const ids = [...new Set(requested)];
  if (ids.length === 0) throw new BusinessRuleError("Assign at least one brand to the sales agent.", { brandIds: ["Assign at least one brand."] });
  if (ids.some((id) => !all.some((b) => b.id === id))) throw new BusinessRuleError("Unknown brand selected.", { brandIds: ["Unknown brand."] });
  return ids;
}

async function otherActiveSuperAdmins(excludeUserId: string) {
  const C = await getDb();
  const admins = await C.userRoles.distinct("userId", { roleId: "super_admin" });
  return C.users.countDocuments({ id: { $in: admins.filter((u) => u !== excludeUserId) }, status: "active" });
}

async function assertEmailFree(email: string, exceptId?: string) {
  const C = await getDb();
  const dupe = await C.users.findOne({ email: equalsCi(email), ...(exceptId ? { id: { $ne: exceptId } } : {}) }, { projection: { id: 1 } });
  if (dupe) throw new BusinessRuleError("A user with this email already exists.", { email: ["Email already in use."] });
}

/** Agents need a sales_agents profile (agent code) for attribution and filters. */
async function ensureAgentProfile(userId: string) {
  const C = await getDb();
  const existing = await C.salesAgents.findOne({ userId });
  if (existing) return existing.agentCode;
  const codes = await C.salesAgents.distinct("agentCode");
  const max = codes.reduce((m, c) => Math.max(m, Number(String(c).replace(/[^0-9]/g, "")) || 0), 0);
  const agentCode = `AG-${String(max + 1).padStart(3, "0")}`;
  await C.salesAgents.insertOne({ userId, agentCode, team: "Sales", monthlyTarget: "0.00", hireDate: new Date().toISOString().slice(0, 10), managerId: null });
  return agentCode;
}

export async function createUser(viewer: Viewer, raw: CreateUserInput) {
  const input = createUserSchema.parse(raw);
  const C = await getDb();
  await assertEmailFree(input.email);
  const brandIds = await resolveBrands(input.role, input.brandIds);

  const id = await nextId("user");
  const passwordHash = await bcrypt.hash(input.password, 10);
  const now = new Date();
  await C.users.insertOne({ id, email: input.email, name: input.name, passwordHash, status: "active", createdAt: now, updatedAt: now });
  await C.userRoles.insertOne({ userId: id, roleId: input.role });
  await C.userBrandAccess.insertMany(brandIds.map((brandId) => ({ userId: id, brandId, grantedBy: viewer.id })));
  const agentCode = input.role === "sales_agent" ? await ensureAgentProfile(id) : null;

  await logActivity({
    actorId: viewer.id,
    action: "user.created",
    entityType: "user",
    entityId: id,
    summary: `User ${input.name} <${input.email}> created as ${input.role === "super_admin" ? "Super Admin" : "Sales Agent"}`,
    // Never log the password or its hash.
    metadata: { email: input.email, role: input.role, brands: brandIds, agentCode },
  });
  return { id, agentCode };
}

export async function updateUser(viewer: Viewer, id: string, raw: UpdateUserInput) {
  const input = updateUserSchema.parse(raw);
  const C = await getDb();
  const existing = await C.users.findOne({ id });
  if (!existing) throw new BusinessRuleError("User not found.");
  await assertEmailFree(input.email, id);
  // Sequential: this runs inside a transaction.
  const roleRows = await C.userRoles.find({ userId: id }).toArray();
  const brandRows = await C.userBrandAccess.find({ userId: id }).toArray();
  const beforeRole = roleRows.some((r) => r.roleId === "super_admin") ? "super_admin" : "sales_agent";
  const beforeBrands = brandRows.map((r) => r.brandId);
  const brandIds = await resolveBrands(input.role, input.brandIds);

  if (id === viewer.id) {
    if (input.status !== "active") throw new BusinessRuleError("You cannot suspend your own account.", { status: ["You cannot suspend yourself."] });
    if (input.role !== beforeRole) throw new BusinessRuleError("You cannot change your own role.", { role: ["You cannot change your own role."] });
  }
  const losesSuperAdmin = beforeRole === "super_admin" && existing.status === "active" && (input.role !== "super_admin" || input.status !== "active");
  if (losesSuperAdmin && (await otherActiveSuperAdmins(id)) === 0) {
    throw new BusinessRuleError("This is the last active Super Admin. Create or activate another Super Admin first.", { status: ["Last active Super Admin."] });
  }

  const changes: Changes = diffFields(
    { name: existing.name, email: existing.email, status: existing.status, role: beforeRole, brands: beforeBrands },
    { name: input.name, email: input.email, status: input.status, role: input.role, brands: brandIds },
  );
  if (Object.keys(changes).length === 0) return { changed: false, suspended: false };

  const now = new Date();
  await C.users.updateOne({ id }, { $set: { name: input.name, email: input.email, status: input.status, updatedAt: now } });
  if (changes.role) {
    await C.userRoles.deleteMany({ userId: id });
    await C.userRoles.insertOne({ userId: id, roleId: input.role });
  }
  const b = setDiff(beforeBrands, brandIds);
  if (b.removed.length) await C.userBrandAccess.deleteMany({ userId: id, brandId: { $in: b.removed } });
  if (b.added.length) await C.userBrandAccess.insertMany(b.added.map((brandId) => ({ userId: id, brandId, grantedBy: viewer.id })));
  if (input.role === "sales_agent") await ensureAgentProfile(id);

  await logActivity({
    actorId: viewer.id,
    action: changes.role ? "user.role_changed" : "user.updated",
    entityType: "user",
    entityId: id,
    summary: `Updated ${existing.name}: ${Object.keys(changes).join(", ")}`,
    metadata: { changes },
  });
  const suspended = existing.status !== "suspended" && input.status === "suspended";
  if (suspended) {
    await logActivity({ actorId: viewer.id, action: "user.suspended", entityType: "user", entityId: id, summary: `${existing.name} suspended; all sessions revoked` });
  } else if (existing.status === "suspended" && input.status === "active") {
    await logActivity({ actorId: viewer.id, action: "user.reactivated", entityType: "user", entityId: id, summary: `${existing.name} reactivated` });
  }
  // Role / brand changes apply on the user's next request (the viewer is rebuilt from the DB each time).
  return { changed: true, suspended };
}


export async function resetUserPassword(viewer: Viewer, id: string, rawPassword: string) {
  const password = passwordSchema.parse(rawPassword);
  if (id === viewer.id) throw new BusinessRuleError("You can't reset your own password from the admin console.");
  const C = await getDb();
  const existing = await C.users.findOne({ id }, { projection: { id: 1, name: 1 } });
  if (!existing) throw new BusinessRuleError("User not found.");
  const passwordHash = await bcrypt.hash(password, 10);
  await C.users.updateOne({ id }, { $set: { passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() } });
  await logActivity({
    actorId: viewer.id,
    action: "user.password_reset",
    entityType: "user",
    entityId: id,
    summary: `Temporary password set for ${existing.name}; sessions revoked`,
    metadata: { unlocked: true },
  });
}

/* ------------------------------------------------------------- settings */

export type SettingMeta = { label: string; group: string; kind: "boolean" | "number" | "string"; min?: number; max?: number; unit?: string; pattern?: string };

/** Typed metadata for known settings. Unknown keys are edited by their stored value's type. */
export const SETTING_META: Record<string, SettingMeta> = {
  "chargeback.require_independent_approval": { label: "Require independent approval", group: "Recharge / chargeback policy", kind: "boolean" },
  "chargeback.require_independent_review": { label: "Require independent review", group: "Recharge / chargeback policy", kind: "boolean" },
  "chargeback.allow_partial": { label: "Allow partial chargebacks", group: "Recharge / chargeback policy", kind: "boolean" },
  "chargeback.allow_multiple": { label: "Allow multiple chargebacks per payment", group: "Recharge / chargeback policy", kind: "boolean" },
  "chargeback.max_days_after_payment": { label: "Maximum days after payment", group: "Recharge / chargeback policy", kind: "number", min: 1, max: 3650, unit: "days" },
  "security.session_hours": { label: "Session lifetime", group: "Security", kind: "number", min: 1, max: 72, unit: "hours" },
  "security.max_login_attempts": { label: "Max failed sign-in attempts", group: "Security", kind: "number", min: 3, max: 20, unit: "attempts" },
  "reporting.currency": { label: "Reporting currency", group: "Reporting", kind: "string", pattern: "^[A-Z]{3}$" },
};

export function settingMetaFor(key: string, value: unknown): SettingMeta {
  if (SETTING_META[key]) return SETTING_META[key];
  const kind = typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string";
  const group = key.includes(".") ? key.split(".")[0].replace(/^\w/, (c) => c.toUpperCase()) : "General";
  return { label: key, group, kind };
}

function settingSchema(key: string, meta: SettingMeta) {
  if (key === "reporting.currency") return currencyCode;
  if (meta.kind === "boolean") return z.boolean();
  if (meta.kind === "number") {
    let s = z.number({ error: "Enter a number." }).int("Use a whole number.");
    if (meta.min !== undefined) s = s.min(meta.min, `Minimum ${meta.min}.`);
    if (meta.max !== undefined) s = s.max(meta.max, `Maximum ${meta.max}.`);
    return s;
  }
  return z.string().trim().min(1, "Required.").max(200);
}

export async function updateSettings(viewer: Viewer, values: Record<string, unknown>) {
  const keys = Object.keys(values);
  if (!keys.length) return { changed: [] as string[] };
  const C = await getDb();
  const rows = await C.systemSettings.find({ key: { $in: keys } }).toArray();
  const fieldErrors: Record<string, string[]> = {};
  const updates: { key: string; from: unknown; to: unknown }[] = [];
  for (const key of keys) {
    const row = rows.find((r) => r.key === key);
    if (!row) {
      fieldErrors[key] = ["Unknown setting."];
      continue;
    }
    const parsed = settingSchema(key, settingMetaFor(key, row.value)).safeParse(values[key]);
    if (!parsed.success) {
      fieldErrors[key] = parsed.error.issues.map((i) => i.message);
      continue;
    }
    if (JSON.stringify(parsed.data) !== JSON.stringify(row.value)) updates.push({ key, from: row.value, to: parsed.data });
  }
  if (Object.keys(fieldErrors).length) throw new BusinessRuleError("Please correct the highlighted settings.", fieldErrors);
  const now = new Date();
  for (const u of updates) {
    await C.systemSettings.updateOne({ key: u.key }, { $set: { value: u.to, updatedBy: viewer.id, updatedAt: now } });
    await logActivity({
      actorId: viewer.id,
      action: "settings.updated",
      entityType: "setting",
      entityId: u.key,
      summary: `Changed ${u.key} from ${JSON.stringify(u.from)} to ${JSON.stringify(u.to)}`,
      metadata: { changes: { [u.key]: { from: u.from, to: u.to } } },
    });
  }
  return { changed: updates.map((u) => u.key) };
}
