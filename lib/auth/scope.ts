import "server-only";
import { and, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { cookies } from "next/headers";
import {
  chargebackCases,
  customerBrandRelationships,
  customers,
  invoices,
  sales,
  transactions } from "@/lib/db/schema";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { can, type Viewer } from "./viewer";

/**
 * Row-level scoping. Every list/detail query composes one of these so that
 * brand, legal-entity and ownership restrictions are enforced in SQL — a user
 * cannot reach other records by editing URLs or request parameters.
 * (For production, mirror these rules with PostgreSQL row-level security.)
 */

const NONE = "__none__";
const ids = (list: string[]) => (list.length ? list : [NONE]);

/** Narrow the viewer's brands by an optional requested brand (ignored if not permitted). */
export function brandFilter(viewer: Viewer, requested?: string | null): string[] {
  if (requested && requested !== "all") return viewer.brandIds.includes(requested) ? [requested] : [NONE];
  return ids(viewer.brandIds);
}

function entityCond(viewer: Viewer, col: AnyPgColumn): SQL | undefined {
  return viewer.entityIds === "all" ? undefined : inArray(col, ids(viewer.entityIds));
}

export function scopeSales(viewer: Viewer, brand?: string | null): SQL {
  return and(
    inArray(sales.brandId, brandFilter(viewer, brand)),
    entityCond(viewer, sales.legalEntityId),
    can(viewer, "sales.view_all") ? undefined : eq(sales.agentId, viewer.id),
  )!;
}

export function scopeInvoices(viewer: Viewer, brand?: string | null): SQL {
  return and(
    inArray(invoices.brandId, brandFilter(viewer, brand)),
    entityCond(viewer, invoices.legalEntityId),
    can(viewer, "billing.view_all") ? undefined : eq(invoices.agentId, viewer.id),
  )!;
}

export function scopeTransactions(viewer: Viewer, brand?: string | null): SQL {
  return and(inArray(transactions.brandId, brandFilter(viewer, brand)), entityCond(viewer, transactions.legalEntityId))!;
}

export function scopeCases(viewer: Viewer, brand?: string | null): SQL {
  const entityIds = viewer.entityIds;
  return and(
    inArray(chargebackCases.brandId, brandFilter(viewer, brand)),
    entityIds === "all"
      ? undefined
      : or(
          inArray(chargebackCases.originalLegalEntityId, ids(entityIds)),
          inArray(chargebackCases.responsibleLegalEntityId, ids(entityIds)),
        ),
    can(viewer, "chargebacks.view_all") ? undefined : eq(chargebackCases.requestedBy, viewer.id),
  )!;
}

/**
 * Customers are visible when linked to one of the viewer's brands and — for
 * users without customers.view_all — assigned to them or sold to by them.
 * Merged / archived records are excluded unless `includeMerged`.
 */
export function scopeCustomers(viewer: Viewer, brand?: string | null, opts: { includeMerged?: boolean } = {}): SQL {
  const brandIds = brandFilter(viewer, brand);
  const inBrands = exists(
    sql`(select 1 from ${customerBrandRelationships} where ${customerBrandRelationships.customerId} = ${customers.id} and ${inArray(customerBrandRelationships.brandId, brandIds)})`,
  );
  // New customers aren't linked to a brand until their first sale; they show
  // up when no specific brand is selected (ownership rules still apply below).
  const noBrandYet = sql`not exists (select 1 from ${customerBrandRelationships} where ${customerBrandRelationships.customerId} = ${customers.id})`;
  return and(
    brand && brand !== "all" ? inBrands : or(inBrands, noBrandYet),
    opts.includeMerged ? undefined : isNull(customers.mergedIntoId),
    can(viewer, "customers.view_all")
      ? undefined
      : or(
          eq(customers.assignedAgentId, viewer.id),
          exists(sql`(select 1 from ${sales} where ${sales.customerId} = ${customers.id} and ${sales.agentId} = ${viewer.id})`),
        ),
  )!;
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
