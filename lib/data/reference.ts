import "server-only";
import { cache } from "react";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { brands, salesAgents, userBrandAccess, users } from "@/lib/db/schema";
import type { BrandLite } from "@/components/crm/brand-badge";
import type { Viewer } from "@/lib/auth/viewer";

/** Reference lists, memoised per request. */
export const getAllBrands = cache(async () => {
  const db = await getDb();
  return db.select().from(brands).orderBy(asc(brands.name));
});

export async function getBrandMap(): Promise<Map<string, BrandLite>> {
  const list = await getAllBrands();
  return new Map(list.map((b) => [b.id, { id: b.id, code: b.code, name: b.name, color: b.color, logoUrl: b.logoUrl }]));
}

export async function getViewerBrands(viewer: Viewer, opts: { activeOnly?: boolean } = {}): Promise<BrandLite[]> {
  const list = await getAllBrands();
  const ids = opts.activeOnly ? viewer.activeBrandIds : viewer.brandIds;
  return list
    .filter((b) => ids.includes(b.id))
    .map((b) => ({ id: b.id, code: b.code, name: b.name, color: b.color, logoUrl: b.logoUrl }));
}

export const getAgents = cache(async () => {
  const db = await getDb();
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      status: users.status,
      agentCode: salesAgents.agentCode,
      team: salesAgents.team,
      monthlyTarget: salesAgents.monthlyTarget,
    })
    .from(salesAgents)
    .innerJoin(users, eq(users.id, salesAgents.userId))
    .orderBy(asc(users.name));
  const access = await db.select().from(userBrandAccess).where(inArray(userBrandAccess.userId, rows.map((r) => r.id).concat("__none__")));
  return rows.map((r) => ({ ...r, brandIds: access.filter((a) => a.userId === r.id).map((a) => a.brandId) }));
});

/** Agents that share at least one brand with the viewer (for filter dropdowns). */
export async function getAgentOptions(viewer: Viewer) {
  const list = await getAgents();
  return list
    .filter((a) => a.brandIds.some((b) => viewer.brandIds.includes(b)))
    .map((a) => ({ value: a.id, label: a.name + (a.status !== "active" ? " (suspended)" : "") }));
}

export const getUserNames = cache(async () => {
  const db = await getDb();
  const rows = await db.select({ id: users.id, name: users.name }).from(users);
  return new Map(rows.map((r) => [r.id, r.name]));
});

export function brandOptions(list: BrandLite[]) {
  return list.map((b) => ({ value: b.id, label: b.name }));
}
