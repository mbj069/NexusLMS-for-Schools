import { NextRequest, NextResponse } from "next/server";
import { get } from "@/lib/db";
import { verifyPassword, createSessionToken, sessionCookie, type Role } from "@/lib/auth";
import { toErrorResponse } from "@/lib/tenant";

interface UserRow {
  id: string;
  schoolId: string | null;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  tokenVersion: number | null;
  isActive: number | null;
  deletedAt: string | null;
}

// Login rate limiting (Phase 2.6). In-memory, per server instance — this
// slows credential stuffing on a single instance and, combined with bcrypt
// cost 12, makes brute force impractical. It is NOT a global limiter across
// serverless instances; a shared store (Upstash/Redis) replaces it when the
// product outgrows one instance, and that is a documented follow-up, not a
// silent gap. Limits: 10 failed attempts per email / 15 min, 50 per IP / 15 min.
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, number[]>();

function tooMany(key: string, limit: number, now: number): boolean {
  const list = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, list);
  return list.length >= limit;
}

function recordFailure(key: string, now: number): void {
  const list = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  attempts.set(key, list);
}

function clearFailures(key: string): void {
  attempts.delete(key);
}

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }
    const emailNorm = String(email).toLowerCase().trim();
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const now = Date.now();
    const emailKey = `email:${emailNorm}`;
    const ipKey = `ip:${ip}`;
    if (tooMany(emailKey, 10, now) || tooMany(ipKey, 50, now)) {
      return NextResponse.json(
        { error: "Too many login attempts. Please wait a few minutes and try again." },
        { status: 429 }
      );
    }
    const fail = () => {
      recordFailure(emailKey, now);
      recordFailure(ipKey, now);
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    };
    // Note: if the same email exists in multiple schools, the school-scoped
    // account takes precedence over the platform account.
    const user = await get<UserRow>(
      "SELECT id, schoolId, name, email, passwordHash, role, tokenVersion, isActive, deletedAt FROM users WHERE email = ? AND deletedAt IS NULL ORDER BY schoolId DESC LIMIT 1",
      emailNorm
    );
    if (!user || user.isActive === 0) return fail();
    if (!(await verifyPassword(String(password), user.passwordHash))) return fail();
    clearFailures(emailKey);
    const token = await createSessionToken({
      userId: user.id,
      schoolId: user.schoolId,
      role: user.role,
      name: user.name,
      email: user.email,
      tokenVersion: user.tokenVersion ?? 0,
    });
    const res = NextResponse.json({
      ok: true,
      role: user.role,
      redirect: user.role === "SUPER_ADMIN" ? "/platform" : "/dashboard",
    });
    res.cookies.set(sessionCookie(token));
    return res;
  } catch (e) {
    return toErrorResponse(e);
  }
}

export const dynamic = "force-dynamic";
