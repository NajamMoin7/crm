import "server-only";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db";
import {
  brands,
  salesAgents,
  systemSettings,
  userBrandAccess,
  userRoles,
  users } from "@/lib/db/schema";
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
async function resolveBrands(tx: DbOrTx, role: "super_admin" | "sales_agent", requested: string[]) {
  const all = await tx.select({ id: brands.id }).from(brands);
  if (role === "super_admin") return all.map((b) => b.id);
  const ids = [...new Set(requested)];
  if (ids.length === 0) throw new BusinessRuleError("Assign at least one brand to the sales agent.", { brandIds: ["Assign at least one brand."] });
  if (ids.some((id) => !all.some((b) => b.id === id))) throw new BusinessRuleError("Unknown brand selected.", { brandIds: ["Unknown brand."] });
  return ids;
}

async function otherActiveSuperAdmins(tx: DbOrTx, excludeUserId: string) {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.roleId, "super_admin"), eq(users.status, "active"), ne(users.id, excludeUserId)));
  return n;
}

async function assertEmailFree(tx: DbOrTx, email: string, exceptId?: string) {
  const [dupe] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(sql`lower(${users.email})`, email), exceptId ? ne(users.id, exceptId) : undefined));
  if (dupe) throw new BusinessRuleError("A user with this email already exists.", { email: ["Email already in use."] });
}

/** Agents need a sales_agents profile (agent code) for attribution and filters. */
async function ensureAgentProfile(tx: DbOrTx, userId: string) {
  const [existing] = await tx.select({ code: salesAgents.agentCode }).from(salesAgents).where(eq(salesAgents.userId, userId));
  if (existing) return existing.code;
  const res = await tx.execute<{ n: number }>(
    sql`select coalesce(max(nullif(regexp_replace(agent_code, '[^0-9]', '', 'g'), '')::int), 0)::int as n from sales_agents`,
  );
  const agentCode = `AG-${String(Number(res.rows[0]?.n ?? 0) + 1).padStart(3, "0")}`;
  await tx.insert(salesAgents).values({ userId, agentCode, team: "Sales", monthlyTarget: "0.00", hireDate: new Date().toISOString().slice(0, 10), managerId: null });
  return agentCode;
}

export async function createUser(tx: DbOrTx, viewer: Viewer, raw: CreateUserInput) {
  const input = createUserSchema.parse(raw);
  await assertEmailFree(tx, input.email);
  const brandIds = await resolveBrands(tx, input.role, input.brandIds);

  const id = await nextId(tx, "user");
  const passwordHash = await bcrypt.hash(input.password, 10);
  const now = new Date();
  await tx.insert(users).values({ id, email: input.email, name: input.name, passwordHash, status: "active", createdAt: now, updatedAt: now });
  await tx.insert(userRoles).values({ userId: id, roleId: input.role });
  await tx.insert(userBrandAccess).values(brandIds.map((brandId) => ({ userId: id, brandId, grantedBy: viewer.id })));
  const agentCode = input.role === "sales_agent" ? await ensureAgentProfile(tx, id) : null;

  await logActivity(tx, {
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

export async function updateUser(tx: DbOrTx, viewer: Viewer, id: string, raw: UpdateUserInput) {
  const input = updateUserSchema.parse(raw);
  const [existing] = await tx.select().from(users).where(eq(users.id, id));
  if (!existing) throw new BusinessRuleError("User not found.");
  await assertEmailFree(tx, input.email, id);
  const [roleRows, brandRows] = await Promise.all([
    tx.select({ v: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, id)),
    tx.select({ v: userBrandAccess.brandId }).from(userBrandAccess).where(eq(userBrandAccess.userId, id)),
  ]);
  const beforeRole = roleRows.some((r) => r.v === "super_admin") ? "super_admin" : "sales_agent";
  const beforeBrands = brandRows.map((r) => r.v);
  const brandIds = await resolveBrands(tx, input.role, input.brandIds);

  if (id === viewer.id) {
    if (input.status !== "active") throw new BusinessRuleError("You cannot suspend your own account.", { status: ["You cannot suspend yourself."] });
    if (input.role !== beforeRole) throw new BusinessRuleError("You cannot change your own role.", { role: ["You cannot change your own role."] });
  }
  const losesSuperAdmin = beforeRole === "super_admin" && existing.status === "active" && (input.role !== "super_admin" || input.status !== "active");
  if (losesSuperAdmin && (await otherActiveSuperAdmins(tx, id)) === 0) {
    throw new BusinessRuleError("This is the last active Super Admin. Create or activate another Super Admin first.", { status: ["Last active Super Admin."] });
  }

  const changes: Changes = diffFields(
    { name: existing.name, email: existing.email, status: existing.status, role: beforeRole, brands: beforeBrands },
    { name: input.name, email: input.email, status: input.status, role: input.role, brands: brandIds },
  );
  if (Object.keys(changes).length === 0) return { changed: false, suspended: false };

  const now = new Date();
  await tx.update(users).set({ name: input.name, email: input.email, status: input.status, updatedAt: now }).where(eq(users.id, id));
  if (changes.role) {
    await tx.delete(userRoles).where(eq(userRoles.userId, id));
    await tx.insert(userRoles).values({ userId: id, roleId: input.role });
  }
  const b = setDiff(beforeBrands, brandIds);
  if (b.removed.length) await tx.delete(userBrandAccess).where(and(eq(userBrandAccess.userId, id), inArray(userBrandAccess.brandId, b.removed)));
  if (b.added.length) await tx.insert(userBrandAccess).values(b.added.map((brandId) => ({ userId: id, brandId, grantedBy: viewer.id })));
  if (input.role === "sales_agent") await ensureAgentProfile(tx, id);

  await logActivity(tx, {
    actorId: viewer.id,
    action: changes.role ? "user.role_changed" : "user.updated",
    entityType: "user",
    entityId: id,
    summary: `Updated ${existing.name}: ${Object.keys(changes).join(", ")}`,
    metadata: { changes },
  });
  const suspended = existing.status !== "suspended" && input.status === "suspended";
  if (suspended) {
    await logActivity(tx, { actorId: viewer.id, action: "user.suspended", entityType: "user", entityId: id, summary: `${existing.name} suspended; all sessions revoked` });
  } else if (existing.status === "suspended" && input.status === "active") {
    await logActivity(tx, { actorId: viewer.id, action: "user.reactivated", entityType: "user", entityId: id, summary: `${existing.name} reactivated` });
  }
  // Role / brand changes apply on the user's next request (the viewer is rebuilt from the DB each time).
  return { changed: true, suspended };
}


export async function resetUserPassword(tx: DbOrTx, viewer: Viewer, id: string, rawPassword: string) {
  const password = passwordSchema.parse(rawPassword);
  if (id === viewer.id) throw new BusinessRuleError("You can't reset your own password from the admin console.");
  const [existing] = await tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, id));
  if (!existing) throw new BusinessRuleError("User not found.");
  const passwordHash = await bcrypt.hash(password, 10);
  await tx.update(users).set({ passwordHash, failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() }).where(eq(users.id, id));
  await logActivity(tx, {
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

export async function updateSettings(tx: DbOrTx, viewer: Viewer, values: Record<string, unknown>) {
  const keys = Object.keys(values);
  if (!keys.length) return { changed: [] as string[] };
  const rows = await tx.select().from(systemSettings).where(inArray(systemSettings.key, keys));
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
    await tx.update(systemSettings).set({ value: u.to, updatedBy: viewer.id, updatedAt: now }).where(eq(systemSettings.key, u.key));
    await logActivity(tx, {
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
