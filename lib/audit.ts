import "server-only";
import type { DbOrTx } from "@/lib/db";
import { activityLogs, notifications } from "@/lib/db/schema";
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

/** Appends to the immutable audit trail. Call inside the same DB transaction as the change. */
export async function logActivity(db: DbOrTx, entry: Activity) {
  const { ip } = await requestMeta().catch(() => ({ ip: null }));
  await db.insert(activityLogs).values({ ...entry, ip });
}

export async function notify(
  db: DbOrTx,
  userIds: string[],
  n: { kind: string; title: string; body: string; href?: string },
) {
  for (const userId of new Set(userIds)) {
    await db.insert(notifications).values({ id: await nextId(db, "notification"), userId, ...n });
  }
}
