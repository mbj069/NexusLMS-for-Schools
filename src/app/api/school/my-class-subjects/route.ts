import { NextRequest, NextResponse } from "next/server";
import { all } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse } from "@/lib/tenant";
import { roleFilterSql } from "@/lib/phase3";

export const dynamic = "force-dynamic";

/**
 * GET /api/school/my-class-subjects — the subject list a caller may actually
 * see, filtered by role (admin: all, teacher: own, student: enrolled
 * sections, parent: children's sections). Phase 3 pages pick from this,
 * so a student or parent can never be offered a subject they cannot read.
 * (The older /api/school/class-subjects GET requires TEACHER+, so students
 * and parents cannot use it at all.)
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("PARENT");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const sectionId = req.nextUrl.searchParams.get("sectionId");
    const filter = roleFilterSql(session);
    let sql = `SELECT cs.id,
        sub.name AS subjectName,
        t.id AS teacherId, t.name AS teacherName,
        sec.id AS sectionId, sec.name AS sectionName,
        c.name AS className
      FROM class_subjects cs
      JOIN subjects sub ON sub.id = cs.subjectId
      JOIN users t ON t.id = cs.teacherId AND t.deletedAt IS NULL
      JOIN sections sec ON sec.id = cs.sectionId
      JOIN classes c ON c.id = sec.classId
      WHERE cs.schoolId = ? ${filter.sql}`;
    const params: (string | null)[] = [schoolId, ...filter.params];
    if (sectionId) {
      sql += " AND cs.sectionId = ?";
      params.push(sectionId);
    }
    sql += " ORDER BY c.name ASC, sec.name ASC, sub.name ASC";
    const rows = await all<{
      id: string;
      subjectName: string;
      teacherId: string;
      teacherName: string;
      sectionId: string;
      sectionName: string;
      className: string;
    }>(sql, ...params);
    return NextResponse.json({
      classSubjects: rows.map((r) => ({
        id: r.id,
        subject: { name: r.subjectName },
        teacher: { id: r.teacherId, name: r.teacherName },
        section: { id: r.sectionId, name: r.sectionName, class: { name: r.className } },
      })),
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
