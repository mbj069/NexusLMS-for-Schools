import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, nowIso, isUniqueViolation } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { requireAuth, requireSchoolScope, toErrorResponse } from "@/lib/tenant";

const CREATABLE = ["SCHOOL_ADMIN", "TEACHER", "STUDENT", "PARENT"];

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const role = req.nextUrl.searchParams.get("role");
    const users = role
      ? all(
          "SELECT id, name, email, role, phone, createdAt FROM users WHERE schoolId = ? AND role = ? ORDER BY createdAt DESC",
          schoolId,
          role
        )
      : all(
          "SELECT id, name, email, role, phone, createdAt FROM users WHERE schoolId = ? ORDER BY createdAt DESC",
          schoolId
        );
    return NextResponse.json({ users });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { name, email, password, role, phone } = await req.json();
    if (!name || !email || !password || !role) {
      return NextResponse.json({ error: "Name, email, password and role are required" }, { status: 400 });
    }
    if (!CREATABLE.includes(role)) {
      return NextResponse.json({ error: "Invalid role for a school user" }, { status: 400 });
    }
    if (String(password).length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }
    const emailNorm = String(email).toLowerCase().trim();
    if (get("SELECT id FROM users WHERE schoolId = ? AND email = ?", schoolId, emailNorm)) {
      return NextResponse.json({ error: "That email is already registered in this school" }, { status: 409 });
    }
    const id = uid();
    run(
      "INSERT INTO users (id, schoolId, name, email, passwordHash, role, phone, createdAt) VALUES (?,?,?,?,?,?,?,?)",
      id,
      schoolId,
      String(name).trim(),
      emailNorm,
      await hashPassword(String(password)),
      role,
      phone?.trim() || null,
      nowIso()
    );
    run(
      "INSERT INTO audit_logs (id, schoolId, userId, action, entity, entityId, createdAt) VALUES (?,?,?,?,?,?,?)",
      uid(),
      schoolId,
      session.userId,
      "user.created",
      "User",
      id,
      nowIso()
    );
    const user = get("SELECT id, name, email, role, phone FROM users WHERE id = ?", id);
    return NextResponse.json({ user }, { status: 201 });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: "That email is already registered in this school" }, { status: 409 });
    }
    return toErrorResponse(e);
  }
}

export const dynamic = "force-dynamic";
