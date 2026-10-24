import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, nowIso, isUniqueViolation } from "@/lib/db";
import { hashPassword, bumpTokenVersion } from "@/lib/auth";
import { requireAuth, requireSchoolScope, toErrorResponse, writeAudit } from "@/lib/tenant";

const CREATABLE = ["SCHOOL_ADMIN", "TEACHER", "STUDENT", "PARENT"];

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const role = req.nextUrl.searchParams.get("role");
    const users = role
      ? await all(
          "SELECT id, name, email, role, phone, createdAt, isActive FROM users WHERE schoolId = ? AND role = ? AND deletedAt IS NULL ORDER BY createdAt DESC",
          schoolId,
          role
        )
      : await all(
          "SELECT id, name, email, role, phone, createdAt, isActive FROM users WHERE schoolId = ? AND deletedAt IS NULL ORDER BY createdAt DESC",
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
    if (await get("SELECT id FROM users WHERE schoolId = ? AND email = ? AND deletedAt IS NULL", schoolId, emailNorm)) {
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
    const { id, name, email, phone, password, isActive } = await req.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const existing = await get<{ id: string; role: string; email: string; isActive: number }>(
      "SELECT id, role, email, isActive FROM users WHERE id = ? AND schoolId = ? AND deletedAt IS NULL", id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    const changed: string[] = [];
    let revoke = false;
    if (name !== undefined && String(name).trim()) {
      updates.push("name = ?");
      params.push(String(name).trim());
      changed.push("name");
    }
    if (email !== undefined && String(email).trim()) {
      const emailNorm = String(email).toLowerCase().trim();
      const clash = await get(
        "SELECT id FROM users WHERE schoolId = ? AND email = ? AND id != ? AND deletedAt IS NULL",
        schoolId, emailNorm, id
      );
      if (clash) return NextResponse.json({ error: "That email is already registered in this school" }, { status: 409 });
      if (emailNorm !== existing.email) revoke = true;
      updates.push("email = ?");
      params.push(emailNorm);
      changed.push("email");
    }
    if (phone !== undefined) {
      updates.push("phone = ?");
      params.push(String(phone).trim() || null);
      changed.push("phone");
    }
    if (password !== undefined && String(password)) {
      if (String(password).length < 8) {
        return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
      }
      updates.push("passwordHash = ?");
      params.push(await hashPassword(String(password)));
      changed.push("password");
      revoke = true; // password change invalidates all existing sessions
    }
    if (isActive !== undefined) {
      const active = isActive ? 1 : 0;
      if (active !== (existing.isActive ?? 1)) {
        updates.push("isActive = ?");
        params.push(active);
        changed.push(active ? "reactivated" : "disabled");
        revoke = true; // disable (or re-enable) invalidates old tokens
      }
    }
    if (updates.length > 0) {
      await run(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, ...params, id);
    }
    if (revoke) await bumpTokenVersion(id);
    if (changed.length > 0) {
      await writeAudit({
        schoolId, userId: session.userId, action: "user.updated", entity: "User", entityId: id,
        details: { fields: changed },
      });
    }
    const user = await get("SELECT id, name, email, role, phone, isActive FROM users WHERE id = ?", id);
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
    const existing = await get<{ id: string; role: string; name: string; email: string }>(
      "SELECT id, role, name, email FROM users WHERE id = ? AND schoolId = ? AND deletedAt IS NULL", id, schoolId
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
        "SELECT COUNT(*) AS n FROM users WHERE schoolId = ? AND role = 'SCHOOL_ADMIN' AND id != ? AND deletedAt IS NULL",
        schoolId, id
      );
      if ((others?.n ?? 0) === 0) {
        return NextResponse.json(
          { error: "Cannot delete the last school admin" },
          { status: 409 }
        );
      }
    }
    // Soft-delete (Phase 2.6): the row stays, so attendance marks, grades,
    // announcements and audit history that reference this user stay valid
    // and attributable — no reassignment hack, no silent history loss.
    // isActive = 0 + tokenVersion bump revoke all sessions immediately.
    // Every live listing/roster query excludes deletedAt IS NOT NULL, and
    // the export excludes soft-deleted users, so the user simply vanishes
    // from the live product while remaining restorable by clearing deletedAt.
    await run(
      "UPDATE users SET deletedAt = ?, isActive = 0, tokenVersion = tokenVersion + 1 WHERE id = ?",
      nowIso(), id
    );
    await writeAudit({
      schoolId, userId: session.userId, action: "user.soft_deleted", entity: "User", entityId: id,
      details: { name: existing.name, email: existing.email, role: existing.role },
    });
    return NextResponse.json({ deleted: true, softDeleted: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export const dynamic = "force-dynamic";
