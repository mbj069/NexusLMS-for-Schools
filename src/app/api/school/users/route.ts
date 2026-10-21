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
      ? await all(
          "SELECT id, name, email, role, phone, createdAt FROM users WHERE schoolId = ? AND role = ? ORDER BY createdAt DESC",
          schoolId,
          role
        )
      : await all(
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
    if (await get("SELECT id FROM users WHERE schoolId = ? AND email = ?", schoolId, emailNorm)) {
      return NextResponse.json({ error: "That email is already registered in this school" }, { status: 409 });
    }
    const id = uid();
    await run(
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
    await run(
      "INSERT INTO audit_logs (id, schoolId, userId, action, entity, entityId, createdAt) VALUES (?,?,?,?,?,?,?)",
      uid(),
      schoolId,
      session.userId,
      "user.created",
      "User",
      id,
      nowIso()
    );
    const user = await get("SELECT id, name, email, role, phone FROM users WHERE id = ?", id);
    return NextResponse.json({ user }, { status: 201 });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: "That email is already registered in this school" }, { status: 409 });
    }
    return toErrorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { id, name, email, phone, password } = await req.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const existing = await get<{ id: string; role: string }>(
      "SELECT id, role FROM users WHERE id = ? AND schoolId = ?", id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const updates: string[] = [];
    const params: (string | null)[] = [];
    if (name !== undefined && String(name).trim()) {
      updates.push("name = ?");
      params.push(String(name).trim());
    }
    if (email !== undefined && String(email).trim()) {
      const emailNorm = String(email).toLowerCase().trim();
      const clash = await get(
        "SELECT id FROM users WHERE schoolId = ? AND email = ? AND id != ?",
        schoolId, emailNorm, id
      );
      if (clash) return NextResponse.json({ error: "That email is already registered in this school" }, { status: 409 });
      updates.push("email = ?");
      params.push(emailNorm);
    }
    if (phone !== undefined) {
      updates.push("phone = ?");
      params.push(String(phone).trim() || null);
    }
    if (password !== undefined && String(password)) {
      if (String(password).length < 8) {
        return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
      }
      updates.push("passwordHash = ?");
      params.push(await hashPassword(String(password)));
    }
    if (updates.length > 0) {
      await run(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, ...params, id);
    }
    const user = await get("SELECT id, name, email, role, phone FROM users WHERE id = ?", id);
    return NextResponse.json({ user });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: "That email is already registered in this school" }, { status: 409 });
    }
    return toErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    if (id === session.userId) {
      return NextResponse.json({ error: "You cannot delete your own account" }, { status: 400 });
    }
    const existing = await get<{ id: string; role: string; name: string }>(
      "SELECT id, role, name FROM users WHERE id = ? AND schoolId = ?", id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "User not found" }, { status: 404 });

    if (existing.role === "TEACHER") {
      const assigned = await get(
        "SELECT id FROM class_subjects WHERE teacherId = ? LIMIT 1", id
      );
      if (assigned) {
        return NextResponse.json(
          { error: `${existing.name} still teaches subjects — reassign them first` },
          { status: 409 }
        );
      }
    }
    if (existing.role === "SCHOOL_ADMIN") {
      const others = await get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM users WHERE schoolId = ? AND role = 'SCHOOL_ADMIN' AND id != ?",
        schoolId, id
      );
      if ((others?.n ?? 0) === 0) {
        return NextResponse.json(
          { error: "Cannot delete the last school admin" },
          { status: 409 }
        );
      }
    }
    // Cascades: enrollments, parent links, attendance, submissions, grades.
    // Class-teacher slots become vacant (SET NULL).
    // markedById / createdById have no ON DELETE action, so reassign those
    // references to the deleter first — the records themselves stay valid.
    await run("UPDATE attendance_records SET markedById = ? WHERE markedById = ?", session.userId, id);
    await run("UPDATE announcements SET createdById = ? WHERE createdById = ?", session.userId, id);
    await run("DELETE FROM users WHERE id = ?", id);
    return NextResponse.json({ deleted: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export const dynamic = "force-dynamic";
