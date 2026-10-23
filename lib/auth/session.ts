import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import { getDb } from "@/lib/db";

export const SESSION_COOKIE = "crm_session";
const SESSION_HOURS = 12;
const IDLE_REFRESH_MS = 15 * 60_000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function requestMeta() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local",
    userAgent: h.get("user-agent")?.slice(0, 200) ?? null,
  };
}

/** Issues an opaque random token; only its SHA-256 hash is stored server-side. */
export async function createSession(userId: string) {
  const C = await getDb();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);
  const meta = await requestMeta();
  await C.sessions.insertOne({ idHash: hashToken(token), userId, expiresAt, ip: meta.ip, userAgent: meta.userAgent });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Returns the active user id for the current request, or null. */
export async function readSessionUserId(): Promise<string | null> {
  // Session validity depends on the current time, so this is always request-time work.
  await connection();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || token.length > 100) return null;
  const C = await getDb();
  const idHash = hashToken(token);
  const row = await C.sessions.findOne({ idHash, expiresAt: { $gt: new Date() } });
  if (!row) return null;
  const user = await C.users.findOne({ id: row.userId }, { projection: { status: 1 } });
  if (user?.status !== "active") return null;
  if (Date.now() - row.lastSeenAt.getTime() > IDLE_REFRESH_MS) {
    await C.sessions.updateOne({ idHash }, { $set: { lastSeenAt: new Date() } });
  }
  return row.userId;
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const C = await getDb();
    await C.sessions.deleteOne({ idHash: hashToken(token) });
  }
  jar.delete(SESSION_COOKIE);
}

export async function revokeUserSessions(userId: string) {
  const C = await getDb();
  await C.sessions.deleteMany({ userId });
}
