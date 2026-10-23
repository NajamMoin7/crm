import "server-only";
import { getDb } from "@/lib/db";
import { ids, uniq } from "@/lib/db/query";
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
  const C = await getDb();
  const list = (await getAllBrands()).filter((b) => viewer.brandIds.includes(b.id) || can(viewer, "brands.manage"));
  const sources = await C.integrationSources.find({ brandId: { $in: ids(list.map((b) => b.id)) } }, { sort: { id: 1 } }).toArray();
  const runRows = await C.integrationRuns
    .find({ sourceId: { $in: ids(sources.map((x) => x.id)) } }, { sort: { startedAt: -1, id: -1 }, limit: 60 })
    .toArray();
  const names = new Map(
    (await C.users.find({ id: { $in: ids(uniq(runRows.map((r) => r.triggeredBy))) } }, { projection: { id: 1, name: 1 } }).toArray()).map((u) => [u.id, u.name]),
  );
  const runs = runRows.map((r) => ({ ...r, triggeredByName: r.triggeredBy ? (names.get(r.triggeredBy) ?? null) : null }));
  return sources.map((s) => {
    const brand = list.find((b) => b.id === s.brandId)!;
    return { ...s, brand, config: readSyncConfig(s.config, brand.code), runs: runs.filter((r) => r.sourceId === s.id) };
  });
}
