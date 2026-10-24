import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, nowIso, isUniqueViolation, transaction } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse, writeAudit } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const rows = await all<{
      id: string;
      name: string;
      isCurrent: number;
      classCount: number;
    }>(
      `SELECT s.id, s.name, s.isCurrent,
        (SELECT COUNT(*) FROM classes c WHERE c.sessionId = s.id) AS classCount
       FROM academic_sessions s WHERE s.schoolId = ? ORDER BY s.startDate DESC`,
      schoolId
    );
    const sessions = rows.map((r) => ({
      id: r.id,
      name: r.name,
      isCurrent: r.isCurrent === 1,
      _count: { classes: r.classCount },
    }));
    return NextResponse.json({ sessions });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { name, startDate, endDate, isCurrent } = await req.json();
    if (!name || !startDate || !endDate) {
      return NextResponse.json({ error: "Name, start date and end date are required" }, { status: 400 });
    }
    if (await get("SELECT id FROM academic_sessions WHERE schoolId = ? AND name = ?", schoolId, String(name).trim())) {
      return NextResponse.json({ error: "A session with that name already exists" }, { status: 409 });
    }
    const id = uid();
    await transaction(async () => {
      if (isCurrent) {
        await run("UPDATE academic_sessions SET isCurrent = 0 WHERE schoolId = ?", schoolId);
      }
      await run(
        "INSERT INTO academic_sessions (id, schoolId, name, startDate, endDate, isCurrent) VALUES (?,?,?,?,?,?)",
        id,
        schoolId,
        String(name).trim(),
        new Date(startDate).toISOString(),
        new Date(endDate).toISOString(),
        isCurrent ? 1 : 0
      );
    });
    await run(
      "INSERT INTO audit_logs (id, schoolId, userId, action, entity, entityId, createdAt) VALUES (?,?,?,?,?,?,?)",
      uid(),
      schoolId,
      session.userId,
      "session.created",
      "AcademicSession",
      id,
      nowIso()
    );
    const created = await get("SELECT id, name, isCurrent FROM academic_sessions WHERE id = ?", id) as {
      id: string;
      name: string;
      isCurrent: number;
    };
    return NextResponse.json(
      { session: { ...created, isCurrent: created.isCurrent === 1 } },
      { status: 201 }
    );
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: "A session with that name already exists" }, { status: 409 });
    }
    return toErrorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { id, name, startDate, endDate, isCurrent } = await req.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const existing = await get<{ id: string }>(
      "SELECT id FROM academic_sessions WHERE id = ? AND schoolId = ?", id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Session not found" }, { status: 404 });

    const updates: string[] = [];
    const params: (string | number)[] = [];
    if (name !== undefined && String(name).trim()) {
      const clash = await get(
        "SELECT id FROM academic_sessions WHERE schoolId = ? AND name = ? AND id != ?",
        schoolId, String(name).trim(), id
      );
      if (clash) return NextResponse.json({ error: "A session with that name already exists" }, { status: 409 });
      updates.push("name = ?");
      params.push(String(name).trim());
    }
    if (startDate) { updates.push("startDate = ?"); params.push(new Date(startDate).toISOString()); }
    if (endDate) { updates.push("endDate = ?"); params.push(new Date(endDate).toISOString()); }

    await transaction(async () => {
      if (isCurrent) {
        await run("UPDATE academic_sessions SET isCurrent = 0 WHERE schoolId = ?", schoolId);
        updates.push("isCurrent = 1");
      } else if (isCurrent === false) {
        updates.push("isCurrent = 0");
      }
      if (updates.length > 0) {
        await run(`UPDATE academic_sessions SET ${updates.join(", ")} WHERE id = ?`, ...params, id);
      }
    });
    return NextResponse.json({ updated: true });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: "A session with that name already exists" }, { status: 409 });
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
    const existing = await get<{ id: string; isCurrent: number }>(
      "SELECT id, isCurrent FROM academic_sessions WHERE id = ? AND schoolId = ?", id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const classCount = await get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM classes WHERE sessionId = ?", id
    );
    // Cascades: classes → sections → enrollments / class_subjects / timetable / attendance.
    // No user rows are touched, so the teacher-assignment RESTRICT never fires.
    await run("DELETE FROM academic_sessions WHERE id = ?", id);
    await writeAudit({ schoolId, userId: session.userId, action: "session.deleted", entity: "Session", entityId: id, details: { classesRemoved: classCount?.n ?? 0 } });
    return NextResponse.json({ deleted: true, classesRemoved: classCount?.n ?? 0 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export const dynamic = "force-dynamic";
