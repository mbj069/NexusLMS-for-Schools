import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { get, run } from "./db";

export type Role =
  | "SUPER_ADMIN"
  | "SCHOOL_ADMIN"
  | "TEACHER"
  | "STUDENT"
  | "PARENT";

const COOKIE_NAME = "nexuslms_session";

/**
 * Fail-closed secret (Phase 2.6 hardening).
 * Previously this fell back to a hard-coded dev secret in every environment,
 * so a production deploy missing AUTH_SECRET would sign tokens with a value
 * anyone reading the repo knows. Now: production without AUTH_SECRET throws
 * instead of signing anything. Dev keeps the fallback for local work only.
 */
function getSecret(): Uint8Array {
  const raw = process.env.AUTH_SECRET;
  if (raw) return new TextEncoder().encode(raw);
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET is not set in production — refusing to sign or verify sessions");
  }
  return new TextEncoder().encode("dev-only-secret-change-in-production");
}

export interface Session {
  userId: string;
  schoolId: string | null; // null => platform super-admin
  role: Role;
  name: string;
  email: string;
  tokenVersion: number;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSessionToken(session: Session): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (
      typeof payload.userId !== "string" ||
      typeof payload.role !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.email !== "string"
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      schoolId: typeof payload.schoolId === "string" ? payload.schoolId : null,
      role: payload.role as Role,
      name: payload.name,
      email: payload.email,
      // Tokens issued before the hardening sprint carry no version; they are
      // version 0, which matches every freshly migrated user row.
      tokenVersion: typeof payload.tokenVersion === "number" ? payload.tokenVersion : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Session check with revocation (Phase 2.6).
 * A signature alone is NOT enough anymore: the user row is the authority.
 * - Missing user, disabled user (isActive = 0), or soft-deleted user => no session.
 * - tokenVersion mismatch => no session. Bumping the version (password change,
 *   disable, admin revoke) kills every previously issued token immediately,
 *   instead of letting a removed teacher keep access for up to 7 days.
 * - Role/school/name/email come from the DB, not the token, so a role change
 *   takes effect on the next request even without a token bump.
 */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const claimed = await verifySessionToken(token);
  if (!claimed) return null;
  let row: {
    id: string;
    schoolId: string | null;
    role: Role;
    name: string;
    email: string;
    tokenVersion: number | null;
    isActive: number | null;
    deletedAt: string | null;
  } | undefined;
  try {
    row = await get(
      "SELECT id, schoolId, role, name, email, tokenVersion, isActive, deletedAt FROM users WHERE id = ?",
      claimed.userId
    );
  } catch {
    return null;
  }
  if (!row) return null;
  if (row.isActive === 0 || row.deletedAt) return null;
  if ((row.tokenVersion ?? 0) !== claimed.tokenVersion) return null;
  return {
    userId: row.id,
    schoolId: row.schoolId,
    role: row.role,
    name: row.name,
    email: row.email,
    tokenVersion: row.tokenVersion ?? 0,
  };
}

/** Invalidate every token ever issued for this user. Call on password change, disable, and admin revoke. */
export async function bumpTokenVersion(userId: string): Promise<void> {
  await run("UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?", userId);
}

export function sessionCookie(token: string) {
  return {
    name: COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
}

export function clearSessionCookie() {
  return {
    name: COOKIE_NAME,
    value: "",
    httpOnly: true,
    path: "/",
    maxAge: 0,
  };
}

/** Role hierarchy helpers */
const ROLE_RANK: Record<Role, number> = {
  SUPER_ADMIN: 4,
  SCHOOL_ADMIN: 3,
  TEACHER: 2,
  STUDENT: 1,
  PARENT: 1,
};

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}
