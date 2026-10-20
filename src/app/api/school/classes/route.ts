import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, nowIso, isUniqueViolation, transaction } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const sessionId = req.nextUrl.searchParams.get("sessionId");

    const classRows = all<{ id: string; name: string; sessionId: string }>(
      sessionId
        ? "SELECT id, name, sessionId FROM classes WHERE schoolId = ? AND sessionId = ? ORDER BY name ASC"
        : "SELECT id, name, sessionId FROM classes WHERE schoolId = ? ORDER BY name ASC",
      ...(sessionId ? [schoolId, sessionId] : [schoolId])
    );

    const classes = classRows.map((c) => {
      const sections = all<{
        id: string;
        name: string;
        teacherId: string | null;
        teacherName: string | null;
        enrollmentCount: number;
        subjectCount: number;
      }>(
        `SELECT s.id, s.name, s.classTeacherId AS teacherId, u.name AS teacherName,
          (SELECT COUNT(*) FROM enrollments e WHERE e.sectionId = s.id) AS enrollmentCount,
          (SELECT COUNT(*) FROM class_subjects cs WHERE cs.sectionId = s.id) AS subjectCount
         FROM sections s LEFT JOIN users u ON u.id = s.classTeacherId
         WHERE s.classId = ? ORDER BY s.name ASC`,
        c.id
      );
      return {
        id: c.id,
        name: c.name,
        sessionId: c.sessionId,
        sections: sections.map((s) => ({
          id: s.id,
          name: s.name,
          classTeacher: s.teacherId ? { id: s.teacherId, name: s.teacherName } : null,
          _count: { enrollments: s.enrollmentCount, classSubjects: s.subjectCount },
        })),
      };
    });

    return NextResponse.json({ classes });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { name, sessionId, sections } = await req.json();
    if (!name || !sessionId) {
      return NextResponse.json({ error: "Name and session are required" }, { status: 400 });
    }
    // Tenant check: the session must belong to this school
    const acad = get("SELECT id FROM academic_sessions WHERE id = ? AND schoolId = ?", sessionId, schoolId);
    if (!acad) return NextResponse.json({ error: "Session not found" }, { status: 404 });

    const names: string[] =
      Array.isArray(sections) && sections.length > 0 ? sections : ["A"];
    const classId = uid();
    try {
      transaction(() => {
        run("INSERT INTO classes (id, schoolId, sessionId, name) VALUES (?,?,?,?)",
          classId, schoolId, sessionId, String(name).trim());
        for (const s of names) {
          run("INSERT INTO sections (id, schoolId, classId, name) VALUES (?,?,?,?)",
            uid(), schoolId, classId, String(s).trim() || "A");
        }
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        return NextResponse.json({ error: "That class already exists in this session" }, { status: 409 });
      }
      throw e;
    }
    run(
      "INSERT INTO audit_logs (id, schoolId, userId, action, entity, entityId, createdAt) VALUES (?,?,?,?,?,?,?)",
      uid(), schoolId, session.userId, "class.created", "Class", classId, nowIso()
    );
    const createdSections = all<{ id: string; name: string }>(
      "SELECT id, name FROM sections WHERE classId = ? ORDER BY name ASC", classId
    );
    return NextResponse.json(
      { class: { id: classId, name: String(name).trim(), sessionId, sections: createdSections } },
      { status: 201 }
    );
  } catch (e) {
    return toErrorResponse(e);
  }
}

export const dynamic = "force-dynamic";
