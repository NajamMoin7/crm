"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/lib/db";
import { ACTIVE_BRAND_COOKIE } from "@/lib/auth/scope";
import { destroySession } from "@/lib/auth/session";
import { getViewer } from "@/lib/auth/viewer";
import { logActivity } from "@/lib/audit";

export async function setActiveBrand(brandId: string) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  const jar = await cookies();
  if (brandId === "all" || !viewer.brandIds.includes(brandId)) jar.delete(ACTIVE_BRAND_COOKIE);
  else jar.set(ACTIVE_BRAND_COOKIE, brandId, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" });
  refresh();
}

export async function logout() {
  const viewer = await getViewer();
  if (viewer) {
    await logActivity({ actorId: viewer.id, action: "auth.logout", entityType: "user", entityId: viewer.id, summary: `${viewer.name} signed out` });
  }
  await destroySession();
  (await cookies()).delete(ACTIVE_BRAND_COOKIE);
  redirect("/login");
}

export async function markNotificationRead(id: string) {
  const viewer = await getViewer();
  if (!viewer) return;
  const C = await getDb();
  // Scoped to the owner: a user can never touch someone else's notification.
  await C.notifications.updateOne({ id: String(id), userId: viewer.id, readAt: null }, { $set: { readAt: new Date() } });
  refresh();
}

export async function markAllNotificationsRead() {
  const viewer = await getViewer();
  if (!viewer) return;
  const C = await getDb();
  await C.notifications.updateMany({ userId: viewer.id, readAt: null }, { $set: { readAt: new Date() } });
  refresh();
}
