import "server-only";
import { cache } from "react";
import { getDb } from "@/lib/db";
import { ids } from "@/lib/db/query";
import type { BrandLite } from "@/components/crm/brand-badge";
import type { Viewer } from "@/lib/auth/viewer";

/** Reference lists, memoised per request. */
export const getAllBrands = cache(async () => {
  const C = await getDb();
  return C.brands.find({}, { sort: { name: 1 } }).toArray();
});

export async function getBrandMap(): Promise<Map<string, BrandLite>> {
  const list = await getAllBrands();
  return new Map(list.map((b) => [b.id, { id: b.id, code: b.code, name: b.name, color: b.color, logoUrl: b.logoUrl }]));
}

export async function getViewerBrands(viewer: Viewer, opts: { activeOnly?: boolean } = {}): Promise<BrandLite[]> {
  const list = await getAllBrands();
  const allowed = opts.activeOnly ? viewer.activeBrandIds : viewer.brandIds;
  return list
    .filter((b) => allowed.includes(b.id))
    .map((b) => ({ id: b.id, code: b.code, name: b.name, color: b.color, logoUrl: b.logoUrl }));
}

export const getAgents = cache(async () => {
  const C = await getDb();
  const agents = await C.salesAgents.find().toArray();
  const userIds = agents.map((a) => a.userId);
  const [people, access] = await Promise.all([
    C.users.find({ id: { $in: ids(userIds) } }, { projection: { id: 1, name: 1, email: 1, status: 1 } }).toArray(),
    C.userBrandAccess.find({ userId: { $in: ids(userIds) } }).toArray(),
  ]);
  return agents
    .flatMap((a) => {
      const u = people.find((p) => p.id === a.userId);
      return u
        ? [{ id: u.id, name: u.name, email: u.email, status: u.status, agentCode: a.agentCode, team: a.team, monthlyTarget: a.monthlyTarget }]
        : [];
    })
    .sort((x, y) => x.name.localeCompare(y.name))
    .map((r) => ({ ...r, brandIds: access.filter((a) => a.userId === r.id).map((a) => a.brandId) }));
});

/** Agents that share at least one brand with the viewer (for filter dropdowns). */
export async function getAgentOptions(viewer: Viewer) {
  const list = await getAgents();
  return list
    .filter((a) => a.brandIds.some((b) => viewer.brandIds.includes(b)))
    .map((a) => ({ value: a.id, label: a.name + (a.status !== "active" ? " (suspended)" : "") }));
}

export const getUserNames = cache(async () => {
  const C = await getDb();
  const rows = await C.users.find({}, { projection: { id: 1, name: 1 } }).toArray();
  return new Map(rows.map((r) => [r.id, r.name]));
});

export function brandOptions(list: BrandLite[]) {
  return list.map((b) => ({ value: b.id, label: b.name }));
}
