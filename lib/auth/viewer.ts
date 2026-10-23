import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  brands,
  rolePermissions,
  roles,
  userBrandAccess,
  userLegalEntityAccess,
  userRoles,
  users,
} from "@/lib/db/schema";
import type { Permission, RoleId } from "@/lib/domain/permissions";
import { readSessionUserId } from "./session";

/**
 * The authenticated principal for a request. Everything that decides what a
 * user may see or do derives from this object, which is always rebuilt from
 * the database — never from client-supplied data.
 */
export type Viewer = {
  id: string;
  name: string;
  email: string;
  title: string | null;
  roles: RoleId[];
  roleNames: string[];
  permissions: Set<Permission>;
  /** Brands whose records this user may see (incl. deactivated brands, for history). */
  brandIds: string[];
  /** Brands available for new sales, billing and recharge requests (active only). */
  activeBrandIds: string[];
  /** Legal entities this user may see, or "all". */
  entityIds: string[] | "all";
};

async function loadViewer(userId: string): Promise<Viewer | null> {
  const db = await getDb();
  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email, title: users.title, status: users.status })
    .from(users)
    .where(eq(users.id, userId));
  if (!user || user.status !== "active") return null;

  const [roleRows, brandRows, entityRows] = await Promise.all([
    db.select({ id: roles.id, name: roles.name }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, userId)),
    db.select({ brandId: userBrandAccess.brandId, status: brands.status }).from(userBrandAccess).innerJoin(brands, eq(brands.id, userBrandAccess.brandId)).where(eq(userBrandAccess.userId, userId)),
    db.select({ id: userLegalEntityAccess.legalEntityId }).from(userLegalEntityAccess).where(eq(userLegalEntityAccess.userId, userId)),
  ]);
  const roleIds = roleRows.map((r) => r.id);
  const permRows = roleIds.length
    ? await db.select({ key: rolePermissions.permissionKey }).from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds))
    : [];
  const permissions = new Set(permRows.map((p) => p.key as Permission));

  return {
    ...user,
    roles: roleIds as RoleId[],
    roleNames: roleRows.map((r) => r.name),
    permissions,
    brandIds: brandRows.map((b) => b.brandId).sort(),
    activeBrandIds: brandRows.filter((b) => b.status === "active").map((b) => b.brandId).sort(),
    entityIds: permissions.has("entities.all_access") ? "all" : entityRows.map((e) => e.id),
  };
}

/** Memoised per request render. Returns null when not signed in. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const userId = await readSessionUserId();
  return userId ? loadViewer(userId) : null;
});

/** For pages: redirects to /login when there is no valid session. */
export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  return viewer;
}

export function can(viewer: Viewer, ...perms: Permission[]): boolean {
  return perms.every((p) => viewer.permissions.has(p));
}

export function canAny(viewer: Viewer, ...perms: Permission[]): boolean {
  return perms.some((p) => viewer.permissions.has(p));
}

export class AuthorizationError extends Error {
  constructor(message = "You do not have permission to perform this action.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** For Server Actions / Route Handlers: throws instead of redirecting. */
export async function authorize(...perms: Permission[]): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) throw new AuthorizationError("Your session has expired. Please sign in again.");
  if (!can(viewer, ...perms)) throw new AuthorizationError();
  return viewer;
}

export function canAccessBrand(viewer: Viewer, brandId: string) {
  return viewer.brandIds.includes(brandId);
}

/** New transactions may only be recorded under an active, assigned brand. */
export function canTransactInBrand(viewer: Viewer, brandId: string) {
  return viewer.activeBrandIds.includes(brandId);
}

export function canAccessEntity(viewer: Viewer, entityId: string) {
  return viewer.entityIds === "all" || viewer.entityIds.includes(entityId);
}
