import { NextResponse } from "next/server";
import { getSession, roleAtLeast, type Role, type Session } from "./auth";

/**
 * Multi-tenancy enforcement.
 *
 * Every API route MUST go through requireAuth (or requireSchoolAuth).
 * - SUPER_ADMIN has schoolId === null and may pass an explicit schoolId.
 * - Everyone else is hard-scoped to their own session.schoolId.
 */

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function requireAuth(minimum: Role = "STUDENT"): Promise<Session> {
  const session = await getSession();
  if (!session) throw new AuthError(401, "Not signed in");
  if (!roleAtLeast(session.role, minimum)) {
    throw new AuthError(403, "Insufficient permissions");
  }
  return session;
}

/**
 * Resolve the school scope for a request.
 * - Non-super-admins: always their own school (query param ignored).
 * - Super-admins: must pass ?schoolId=... explicitly, or omit for platform-wide ops.
 */
export function resolveSchoolScope(
  session: Session,
  params: URLSearchParams
): string | null {
  if (session.role === "SUPER_ADMIN") {
    return params.get("schoolId");
  }
  if (!session.schoolId) throw new AuthError(403, "No school assigned to this account");
  return session.schoolId;
}

/** Same, but the school is mandatory (school-level routes). */
export function requireSchoolScope(
  session: Session,
  params: URLSearchParams
): string {
  const schoolId = resolveSchoolScope(session, params);
  if (!schoolId) throw new AuthError(400, "schoolId is required");
  return schoolId;
}

export function toErrorResponse(err: unknown) {
  if (err instanceof AuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error(err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

export function audit(
  // lightweight helper; callers import db directly
  data: { schoolId?: string | null; userId: string; action: string; entity?: string; entityId?: string }
) {
  return data;
}

import { run, uid, nowIso } from "./db";

/**
 * Write a real audit row (Phase 2.6). details is a JSON object with
 * before/after values — e.g. { oldStatus, newStatus } for attendance,
 * { oldMarks, newMarks } for grades. Never put passwords or tokens here.
 * Audit writes must never break the main action, so failures are logged
 * and swallowed by the caller via try/catch at the call site if needed;
 * here we let the error propagate only when the caller awaits it directly.
 */
export async function writeAudit(data: {
  schoolId?: string | null;
  userId: string;
  action: string;
  entity?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await run(
    "INSERT INTO audit_logs (id, schoolId, userId, action, entity, entityId, details, createdAt) VALUES (?,?,?,?,?,?,?,?)",
    uid(),
    data.schoolId ?? null,
    data.userId,
    data.action,
    data.entity ?? null,
    data.entityId ?? null,
    data.details ? JSON.stringify(data.details) : null,
    nowIso()
  );
}
