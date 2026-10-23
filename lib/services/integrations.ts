import "server-only";
import { z } from "zod";
import { count, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db";
import { brands, externalRecordMappings, integrationRuns, integrationSources } from "@/lib/db/schema";
import { nextId } from "@/lib/db/ids";
import { logActivity, notify } from "@/lib/audit";
import { BusinessRuleError } from "@/lib/actions";
import type { Viewer } from "@/lib/auth/viewer";
import { readSyncConfig } from "@/lib/data/brands";
import { diffFields } from "@/lib/services/admin";

export const SYNC_ENTITIES = ["customers", "invoices", "payments", "chargebacks", "products", "leads"] as const;
export const SIMULATED_TEST_MESSAGE = "Simulated — credentials not configured; no live system contacted";

export const syncConfigSchema = z.object({
  mode: z.enum(["pull", "webhook"]),
  schedule: z.enum(["manual", "hourly", "daily"]),
  entities: z.array(z.enum(SYNC_ENTITIES)).min(1, "Select at least one record type."),
  batchSize: z.coerce.number({ error: "Enter a batch size." }).int("Whole numbers only.").min(50, "Minimum 50.").max(5000, "Maximum 5,000."),
  dryRunFirst: z.boolean(),
});
export type SyncConfigInput = z.input<typeof syncConfigSchema>;

async function loadSource(tx: DbOrTx, viewer: Viewer, sourceId: string) {
  const [row] = await tx
    .select({ source: integrationSources, brandName: brands.name, brandCode: brands.code })
    .from(integrationSources)
    .innerJoin(brands, eq(brands.id, integrationSources.brandId))
    .where(eq(integrationSources.id, sourceId));
  if (!row) throw new BusinessRuleError("Integration source not found.");
  if (!viewer.brandIds.includes(row.source.brandId) && !viewer.permissions.has("brands.manage")) {
    throw new BusinessRuleError("You are not authorised for this brand.");
  }
  return row;
}

/** Simulated: never opens a network connection. Always records a failed test because no credentials exist in the demo. */
export async function testConnection(tx: DbOrTx, viewer: Viewer, sourceId: string) {
  const { source, brandName, brandCode } = await loadSource(tx, viewer, sourceId);
  const id = await nextId(tx, "run");
  const startedAt = new Date();
  const cfg = readSyncConfig(source.config, brandCode);
  await tx.insert(integrationRuns).values({
    id,
    sourceId,
    kind: "test_connection",
    status: "failed",
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 1200),
    errorCount: 1,
    errors: [{ message: `${SIMULATED_TEST_MESSAGE}. Expected server env reference ${cfg.credentialsRef} is not set in the demo.` }],
    message: SIMULATED_TEST_MESSAGE,
    triggeredBy: viewer.id,
  });
  await tx
    .update(integrationSources)
    .set({ errorCount: sql`${integrationSources.errorCount} + 1`, updatedAt: new Date() })
    .where(eq(integrationSources.id, sourceId));
  await logActivity(tx, {
    actorId: viewer.id,
    action: "integration.test_connection",
    entityType: "integration",
    entityId: sourceId,
    brandId: source.brandId,
    summary: `Test connection for ${brandName} (simulated) — failed: credentials not configured`,
    metadata: { runId: id, simulated: true, credentialsRef: cfg.credentialsRef },
  });
  await notify(tx, [viewer.id], {
    kind: "integration",
    title: `Integration test failed (simulated) — ${brandName}`,
    body: "Credentials are not configured in the demo; no live system was contacted.",
    href: "/integrations",
  });
  return { runId: id, brandName };
}

/** Simulated dry run: produces plausible counts and flagged records but writes no business data. */
export async function dryRunImport(tx: DbOrTx, viewer: Viewer, sourceId: string) {
  const { source, brandName, brandCode } = await loadSource(tx, viewer, sourceId);
  const cfg = readSyncConfig(source.config, brandCode);
  const [{ known }] = await tx.select({ known: count() }).from(externalRecordMappings).where(eq(externalRecordMappings.sourceId, sourceId));
  const rnd = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
  const perEntity = cfg.entities.map((e) => ({ entity: e, read: rnd(12, 80) + (e === "customers" ? known : 0) }));
  const recordsRead = perEntity.reduce((s, x) => s + x.read, 0);
  const flagged = rnd(2, 6);
  const errors = [
    { message: `Row ${rnd(100, 999)}: invalid email format — would be held for review`, entity: "customers" },
    { message: `${brandCode}-CUST-${rnd(10000, 99999)} matches existing customer by email — duplicate review`, entity: "customers" },
    { message: `Invoice ${brandCode}-LEG-${rnd(1000, 9999)} references an unknown customer`, entity: "invoices" },
    { message: `Payment ${brandCode}-PAY-${rnd(1000, 9999)}: processor reference already imported`, entity: "payments" },
    { message: "Currency missing on 1 payment row — would default to brand currency after review", entity: "payments" },
  ]
    .filter((e) => (cfg.entities as string[]).includes(e.entity))
    .slice(0, Math.max(1, Math.min(4, flagged - 1)));
  const id = await nextId(tx, "run");
  const startedAt = new Date();
  await tx.insert(integrationRuns).values({
    id,
    sourceId,
    kind: "dry_run",
    status: "partial",
    startedAt,
    finishedAt: new Date(startedAt.getTime() + rnd(4, 40) * 1000),
    recordsRead,
    recordsImported: 0,
    recordsFlagged: flagged,
    errorCount: errors.length,
    errors: [...errors, { message: `Breakdown: ${perEntity.map((p) => `${p.entity} ${p.read}`).join(", ")}` }],
    message: "Simulated dry run — sample data, no records written, no live system contacted.",
    triggeredBy: viewer.id,
  });
  await logActivity(tx, {
    actorId: viewer.id,
    action: "integration.dry_run",
    entityType: "integration",
    entityId: sourceId,
    brandId: source.brandId,
    summary: `Dry-run import for ${brandName} (simulated): ${recordsRead} read, ${flagged} flagged, 0 written`,
    metadata: { runId: id, simulated: true, recordsRead, flagged, errors: errors.length },
  });
  return { runId: id, recordsRead, flagged };
}

export async function updateSyncConfig(tx: DbOrTx, viewer: Viewer, sourceId: string, raw: SyncConfigInput) {
  const input = syncConfigSchema.parse(raw);
  const { source, brandName, brandCode } = await loadSource(tx, viewer, sourceId);
  const before = readSyncConfig(source.config, brandCode);
  // credentialsRef is never accepted from the client — it is a pointer to a server env var, not a secret.
  const next = { ...before, ...input, entities: [...new Set(input.entities)] };
  const changes = diffFields(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>, ["mode", "schedule", "entities", "batchSize", "dryRunFirst"]);
  if (!Object.keys(changes).length) return { changed: false };
  await tx.update(integrationSources).set({ config: next, updatedAt: new Date() }).where(eq(integrationSources.id, sourceId));
  await logActivity(tx, {
    actorId: viewer.id,
    action: "integration.config_updated",
    entityType: "integration",
    entityId: sourceId,
    brandId: source.brandId,
    summary: `${brandName} sync configuration: updated ${Object.keys(changes).join(", ")}`,
    metadata: { changes },
  });
  return { changed: true };
}
