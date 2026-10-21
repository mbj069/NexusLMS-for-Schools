import { NextRequest, NextResponse } from "next/server";
import { all } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse } from "@/lib/tenant";

export const dynamic = "force-dynamic";

interface SectionInfo {
  id: string;
  name: string;
  className: string;
  context?: string; // e.g. child name for parents
  studentId?: string;
  studentName?: string;
}

/**
 * Sections relevant to the caller:
 * - SCHOOL_ADMIN / SUPER_ADMIN: every section in the school
 * - TEACHER: sections they teach or are class-teacher of
 * - STUDENT: sections they're enrolled in
 * - PARENT: sections of their linked children (with child name as context)
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("PARENT");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);

    const shape = (r: { id: string; name: string; className: string; context?: string }): SectionInfo => ({
      id: r.id,
      name: r.name,
      className: r.className,
      ...(r.context ? { context: r.context } : {}),
    });

    if (session.role === "SCHOOL_ADMIN" || session.role === "SUPER_ADMIN") {
      const rows = await all<{ id: string; name: string; className: string }>(
        `SELECT s.id, s.name, c.name AS className
         FROM sections s JOIN classes c ON c.id = s.classId
         WHERE s.schoolId = ? ORDER BY c.name ASC, s.name ASC`,
        schoolId
      );
      return NextResponse.json({ sections: rows.map(shape) });
    }

    if (session.role === "TEACHER") {
      const rows = await all<{ id: string; name: string; className: string }>(
        `SELECT DISTINCT s.id, s.name, c.name AS className
         FROM sections s
         JOIN classes c ON c.id = s.classId
         LEFT JOIN class_subjects cs ON cs.sectionId = s.id AND cs.teacherId = ?
         WHERE s.schoolId = ? AND (cs.id IS NOT NULL OR s.classTeacherId = ?)
         ORDER BY c.name ASC, s.name ASC`,
        session.userId,
        schoolId,
        session.userId
      );
      return NextResponse.json({ sections: rows.map(shape) });
    }

    if (session.role === "STUDENT") {
      const rows = await all<{ id: string; name: string; className: string }>(
        `SELECT s.id, s.name, c.name AS className
         FROM enrollments e
         JOIN sections s ON s.id = e.sectionId
         JOIN classes c ON c.id = s.classId
         WHERE e.studentId = ? AND e.schoolId = ?
         ORDER BY c.name ASC, s.name ASC`,
        session.userId,
        schoolId
      );
      return NextResponse.json({ sections: rows.map(shape) });
    }

    // PARENT
    const rows = await all<{
      id: string;
      name: string;
      className: string;
      context: string;
      studentId: string;
      studentName: string;
    }>(
      `SELECT s.id, s.name, c.name AS className, u.name AS context,
              u.id AS studentId, u.name AS studentName
       FROM parent_children pc
       JOIN users u ON u.id = pc.studentId
       JOIN enrollments e ON e.studentId = u.id
       JOIN sections s ON s.id = e.sectionId
       JOIN classes c ON c.id = s.classId
       WHERE pc.parentId = ? AND e.schoolId = ?
       ORDER BY u.name ASC, c.name ASC, s.name ASC`,
      session.userId,
      schoolId
    );
    return NextResponse.json({
      sections: rows.map((r) => ({
        ...shape(r),
        studentId: r.studentId,
        studentName: r.studentName,
      })),
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
