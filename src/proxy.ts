import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const secret = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? "dev-only-secret-change-in-production"
);

interface SessionPayload {
  role?: string;
}

async function readSession(request: NextRequest): Promise<SessionPayload | null> {
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
  const session = await readSession(request);
  const role = session?.role;

  const isPublicPage = pathname === "/" || pathname === "/login";
  const isAuthApi = pathname.startsWith("/api/auth/");
  const isApi = pathname.startsWith("/api/");

  // API routes (other than auth) answer 401 JSON instead of redirecting
  if (isApi && !isAuthApi && !role) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!role && !isPublicPage && !isAuthApi) {
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
