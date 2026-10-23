import "server-only";
import { getDb } from "@/lib/db";
import { nextId } from "@/lib/db/ids";
import { requestMeta } from "@/lib/auth/session";

type Activity = {
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  brandId?: string | null;
  legalEntityId?: string | null;
  summary: string;
  /** Never include passwords, card numbers, CVV or other secrets. */
  metadata?: Record<string, unknown>;
};

/** Appends to the immutable audit trail. Call inside the same transaction as the change. */
export async function logActivity(entry: Activity) {
  const { ip } = await requestMeta().catch(() => ({ ip: null }));
  const C = await getDb();
  await C.activityLogs.insertOne({ ...entry, ip });
}

export async function notify(
  userIds: string[],
  n: { kind: string; title: string; body: string; href?: string },
) {
  const C = await getDb();
  for (const userId of new Set(userIds)) {
    await C.notifications.insertOne({ id: await nextId("notification"), userId, ...n });
  }
}
