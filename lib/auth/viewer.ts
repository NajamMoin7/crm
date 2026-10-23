import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
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
  const C = await getDb();
  const user = await C.users.findOne({ id: userId }, { projection: { id: 1, name: 1, email: 1, title: 1, status: 1 } });
  if (!user || user.status !== "active") return null;

  const [userRoles, access, entityRows] = await Promise.all([
    C.userRoles.find({ userId }).toArray(),
    C.userBrandAccess.find({ userId }).toArray(),
    C.userLegalEntityAccess.find({ userId }).toArray(),
  ]);
  const roleIds = userRoles.map((r) => r.roleId);
  const [roleRows, brandRows, permRows] = await Promise.all([
    C.roles.find({ id: { $in: roleIds } }, { projection: { id: 1, name: 1 } }).toArray(),
    C.brands.find({ id: { $in: access.map((a) => a.brandId) } }, { projection: { id: 1, status: 1 } }).toArray(),
    roleIds.length ? C.rolePermissions.find({ roleId: { $in: roleIds } }).toArray() : Promise.resolve([]),
  ]);
  const permissions = new Set(permRows.map((p) => p.permissionKey as Permission));

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    title: user.title,
    roles: roleIds as RoleId[],
    roleNames: roleIds.map((id) => roleRows.find((r) => r.id === id)?.name ?? id),
    permissions,
    brandIds: brandRows.map((b) => b.id).sort(),
    activeBrandIds: brandRows.filter((b) => b.status === "active").map((b) => b.id).sort(),
    entityIds: permissions.has("entities.all_access") ? "all" : entityRows.map((e) => e.legalEntityId),
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
