import "server-only";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { integrationRuns, integrationSources, users } from "@/lib/db/schema";
import { can, type Viewer } from "@/lib/auth/viewer";
import { getAllBrands } from "@/lib/data/reference";

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/* ----------------------------------------------------------- integrations */

export type SyncConfig = {
  mode: "pull" | "webhook";
  schedule: "manual" | "hourly" | "daily";
  entities: string[];
  batchSize: number;
  dryRunFirst: boolean;
  credentialsRef: string;
};

export function readSyncConfig(raw: unknown, brandCode: string): SyncConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Partial<SyncConfig>;
  return {
    mode: c.mode === "webhook" ? "webhook" : "pull",
    schedule: c.schedule === "hourly" || c.schedule === "daily" ? c.schedule : "manual",
    entities: Array.isArray(c.entities) ? c.entities.filter((e): e is string => typeof e === "string") : [],
    batchSize: typeof c.batchSize === "number" ? c.batchSize : 500,
    dryRunFirst: c.dryRunFirst !== false,
    credentialsRef: typeof c.credentialsRef === "string" ? c.credentialsRef : `env:${brandCode}_SOURCE_DATABASE_URL`,
  };
}

export async function listIntegrations(viewer: Viewer) {
  const db = await getDb();
  const list = (await getAllBrands()).filter((b) => viewer.brandIds.includes(b.id) || can(viewer, "brands.manage"));
  const ids = list.map((b) => b.id).concat("__none__");
  const sources = await db.select().from(integrationSources).where(inArray(integrationSources.brandId, ids)).orderBy(asc(integrationSources.id));
  const sourceIds = sources.map((s) => s.id).concat("__none__");
  const runs = await db
    .select({
      id: integrationRuns.id,
      sourceId: integrationRuns.sourceId,
      kind: integrationRuns.kind,
      status: integrationRuns.status,
      startedAt: integrationRuns.startedAt,
      finishedAt: integrationRuns.finishedAt,
      recordsRead: integrationRuns.recordsRead,
      recordsImported: integrationRuns.recordsImported,
      recordsFlagged: integrationRuns.recordsFlagged,
      errorCount: integrationRuns.errorCount,
      errors: integrationRuns.errors,
      message: integrationRuns.message,
      triggeredByName: users.name,
    })
    .from(integrationRuns)
    .leftJoin(users, eq(users.id, integrationRuns.triggeredBy))
    .where(inArray(integrationRuns.sourceId, sourceIds))
    .orderBy(desc(integrationRuns.startedAt), desc(integrationRuns.id))
    .limit(60);
  return sources.map((s) => {
    const brand = list.find((b) => b.id === s.brandId)!;
    return { ...s, brand, config: readSyncConfig(s.config, brand.code), runs: runs.filter((r) => r.sourceId === s.id) };
  });
}
