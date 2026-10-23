import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic gate only: bounces requests without a session cookie to /login.
 * The real check (session lookup, user status, permissions) happens in the
 * Data Access Layer for every page, Server Action and Route Handler.
 */
export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has("crm_session");
  const { pathname, search } = request.nextUrl;

  if (!hasSession && pathname !== "/login") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
    }
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }

  const res = NextResponse.next();
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "same-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|ico)$).*)"],
};
