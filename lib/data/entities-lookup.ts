import "server-only";
import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { getDb, type DbOrTx } from "@/lib/db";
import { brandLegalEntities, legalEntities } from "@/lib/db/schema";

export type EntityScope = "sale" | "chargeback";

export type PermittedEntity = {
  id: string;
  registeredName: string;
  internalCode: string;
  jurisdiction: string;
  baseCurrency: string;
  /** True for the mapping marked default (or the first permitted entity when none is flagged). */
  isDefault: boolean;
  /** Mapping rows that grant this entity (an entity may be mapped via 'sale' and 'all'). */
  mappingIds: string[];
  /** The scope of the mapping row(s) — 'sale' | 'chargeback' | 'all'. */
  scopes: string[];
};

/** Ledger type an entity must be allowed to book for each mapping scope. */
const REQUIRED_TXN_TYPE: Record<EntityScope, string> = { sale: "payment", chargeback: "chargeback" };

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Resolves the legal entities permitted for a brand + transaction scope on a
 * given date, from the configurable `brand_legal_entities` mapping.
 *
 * - Mapping rows with scope = `scope` or 'all' whose effective window
 *   (effective_from ≤ at ≤ effective_to, open-ended when null) contains `at`.
 * - Only `active` entities whose `permitted_transaction_types` include the
 *   ledger type for that scope (payment for sales, chargeback for chargebacks).
 * - Sorted default first, then by id. Exactly one result has `isDefault`
 *   (the flagged default, otherwise the first) — empty list when unmapped.
 *
 * Pass `db` when calling inside a transaction (PGlite has one connection).
 */
export async function getPermittedEntities(brandId: string, scope: EntityScope, at: Date, db?: DbOrTx): Promise<PermittedEntity[]> {
  const conn = db ?? (await getDb());
  const day = isoDay(at);
  const rows = await conn
    .select({
      mappingId: brandLegalEntities.id,
      scope: brandLegalEntities.scope,
      isDefault: brandLegalEntities.isDefault,
      id: legalEntities.id,
      registeredName: legalEntities.registeredName,
      internalCode: legalEntities.internalCode,
      jurisdiction: legalEntities.jurisdiction,
      baseCurrency: legalEntities.baseCurrency,
      permittedTypes: legalEntities.permittedTransactionTypes,
    })
    .from(brandLegalEntities)
    .innerJoin(legalEntities, eq(legalEntities.id, brandLegalEntities.legalEntityId))
    .where(
      and(
        eq(brandLegalEntities.brandId, brandId),
        inArray(brandLegalEntities.scope, [scope, "all"]),
        lte(brandLegalEntities.effectiveFrom, day),
        or(isNull(brandLegalEntities.effectiveTo), gte(brandLegalEntities.effectiveTo, day)),
        eq(legalEntities.status, "active"),
      ),
    )
    .orderBy(asc(legalEntities.id));

  const byId = new Map<string, PermittedEntity>();
  for (const r of rows) {
    if (!r.permittedTypes.includes(REQUIRED_TXN_TYPE[scope])) continue;
    const existing = byId.get(r.id);
    if (existing) {
      existing.isDefault ||= r.isDefault;
      existing.mappingIds.push(r.mappingId);
      if (!existing.scopes.includes(r.scope)) existing.scopes.push(r.scope);
      continue;
    }
    byId.set(r.id, {
      id: r.id,
      registeredName: r.registeredName,
      internalCode: r.internalCode,
      jurisdiction: r.jurisdiction,
      baseCurrency: r.baseCurrency,
      isDefault: r.isDefault,
      mappingIds: [r.mappingId],
      scopes: [r.scope],
    });
  }
  const list = [...byId.values()];
  // Brands without any mapping (e.g. newly created ones) fall back to every active
  // LLC that may book this transaction type, so financial records always carry one.
  if (list.length === 0) {
    const fallback = await conn.select().from(legalEntities).where(eq(legalEntities.status, "active")).orderBy(asc(legalEntities.id));
    for (const e of fallback) {
      if (!e.permittedTransactionTypes.includes(REQUIRED_TXN_TYPE[scope])) continue;
      list.push({
        id: e.id,
        registeredName: e.registeredName,
        internalCode: e.internalCode,
        jurisdiction: e.jurisdiction,
        baseCurrency: e.baseCurrency,
        isDefault: false,
        mappingIds: [],
        scopes: [],
      });
    }
  }
  // Exactly one default: prefer a scope-specific default over an 'all' default.
  const defaults = list.filter((e) => e.isDefault);
  const chosen = defaults.find((e) => e.scopes.includes(scope)) ?? defaults[0] ?? list[0];
  for (const e of list) e.isDefault = e === chosen;
  return list.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id));
}

/** Convenience: the default permitted entity, or null when the brand has no mapping for that date. */
export async function getDefaultEntity(brandId: string, scope: EntityScope, at: Date, db?: DbOrTx) {
  const list = await getPermittedEntities(brandId, scope, at, db);
  return list.find((e) => e.isDefault) ?? null;
}
