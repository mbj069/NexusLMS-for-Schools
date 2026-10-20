import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, isUniqueViolation } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const sectionId = req.nextUrl.searchParams.get("sectionId");
    const teacherId = req.nextUrl.searchParams.get("teacherId");

    let sql = `SELECT cs.id,
        sub.name AS subjectName,
        t.id AS teacherId, t.name AS teacherName,
        sec.id AS sectionId, sec.name AS sectionName,
        c.name AS className
      FROM class_subjects cs
      JOIN subjects sub ON sub.id = cs.subjectId
      JOIN users t ON t.id = cs.teacherId
      JOIN sections sec ON sec.id = cs.sectionId
      JOIN classes c ON c.id = sec.classId
      WHERE cs.schoolId = ?`;
    const params: (string | null)[] = [schoolId];
    if (sectionId) {
      sql += " AND cs.sectionId = ?";
      params.push(sectionId);
    }
    if (teacherId) {
      sql += " AND cs.teacherId = ?";
      params.push(teacherId);
    }
    sql += " ORDER BY sub.name ASC";

    const rows = await all<{
      id: string;
      subjectName: string;
      teacherId: string;
      teacherName: string;
      sectionId: string;
      sectionName: string;
      className: string;
    }>(sql, ...params);

    const classSubjects = rows.map((r) => ({
      id: r.id,
      subject: { name: r.subjectName },
      teacher: { id: r.teacherId, name: r.teacherName },
      section: { id: r.sectionId, name: r.sectionName, class: { name: r.className } },
    }));
    return NextResponse.json({ classSubjects });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { sectionId, subjectId, teacherId } = await req.json();
    if (!sectionId || !subjectId || !teacherId) {
      return NextResponse.json({ error: "Section, subject and teacher are required" }, { status: 400 });
    }
    // Tenant checks: all three must belong to this school
    const section = await get("SELECT id FROM sections WHERE id = ? AND schoolId = ?", sectionId, schoolId);
    const subject = await get<{ id: string; name: string }>(
      "SELECT id, name FROM subjects WHERE id = ? AND schoolId = ?", subjectId, schoolId
    );
    const teacher = await get<{ id: string; name: string }>(
      "SELECT id, name FROM users WHERE id = ? AND schoolId = ? AND role = 'TEACHER'", teacherId, schoolId
    );
    if (!section || !subject || !teacher) {
      return NextResponse.json({ error: "Section, subject or teacher not found in this school" }, { status: 404 });
    }
    const id = uid();
    try {
      await run(
        "INSERT INTO class_subjects (id, schoolId, sectionId, subjectId, teacherId) VALUES (?,?,?,?,?)",
        id, schoolId, sectionId, subjectId, teacherId
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        return NextResponse.json({ error: "That subject is already assigned to this section" }, { status: 409 });
      }
      throw e;
    }
    return NextResponse.json(
      {
        classSubject: {
          id,
          subject: { name: subject.name },
          teacher: { id: teacher.id, name: teacher.name },
        },
      },
      { status: 201 }
    );
  } catch (e) {
    return toErrorResponse(e);
  }
}

export const dynamic = "force-dynamic";
