import "server-only";
import type { Filter } from "mongodb";
import { getDb, type RowOf } from "@/lib/db";
import { contains, ids, uniq } from "@/lib/db/query";
import type { Viewer } from "@/lib/auth/viewer";
import { PAGE_SIZE } from "@/lib/filters";

/* ----------------------------------------------------------------- users */

export async function listRoles() {
  const C = await getDb();
  return C.roles.find({}, { sort: { createdAt: 1, id: 1 } }).toArray();
}

export type UserFilters = { q: string; role: string | null; status: string | null; brand: string | null; page: number };

const STATUS_ORDER: Record<string, number> = { active: 0, invited: 1 };

export async function listUsers(f: UserFilters) {
  const C = await getDb();
  const q = f.q.replace(/[%_]/g, "");
  const conds: Filter<RowOf<"users">>[] = [];
  if (q) conds.push({ $or: [{ name: contains(q) }, { email: contains(q) }, { id: contains(q) }] });
  if (f.status) conds.push({ status: f.status as never });
  if (f.role) conds.push({ id: { $in: ids(await C.userRoles.distinct("userId", { roleId: f.role })) } });
  if (f.brand) conds.push({ id: { $in: ids(await C.userBrandAccess.distinct("userId", { brandId: f.brand })) } });
  const where: Filter<RowOf<"users">> = conds.length ? { $and: conds } : {};

  // Sorting by status rank then name: small collection, sort in JS after fetching matching ids.
  const all = await C.users.find(where, { projection: { passwordHash: 0 } }).toArray();
  all.sort((a, b) => (STATUS_ORDER[a.status] ?? 2) - (STATUS_ORDER[b.status] ?? 2) || a.name.localeCompare(b.name));
  const total = all.length;
  const page = all.slice((f.page - 1) * PAGE_SIZE, f.page * PAGE_SIZE);
  const userIds = page.map((u) => u.id);
  const [agents, roleRows, brandRows, entityRows, allRoles] = await Promise.all([
    C.salesAgents.find({ userId: { $in: ids(userIds) } }).toArray(),
    C.userRoles.find({ userId: { $in: ids(userIds) } }).toArray(),
    C.userBrandAccess.find({ userId: { $in: ids(userIds) } }).toArray(),
    C.userLegalEntityAccess.find({ userId: { $in: ids(userIds) } }).toArray(),
    C.rolePermissions.distinct("roleId", { permissionKey: "entities.all_access" }),
  ]);
  const rows = page.map((u) => {
    const agent = agents.find((a) => a.userId === u.id);
    const roleIds = roleRows.filter((r) => r.userId === u.id).map((r) => r.roleId).sort();
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      title: u.title,
      status: u.status,
      mfaEnabled: u.mfaEnabled,
      lastLoginAt: u.lastLoginAt,
      lockedUntil: u.lockedUntil,
      createdAt: u.createdAt,
      agentCode: agent?.agentCode ?? null,
      team: agent?.team ?? null,
      monthlyTarget: agent?.monthlyTarget ?? null,
      roleIds,
      brandIds: brandRows.filter((r) => r.userId === u.id).map((r) => r.brandId).sort(),
      entityIds: entityRows.filter((r) => r.userId === u.id).map((r) => r.legalEntityId).sort(),
      allEntities: roleIds.some((r) => allRoles.includes(r)),
    };
  });
  return { rows, total };
}

export async function getUserDetail(id: string) {
  const C = await getDb();
  const u = await C.users.findOne({ id }, { projection: { passwordHash: 0 } });
  if (!u) return null;
  const user = {
    id: u.id,
    name: u.name,
    email: u.email,
    title: u.title,
    status: u.status,
    mfaEnabled: u.mfaEnabled,
    lastLoginAt: u.lastLoginAt,
    failedLoginCount: u.failedLoginCount,
    lockedUntil: u.lockedUntil,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
  const [roleRows, brandRows, entityRows, agent, sessionRows, auditRows, allRoles] = await Promise.all([
    C.userRoles.find({ userId: id }).toArray(),
    C.userBrandAccess.find({ userId: id }).toArray(),
    C.userLegalEntityAccess.find({ userId: id }).toArray(),
    C.salesAgents.findOne({ userId: id }),
    C.sessions.find({ userId: id, expiresAt: { $gte: new Date() } }, { sort: { lastSeenAt: -1 } }).toArray(),
    C.activityLogs
      .find({ $or: [{ actorId: id }, { entityType: "user", entityId: id }] }, { sort: { createdAt: -1, id: -1 }, limit: 60 })
      .toArray(),
    C.rolePermissions.distinct("roleId", { permissionKey: "entities.all_access" }),
  ]);
  const names = await actorNames(uniq(auditRows.map((a) => a.actorId)));
  const roleIds = roleRows.map((r) => r.roleId).sort();
  return {
    user,
    roleIds,
    brandIds: brandRows.map((r) => r.brandId).sort(),
    entityIds: entityRows.map((r) => r.legalEntityId).sort(),
    agent,
    sessions: sessionRows.map((s) => ({ createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt, ip: s.ip, userAgent: s.userAgent })),
    audit: auditRows.map((a) => ({
      id: a.id,
      action: a.action,
      summary: a.summary,
      entityType: a.entityType,
      entityId: a.entityId,
      createdAt: a.createdAt,
      actorId: a.actorId,
      actor: a.actorId ? (names.get(a.actorId) ?? null) : null,
      ip: a.ip,
    })),
    allEntities: roleIds.some((r) => allRoles.includes(r)),
  };
}

async function actorNames(userIds: string[]) {
  const C = await getDb();
  const rows = await C.users.find({ id: { $in: ids(userIds) } }, { projection: { id: 1, name: 1 } }).toArray();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/* ------------------------------------------------------------- activity */

export type ActivityFilters = {
  q: string;
  actor: string | null;
  action: string | null;
  entityType: string | null;
  brand: string | null;
  from: Date | null;
  to: Date | null;
  page: number;
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function activityWhere(viewer: Viewer, f: ActivityFilters): Filter<RowOf<"activityLogs">> {
  const conds: Filter<RowOf<"activityLogs">>[] = [
    // Brand / LLC scoped entries are only visible within the auditor's own scope.
    { $or: [{ brandId: null }, { brandId: { $in: ids(viewer.brandIds) } }] },
  ];
  if (viewer.entityIds !== "all") conds.push({ $or: [{ legalEntityId: null }, { legalEntityId: { $in: ids(viewer.entityIds) } }] });
  if (f.actor) conds.push(f.actor === "system" ? { actorId: null } : { actorId: f.actor });
  if (f.action) conds.push({ action: new RegExp(`^${escape(f.action.replace(/[%_]/g, ""))}`, "i") });
  if (f.entityType) conds.push({ entityType: f.entityType });
  if (f.brand) conds.push({ brandId: f.brand });
  if (f.from || f.to) conds.push({ createdAt: { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) } });
  const q = f.q.replace(/[%_]/g, "");
  if (q) conds.push({ $or: [{ entityId: contains(q) }, { summary: contains(q) }] });
  return { $and: conds };
}

export const ACTIVITY_PAGE_SIZE = 50;

export async function listActivity(viewer: Viewer, f: ActivityFilters) {
  const C = await getDb();
  const where = activityWhere(viewer, f);
  const [list, total] = await Promise.all([
    C.activityLogs
      .find(where, { sort: { createdAt: -1, id: -1 }, skip: (f.page - 1) * ACTIVITY_PAGE_SIZE, limit: ACTIVITY_PAGE_SIZE })
      .toArray(),
    C.activityLogs.countDocuments(where),
  ]);
  const names = await actorNames(uniq(list.map((r) => r.actorId)));
  const rows = list.map((r) => ({
    id: r.id,
    actorId: r.actorId,
    actor: r.actorId ? (names.get(r.actorId) ?? null) : null,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    brandId: r.brandId,
    legalEntityId: r.legalEntityId,
    summary: r.summary,
    metadata: r.metadata,
    ip: r.ip,
    createdAt: r.createdAt,
  }));
  return { rows, total };
}

export async function getActivityFacets() {
  const C = await getDb();
  const [prefixes, types, actors] = await Promise.all([
    C.activityLogs
      .aggregate<{ _id: string; n: number }>([
        { $group: { _id: { $arrayElemAt: [{ $split: ["$action", "."] }, 0] }, n: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
    C.activityLogs.distinct("entityType"),
    C.users.find({}, { sort: { name: 1 }, projection: { id: 1, name: 1 } }).toArray(),
  ]);
  return {
    prefixes: prefixes.map((r) => ({ value: `${r._id}.`, label: `${r._id}.* (${r.n})` })),
    entityTypes: [...types].sort(),
    actors: actors.map((a) => ({ id: a.id, name: a.name })),
  };
}

/* ------------------------------------------------------------- settings */

export async function listSettings() {
  const C = await getDb();
  const rows = await C.systemSettings.find({}, { sort: { key: 1 } }).toArray();
  const names = await actorNames(uniq(rows.map((r) => r.updatedBy)));
  return rows.map((r) => ({
    key: r.key,
    value: r.value,
    description: r.description,
    updatedAt: r.updatedAt,
    updatedByName: r.updatedBy ? (names.get(r.updatedBy) ?? null) : null,
  }));
}

/* -------------------------------------------------------- notifications */

export async function listNotifications(viewer: Viewer, opts: { unread: boolean; page: number }) {
  const C = await getDb();
  const where: Filter<RowOf<"notifications">> = opts.unread ? { userId: viewer.id, readAt: null } : { userId: viewer.id };
  const [rows, total, unread] = await Promise.all([
    C.notifications.find(where, { sort: { createdAt: -1, id: -1 }, skip: (opts.page - 1) * PAGE_SIZE, limit: PAGE_SIZE }).toArray(),
    C.notifications.countDocuments(where),
    C.notifications.countDocuments({ userId: viewer.id, readAt: null }),
  ]);
  return { rows, total, unread };
}

/** Reference data for the create / edit user forms. */
export async function getUserFormContext(viewer: Viewer) {
  const C = await getDb();
  const brandRows = await C.brands.find({}, { sort: { name: 1 }, projection: { id: 1, name: 1 } }).toArray();
  return { brands: brandRows.map((b) => ({ id: b.id, name: b.name })), viewerId: viewer.id };
}
