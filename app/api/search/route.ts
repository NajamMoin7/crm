import type { NextRequest } from "next/server";
import { getViewer } from "@/lib/auth/viewer";
import { globalSearch } from "@/lib/data/search";

/** Simple per-user sliding-window rate limit (in-memory; per server instance). */
const WINDOW_MS = 60_000;
const LIMIT = 60;
const g = globalThis as unknown as { __crmSearchHits?: Map<string, number[]> };
const hits: Map<string, number[]> = (g.__crmSearchHits ??= new Map<string, number[]>());

function rateLimited(userId: string, now: number) {
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) {
    hits.set(userId, recent);
    return Math.ceil((WINDOW_MS - (now - recent[0])) / 1000);
  }
  recent.push(now);
  hits.set(userId, recent);
  return 0;
}

/** GET /api/search?q= — grouped, permission-gated and scoped results for the command palette. */
export async function GET(request: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return Response.json({ error: "Unauthenticated" }, { status: 401 });
  const retry = rateLimited(viewer.id, Date.now());
  if (retry) return Response.json({ error: "Too many searches. Please wait a moment." }, { status: 429, headers: { "Retry-After": String(retry) } });

  const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return Response.json({ groups: [] }, { headers: { "Cache-Control": "no-store" } });
  const groups = await globalSearch(viewer, q);
  return Response.json({ groups }, { headers: { "Cache-Control": "no-store" } });
}
