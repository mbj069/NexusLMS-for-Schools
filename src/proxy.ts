import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

// Fail-closed secret (Phase 2.6): in production without AUTH_SECRET, no
// session is trusted at all — never fall back to a known dev secret.
// NOTE: this file cannot import src/lib/auth (that module reads cookies via
// next/headers, which the proxy runtime cannot use), so the rule is repeated
// here deliberately. Keep the two in sync.
function sessionSecret(): Uint8Array | null {
  const raw = process.env.AUTH_SECRET;
  if (raw) return new TextEncoder().encode(raw);
  if (process.env.NODE_ENV === "production") return null;
  return new TextEncoder().encode("dev-only-secret-change-in-production");
}

interface SessionPayload {
  role?: string;
}

async function readSession(request: NextRequest): Promise<SessionPayload | null> {
  const secret = sessionSecret();
  if (!secret) return null;
  const token = request.cookies.get("nexuslms_session")?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

// Next.js 16: `middleware.ts` was renamed to `proxy.ts`.
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // CSRF guard for API mutations (Phase 2.6). The session cookie is
  // SameSite=Lax, which already blocks most cross-site posts, but an
  // explicit Origin check closes the rest: a state-changing API call must
  // come from this same origin. Our UI is same-origin, so legitimate calls
  // always pass; a page on another origin posting here gets a 403.
  // GET/HEAD/OPTIONS are read-only and are not checked.
  if (
    pathname.startsWith("/api/") &&
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    request.method !== "OPTIONS"
  ) {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) {
      return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
    }
  }

  const session = await readSession(request);
  const role = session?.role;

  const isPublicPage = pathname === "/" || pathname === "/login" || pathname === "/setup";
  const isAuthApi = pathname.startsWith("/api/auth/");
  // /api/setup is public at the proxy layer ON PURPOSE: the route itself
  // decides (DEMO_MODE, or the setup key). The proxy must not 401 it, or
  // the demo deployment could never be seeded and the owner could never
  // reach the setup page. This was a real bug found by the hardening tests:
  // the proxy was 401ing /setup before the route's own gating ever ran.
  const isSetupApi = pathname === "/api/setup";
  const isApi = pathname.startsWith("/api/");

  // API routes (other than auth/setup) answer 401 JSON instead of redirecting
  if (isApi && !isAuthApi && !isSetupApi && !role) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  // Note: /api/setup must also be excluded here. Without this, an
  // unauthenticated /api/setup call fell through to this page redirect
  // (307 to /login) instead of reaching the route's own 403 — fetch
  // follows the redirect and the caller sees a misleading 200 HTML page.
  // This was the second proxy bug found by the hardening tests.
  if (!role && !isPublicPage && !isAuthApi && !isSetupApi) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (role && isPublicPage) {
    return NextResponse.redirect(
      new URL(role === "SUPER_ADMIN" ? "/platform" : "/dashboard", request.url)
    );
  }
  if (role && pathname.startsWith("/platform") && role !== "SUPER_ADMIN") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }
  if (role && pathname.startsWith("/dashboard") && role === "SUPER_ADMIN") {
    return NextResponse.redirect(new URL("/platform", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
