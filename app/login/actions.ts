"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { createSession, requestMeta } from "@/lib/auth/session";
import { logActivity } from "@/lib/audit";

export type LoginState = { error?: string; email?: string } | undefined;

const schema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
  next: z.string().max(300).optional(),
});

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

// Per-IP throttle (in-memory, per server instance). Use Redis/Upstash in production.
const ipHits = new Map<string, { count: number; resetAt: number }>();
function ipThrottled(ip: string) {
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || entry.resetAt < now) {
    ipHits.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count++;
  return entry.count > 20;
}

// Constant-time-ish failure path when the user doesn't exist.
let dummyHash: string | null = null;
const getDummyHash = () => (dummyHash ??= bcrypt.hashSync("not-a-real-password", 10));
const GENERIC = "Incorrect email or password.";

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") || undefined,
  });
  if (!parsed.success) return { error: "Enter a valid email and password.", email: String(formData.get("email") ?? "") };
  const { email, password, next } = parsed.data;

  const { ip } = await requestMeta();
  if (ipThrottled(ip)) return { error: "Too many sign-in attempts. Wait a minute and try again.", email };

  const db = await getDb();
  const [user] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email)).limit(1);

  if (!user) {
    await bcrypt.compare(password, getDummyHash());
    return { error: GENERIC, email };
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { error: `Account temporarily locked after repeated failures. Try again after ${LOCK_MINUTES} minutes.`, email };
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const failures = user.failedLoginCount + 1;
    await db
      .update(users)
      .set({
        failedLoginCount: failures >= MAX_ATTEMPTS ? 0 : failures,
        lockedUntil: failures >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      })
      .where(eq(users.id, user.id));
    await logActivity(db, {
      actorId: user.id,
      action: failures >= MAX_ATTEMPTS ? "auth.locked" : "auth.failed",
      entityType: "user",
      entityId: user.id,
      summary: failures >= MAX_ATTEMPTS ? `Account locked after ${MAX_ATTEMPTS} failed sign-ins` : "Failed sign-in attempt",
    });
    return { error: GENERIC, email };
  }
  if (user.status !== "active") {
    return { error: "This account is suspended. Contact a Super Admin.", email };
  }

  await db.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await createSession(user.id);
  await logActivity(db, { actorId: user.id, action: "auth.login", entityType: "user", entityId: user.id, summary: `${user.name} signed in` });

  // Only same-origin relative paths are honoured (no open redirects).
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/login") ? next : "/";
  redirect(safeNext);
}
