"use server";

import { refresh } from "next/cache";
import { getDb } from "@/lib/db";
import { authorize } from "@/lib/auth/viewer";
import { runAction } from "@/lib/actions";
import type { ActionResult } from "@/lib/action-result";
import { dryRunImport, testConnection, updateSyncConfig, type SyncConfigInput } from "@/lib/services/integrations";

export async function testConnectionAction(sourceId: string): Promise<ActionResult<{ runId: string }>> {
  return runAction(async () => {
    const viewer = await authorize("integrations.manage");
    const db = await getDb();
    const res = await db.transaction((tx) => testConnection(tx, viewer, String(sourceId)));
    refresh();
    // The simulated test always "fails" — reported as a successful action with an explanatory message.
    return { ok: true, data: { runId: res.runId }, message: `${res.runId}: ${res.brandName} — simulated, credentials not configured; no live system contacted.` };
  });
}

export async function dryRunAction(sourceId: string): Promise<ActionResult<{ runId: string }>> {
  return runAction(async () => {
    const viewer = await authorize("integrations.manage");
    const db = await getDb();
    const res = await db.transaction((tx) => dryRunImport(tx, viewer, String(sourceId)));
    refresh();
    return { ok: true, data: { runId: res.runId }, message: `Dry run ${res.runId}: ${res.recordsRead} records read, ${res.flagged} flagged — nothing written (simulated).` };
  });
}

export async function updateSyncConfigAction(sourceId: string, input: SyncConfigInput): Promise<ActionResult> {
  return runAction(async () => {
    const viewer = await authorize("integrations.manage");
    const db = await getDb();
    const res = await db.transaction((tx) => updateSyncConfig(tx, viewer, String(sourceId), input));
    refresh();
    return { ok: true, message: res.changed ? "Sync configuration saved." : "No changes to save." };
  });
}
