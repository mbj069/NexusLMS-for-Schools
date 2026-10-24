import { NextRequest, NextResponse } from "next/server";
import { get, run, uid, isUniqueViolation } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse, writeAudit } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/** Add a section to an existing class. */
export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { classId, name, classTeacherId } = await req.json();
    if (!classId || !String(name).trim()) {
      return NextResponse.json({ error: "classId and name are required" }, { status: 400 });
    }
    const cls = await get(
      "SELECT id FROM classes WHERE id = ? AND schoolId = ?", classId, schoolId
    );
    if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

    let teacherId: string | null = null;
    if (classTeacherId) {
      const t = await get(
        "SELECT id FROM users WHERE id = ? AND schoolId = ? AND role = 'TEACHER' AND deletedAt IS NULL AND isActive = 1",
        classTeacherId, schoolId
      );
      if (!t) return NextResponse.json({ error: "Teacher not found in this school" }, { status: 404 });
      teacherId = classTeacherId;
    }
    const id = uid();
    try {
      await run(
        "INSERT INTO sections (id, schoolId, classId, name, classTeacherId) VALUES (?,?,?,?,?)",
        id, schoolId, classId, String(name).trim(), teacherId
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        return NextResponse.json({ error: "That section already exists in this class" }, { status: 409 });
      }
      throw e;
    }
    return NextResponse.json({ section: { id, name: String(name).trim() } }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { id, name, classTeacherId } = await req.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const existing = await get<{ id: string; classId: string }>(
      "SELECT id, classId FROM sections WHERE id = ? AND schoolId = ?", id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Section not found" }, { status: 404 });

    const updates: string[] = [];
    const params: (string | null)[] = [];
    if (name !== undefined && String(name).trim()) {
      updates.push("name = ?");
      params.push(String(name).trim());
    }
    if (classTeacherId !== undefined) {
      if (classTeacherId) {
        const t = await get(
          "SELECT id FROM users WHERE id = ? AND schoolId = ? AND role = 'TEACHER' AND deletedAt IS NULL AND isActive = 1",
          classTeacherId, schoolId
        );
        if (!t) return NextResponse.json({ error: "Teacher not found in this school" }, { status: 404 });
        updates.push("classTeacherId = ?");
        params.push(classTeacherId);
      } else {
        updates.push("classTeacherId = NULL");
      }
    }
    if (updates.length > 0) {
      try {
        await run(`UPDATE sections SET ${updates.join(", ")} WHERE id = ?`, ...params, id);
      } catch (e) {
        if (isUniqueViolation(e)) {
          return NextResponse.json({ error: "That section already exists in this class" }, { status: 409 });
        }
        throw e;
      }
    }
    return NextResponse.json({ updated: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const existing = await get("SELECT id FROM sections WHERE id = ? AND schoolId = ?", id, schoolId);
    if (!existing) return NextResponse.json({ error: "Section not found" }, { status: 404 });
    const counts = await get<{ students: number; subjects: number }>(
      `SELECT (SELECT COUNT(*) FROM enrollments WHERE sectionId = ?) AS students,
              (SELECT COUNT(*) FROM class_subjects WHERE sectionId = ?) AS subjects`,
      id, id
    );
    // Cascades: enrollments / class_subjects / timetable / attendance.
    await run("DELETE FROM sections WHERE id = ?", id);
    await writeAudit({ schoolId, userId: session.userId, action: "section.deleted", entity: "Section", entityId: id, details: { studentsRemoved: counts?.students ?? 0, subjectsRemoved: counts?.subjects ?? 0 } });
    return NextResponse.json({
      deleted: true,
      studentsRemoved: counts?.students ?? 0,
      subjectsRemoved: counts?.subjects ?? 0,
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
