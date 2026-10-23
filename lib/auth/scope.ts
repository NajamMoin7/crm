import "server-only";
import { cookies } from "next/headers";
import type { Filter } from "mongodb";
import { getDb, type RowOf } from "@/lib/db";
import { ids, NONE } from "@/lib/db/query";
import { can, type Viewer } from "./viewer";

/**
 * Record-level scoping. Every list/detail query composes one of these filters
 * so that brand, legal-entity and ownership restrictions are enforced in the
 * database query itself — a user cannot reach other records by editing URLs or
 * request parameters.
 */

/** Narrow the viewer's brands by an optional requested brand (ignored if not permitted). */
export function brandFilter(viewer: Viewer, requested?: string | null): string[] {
  if (requested && requested !== "all") return viewer.brandIds.includes(requested) ? [requested] : [NONE];
  return ids(viewer.brandIds);
}

const entityIn = (viewer: Viewer) => (viewer.entityIds === "all" ? undefined : { $in: ids(viewer.entityIds) });

/** Drops undefined keys so optional conditions read naturally. */
function clean<T>(f: Record<string, unknown>): Filter<T> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as Filter<T>;
}

export function scopeSales(viewer: Viewer, brand?: string | null): Filter<RowOf<"sales">> {
  return clean({
    brandId: { $in: brandFilter(viewer, brand) },
    legalEntityId: entityIn(viewer),
    agentId: can(viewer, "sales.view_all") ? undefined : viewer.id,
  });
}

export function scopeInvoices(viewer: Viewer, brand?: string | null): Filter<RowOf<"invoices">> {
  return clean({
    brandId: { $in: brandFilter(viewer, brand) },
    legalEntityId: entityIn(viewer),
    agentId: can(viewer, "billing.view_all") ? undefined : viewer.id,
  });
}

export function scopeTransactions(viewer: Viewer, brand?: string | null): Filter<RowOf<"transactions">> {
  return clean({ brandId: { $in: brandFilter(viewer, brand) }, legalEntityId: entityIn(viewer) });
}

export function scopeCases(viewer: Viewer, brand?: string | null): Filter<RowOf<"chargebackCases">> {
  const entities = entityIn(viewer);
  return clean({
    brandId: { $in: brandFilter(viewer, brand) },
    $or: entities ? [{ originalLegalEntityId: entities }, { responsibleLegalEntityId: entities }] : undefined,
    requestedBy: can(viewer, "chargebacks.view_all") ? undefined : viewer.id,
  });
}

/**
 * Customers are visible when linked to one of the viewer's brands and — for
 * users without customers.view_all — assigned to them or sold to by them.
 * Merged / archived records are excluded unless `includeMerged`.
 * (Async: brand links and sales live in their own collections.)
 */
export async function scopeCustomers(
  viewer: Viewer,
  brand?: string | null,
  opts: { includeMerged?: boolean } = {},
): Promise<Filter<RowOf<"customers">>> {
  const C = await getDb();
  const brandIds = brandFilter(viewer, brand);
  const inBrands = await C.customerBrandRelationships.distinct("customerId", { brandId: { $in: brandIds } });
  // New customers aren't linked to a brand until their first sale; they show
  // up when no specific brand is selected (ownership rules still apply below).
  const brandCond: Filter<RowOf<"customers">> =
    brand && brand !== "all"
      ? { id: { $in: ids(inBrands) } }
      : { $or: [{ id: { $in: ids(inBrands) } }, { id: { $nin: await C.customerBrandRelationships.distinct("customerId") } }] };
  const conds: Filter<RowOf<"customers">>[] = [brandCond];
  if (!opts.includeMerged) conds.push({ mergedIntoId: null });
  if (!can(viewer, "customers.view_all")) {
    const soldTo = await C.sales.distinct("customerId", { agentId: viewer.id });
    conds.push({ $or: [{ assignedAgentId: viewer.id }, { id: { $in: ids(soldTo) } }] });
  }
  return { $and: conds };
}

/* ------------------------------------------------- active brand context */

export const ACTIVE_BRAND_COOKIE = "crm_brand";

/** The brand chosen in the top-bar selector ("all" or a permitted brand id). */
export async function getActiveBrand(viewer: Viewer): Promise<string> {
  const value = (await cookies()).get(ACTIVE_BRAND_COOKIE)?.value;
  return value && viewer.brandIds.includes(value) ? value : "all";
}

/** URL `brand` param wins over the global selector; both are validated. */
export async function resolveBrand(viewer: Viewer, param?: string | string[] | null): Promise<string> {
  const p = Array.isArray(param) ? param[0] : param;
  if (p === "all") return "all";
  // An explicitly requested brand is kept even when not permitted: brandFilter()
  // then matches nothing, instead of silently showing other brands' records.
  if (p) return p.slice(0, 40);
  return getActiveBrand(viewer);
}
