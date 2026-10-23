/**
 * Indexes for every collection: a unique index on each table's primary key
 * (taken from schema.ts), the unique business rules, and the lookup indexes the
 * queries rely on. `createIndexes` is idempotent, so this runs on every local
 * start and once from `npm run db:setup` for a hosted database.
 */
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Db, IndexDescription } from "mongodb";
import { TABLES, collectionName, type TableKey } from "./collections";

const ci = { locale: "en", strength: 2 } as const; // case-insensitive
const hasString = (field: string) => ({ partialFilterExpression: { [field]: { $type: "string" } } });

const EXTRA: Partial<Record<TableKey, IndexDescription[]>> = {
  users: [{ key: { email: 1 }, unique: true, collation: ci, name: "users_email_uq" }],
  sessions: [{ key: { userId: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: "sessions_ttl" }],
  brands: [
    { key: { code: 1 }, unique: true },
    { key: { invoicePrefix: 1 }, unique: true },
  ],
  legalEntities: [{ key: { internalCode: 1 }, unique: true }],
  brandLegalEntities: [{ key: { brandId: 1 } }, { key: { legalEntityId: 1 } }],
  productsServices: [{ key: { brandId: 1, sku: 1 }, unique: true }],
  salesAgents: [{ key: { agentCode: 1 }, unique: true }],
  customers: [
    { key: { email: 1 }, collation: ci },
    { key: { phoneNormalized: 1 } },
    { key: { assignedAgentId: 1 } },
    { key: { fullName: 1 }, collation: ci },
  ],
  customerBrandRelationships: [{ key: { brandId: 1 } }],
  duplicateCandidates: [{ key: { customerAId: 1, customerBId: 1 }, unique: true }],
  leads: [{ key: { brandId: 1, stage: 1 } }, { key: { assignedAgentId: 1 } }],
  sales: [{ key: { brandId: 1, saleDate: -1 } }, { key: { agentId: 1 } }, { key: { customerId: 1 } }],
  saleItems: [{ key: { saleId: 1 } }],
  invoices: [
    { key: { invoiceNumber: 1 }, unique: true },
    { key: { brandId: 1, billingDate: -1 } },
    { key: { customerId: 1 } },
    { key: { saleId: 1 } },
    { key: { status: 1 } },
  ],
  invoiceItems: [{ key: { invoiceId: 1 } }],
  transactions: [
    { key: { paymentReference: 1 }, unique: true, ...hasString("paymentReference") },
    { key: { type: 1, occurredAt: -1 } },
    { key: { invoiceId: 1 } },
    { key: { customerId: 1 } },
    { key: { relatedTransactionId: 1 } },
  ],
  chargebackCases: [{ key: { status: 1 } }, { key: { brandId: 1 } }, { key: { originalTransactionId: 1 } }, { key: { requestedBy: 1 } }, { key: { invoiceId: 1 } }],
  chargebackEvents: [{ key: { caseId: 1, createdAt: 1 } }],
  financialAdjustments: [{ key: { status: 1 } }, { key: { invoiceId: 1 } }],
  notes: [{ key: { entityType: 1, entityId: 1 } }],
  tasks: [{ key: { assigneeId: 1, status: 1 } }],
  activityLogs: [{ key: { entityType: 1, entityId: 1 } }, { key: { createdAt: -1 } }, { key: { actorId: 1 } }],
  notifications: [{ key: { userId: 1, readAt: 1 } }],
  integrationSources: [{ key: { brandId: 1 }, unique: true }],
  integrationRuns: [{ key: { sourceId: 1, startedAt: -1 } }],
  externalRecordMappings: [{ key: { sourceId: 1, entityType: 1, externalId: 1 }, unique: true }],
};

/** Field names of the table's primary key (single column or composite). */
export function primaryKeyOf(k: TableKey): string[] {
  const cfg = getTableConfig(TABLES[k]);
  const composite = cfg.primaryKeys[0];
  if (composite) {
    const byName = new Map(Object.entries(TABLES[k]).filter(([, v]) => v && typeof v === "object" && "name" in v).map(([f, v]) => [(v as { name: string }).name, f]));
    return composite.columns.map((c) => byName.get(c.name) ?? c.name);
  }
  const fields = Object.entries(TABLES[k]).filter(([, v]) => (v as { primary?: boolean })?.primary);
  return fields.map(([f]) => f);
}

export async function ensureIndexes(db: Db) {
  for (const k of Object.keys(TABLES) as TableKey[]) {
    const pk = primaryKeyOf(k);
    const specs: IndexDescription[] = [
      ...(pk.length ? [{ key: Object.fromEntries(pk.map((f) => [f, 1 as const])), unique: true, name: "pk" }] : []),
      ...(EXTRA[k] ?? []),
    ];
    await db.collection(collectionName(k)).createIndexes(specs);
  }
}
