import "server-only";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  activityLogs,
  brands,
  notifications,
  rolePermissions,
  roles,
  salesAgents,
  sessions,
  systemSettings,
  userBrandAccess,
  userLegalEntityAccess,
  userRoles,
  users } from "@/lib/db/schema";
import type { Viewer } from "@/lib/auth/viewer";
import { PAGE_SIZE } from "@/lib/filters";

/* ----------------------------------------------------------------- users */

export async function listRoles() {
  const db = await getDb();
  return db.select().from(roles).orderBy(asc(roles.createdAt), asc(roles.id));
}

export type UserFilters = { q: string; role: string | null; status: string | null; brand: string | null; page: number };

export async function listUsers(f: UserFilters) {
  const db = await getDb();
  const like = f.q ? `%${f.q.replace(/[%_]/g, "")}%` : null;
  const where = and(
    like ? or(ilike(users.name, like), ilike(users.email, like), ilike(users.id, like)) : undefined,
    f.status ? eq(users.status, f.status as never) : undefined,
    f.role ? sql`exists (select 1 from ${userRoles} where ${userRoles.userId} = ${users.id} and ${userRoles.roleId} = ${f.role})` : undefined,
    f.brand ? sql`exists (select 1 from ${userBrandAccess} where ${userBrandAccess.userId} = ${users.id} and ${userBrandAccess.brandId} = ${f.brand})` : undefined,
  );
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        title: users.title,
        status: users.status,
        mfaEnabled: users.mfaEnabled,
        lastLoginAt: users.lastLoginAt,
        lockedUntil: users.lockedUntil,
        createdAt: users.createdAt,
        agentCode: salesAgents.agentCode,
        team: salesAgents.team,
        monthlyTarget: salesAgents.monthlyTarget,
        roleIds: sql<string[]>`coalesce((select array_agg(${userRoles.roleId} order by ${userRoles.roleId}) from ${userRoles} where ${userRoles.userId} = ${users.id}), '{}')`,
        brandIds: sql<string[]>`coalesce((select array_agg(${userBrandAccess.brandId} order by ${userBrandAccess.brandId}) from ${userBrandAccess} where ${userBrandAccess.userId} = ${users.id}), '{}')`,
        entityIds: sql<string[]>`coalesce((select array_agg(${userLegalEntityAccess.legalEntityId} order by ${userLegalEntityAccess.legalEntityId}) from ${userLegalEntityAccess} where ${userLegalEntityAccess.userId} = ${users.id}), '{}')`,
        allEntities: sql<boolean>`exists (select 1 from ${userRoles} ur join ${rolePermissions} rp on rp.role_id = ur.role_id where ur.user_id = ${users.id} and rp.permission_key = 'entities.all_access')`,
      })
      .from(users)
      .leftJoin(salesAgents, eq(salesAgents.userId, users.id))
      .where(where)
      .orderBy(sql`case ${users.status} when 'active' then 0 when 'invited' then 1 else 2 end`, asc(users.name))
      .limit(PAGE_SIZE)
      .offset((f.page - 1) * PAGE_SIZE),
    db.select({ total: count() }).from(users).where(where),
  ]);
  return { rows, total };
}

export async function getUserDetail(id: string) {
  const db = await getDb();
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      title: users.title,
      status: users.status,
      mfaEnabled: users.mfaEnabled,
      lastLoginAt: users.lastLoginAt,
      failedLoginCount: users.failedLoginCount,
      lockedUntil: users.lockedUntil,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, id));
  if (!user) return null;
  const [roleRows, brandRows, entityRows, agent, sessionRows, audit, allAccess] = await Promise.all([
    db.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, id)),
    db.select({ brandId: userBrandAccess.brandId, grantedAt: userBrandAccess.grantedAt }).from(userBrandAccess).where(eq(userBrandAccess.userId, id)),
    db.select({ legalEntityId: userLegalEntityAccess.legalEntityId }).from(userLegalEntityAccess).where(eq(userLegalEntityAccess.userId, id)),
    db.select().from(salesAgents).where(eq(salesAgents.userId, id)).then((r) => r[0] ?? null),
    db
      .select({ createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt, ip: sessions.ip, userAgent: sessions.userAgent })
      .from(sessions)
      .where(and(eq(sessions.userId, id), gte(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.lastSeenAt)),
    db
      .select({
        id: activityLogs.id,
        action: activityLogs.action,
        summary: activityLogs.summary,
        entityType: activityLogs.entityType,
        entityId: activityLogs.entityId,
        createdAt: activityLogs.createdAt,
        actorId: activityLogs.actorId,
        actor: users.name,
        ip: activityLogs.ip,
      })
      .from(activityLogs)
      .leftJoin(users, eq(users.id, activityLogs.actorId))
      .where(or(eq(activityLogs.actorId, id), and(eq(activityLogs.entityType, "user"), eq(activityLogs.entityId, id))))
      .orderBy(desc(activityLogs.createdAt), desc(activityLogs.id))
      .limit(60),
    db
      .select({ n: count() })
      .from(userRoles)
      .innerJoin(rolePermissions, and(eq(rolePermissions.roleId, userRoles.roleId), eq(rolePermissions.permissionKey, "entities.all_access")))
      .where(eq(userRoles.userId, id)),
  ]);
  return {
    user,
    roleIds: roleRows.map((r) => r.roleId).sort(),
    brandIds: brandRows.map((r) => r.brandId).sort(),
    entityIds: entityRows.map((r) => r.legalEntityId).sort(),
    agent,
    sessions: sessionRows,
    audit,
    allEntities: (allAccess[0]?.n ?? 0) > 0,
  };
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

export function activityWhere(viewer: Viewer, f: ActivityFilters): SQL | undefined {
  const brandIds = viewer.brandIds.length ? viewer.brandIds : ["__none__"];
  return and(
    // Brand / LLC scoped entries are only visible within the auditor's own scope.
    or(isNull(activityLogs.brandId), inArray(activityLogs.brandId, brandIds)),
    viewer.entityIds === "all"
      ? undefined
      : or(isNull(activityLogs.legalEntityId), inArray(activityLogs.legalEntityId, viewer.entityIds.length ? viewer.entityIds : ["__none__"])),
    f.actor ? (f.actor === "system" ? isNull(activityLogs.actorId) : eq(activityLogs.actorId, f.actor)) : undefined,
    f.action ? ilike(activityLogs.action, `${f.action.replace(/[%_]/g, "")}%`) : undefined,
    f.entityType ? eq(activityLogs.entityType, f.entityType) : undefined,
    f.brand ? eq(activityLogs.brandId, f.brand) : undefined,
    f.from ? gte(activityLogs.createdAt, f.from) : undefined,
    f.to ? lte(activityLogs.createdAt, f.to) : undefined,
    f.q
      ? or(
          ilike(activityLogs.entityId, `%${f.q.replace(/[%_]/g, "")}%`),
          ilike(activityLogs.summary, `%${f.q.replace(/[%_]/g, "")}%`),
        )
      : undefined,
  );
}

export const ACTIVITY_PAGE_SIZE = 50;

export async function listActivity(viewer: Viewer, f: ActivityFilters) {
  const db = await getDb();
  const where = activityWhere(viewer, f);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: activityLogs.id,
        actorId: activityLogs.actorId,
        actor: users.name,
        action: activityLogs.action,
        entityType: activityLogs.entityType,
        entityId: activityLogs.entityId,
        brandId: activityLogs.brandId,
        legalEntityId: activityLogs.legalEntityId,
        summary: activityLogs.summary,
        metadata: activityLogs.metadata,
        ip: activityLogs.ip,
        createdAt: activityLogs.createdAt,
      })
      .from(activityLogs)
      .leftJoin(users, eq(users.id, activityLogs.actorId))
      .where(where)
      .orderBy(desc(activityLogs.createdAt), desc(activityLogs.id))
      .limit(ACTIVITY_PAGE_SIZE)
      .offset((f.page - 1) * ACTIVITY_PAGE_SIZE),
    db.select({ total: count() }).from(activityLogs).where(where),
  ]);
  return { rows, total };
}

export async function getActivityFacets() {
  const db = await getDb();
  const [prefixes, types, actors] = await Promise.all([
    db.execute<{ prefix: string; n: number }>(
      sql`select split_part(action, '.', 1) as prefix, count(*)::int as n from activity_logs group by 1 order by 1`,
    ),
    db.selectDistinct({ entityType: activityLogs.entityType }).from(activityLogs).orderBy(asc(activityLogs.entityType)),
    db.select({ id: users.id, name: users.name }).from(users).orderBy(asc(users.name)),
  ]);
  return {
    prefixes: prefixes.rows.map((r) => ({ value: `${r.prefix}.`, label: `${r.prefix}.* (${r.n})` })),
    entityTypes: types.map((t) => t.entityType),
    actors,
  };
}

/* ------------------------------------------------------------- settings */

export async function listSettings() {
  const db = await getDb();
  return db
    .select({
      key: systemSettings.key,
      value: systemSettings.value,
      description: systemSettings.description,
      updatedAt: systemSettings.updatedAt,
      updatedByName: users.name,
    })
    .from(systemSettings)
    .leftJoin(users, eq(users.id, systemSettings.updatedBy))
    .orderBy(asc(systemSettings.key));
}

/* -------------------------------------------------------- notifications */

export async function listNotifications(viewer: Viewer, opts: { unread: boolean; page: number }) {
  const db = await getDb();
  const where = and(eq(notifications.userId, viewer.id), opts.unread ? isNull(notifications.readAt) : undefined);
  const [rows, [{ total }], [{ unread }]] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(PAGE_SIZE)
      .offset((opts.page - 1) * PAGE_SIZE),
    db.select({ total: count() }).from(notifications).where(where),
    db.select({ unread: count() }).from(notifications).where(and(eq(notifications.userId, viewer.id), isNull(notifications.readAt))),
  ]);
  return { rows, total, unread };
}

/** Reference data for the create / edit user forms. */
export async function getUserFormContext(viewer: Viewer) {
  const db = await getDb();
  const brandRows = await db.select({ id: brands.id, name: brands.name }).from(brands).orderBy(asc(brands.name));
  return { brands: brandRows, viewerId: viewer.id };
}
