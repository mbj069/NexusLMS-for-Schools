import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, nowIso } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse, writeAudit } from "@/lib/tenant";
import { getClassSubject, teacherCanTeach, studentEnrolledInSection, childOf } from "@/lib/phase3";

export const dynamic = "force-dynamic";

function gradeShape(r: unknown) {
  return r;
}

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("PARENT");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const p = req.nextUrl.searchParams;
    const classSubjectId = p.get("classSubjectId");
    const sectionId = p.get("sectionId");
    const term = p.get("term");
    let studentId = p.get("studentId");

    // Students and parents may only see their own / their child's grades.
    if (session.role === "STUDENT") {
      if (studentId && studentId !== session.userId) {
        return NextResponse.json({ error: "Not your record" }, { status: 403 });
      }
      studentId = session.userId;
    }
    if (session.role === "PARENT") {
      if (!studentId || !(await childOf(session.userId, studentId))) {
        return NextResponse.json({ error: "Not your child" }, { status: 403 });
      }
    }

    let sql = `SELECT g.id, g.studentId, u.name AS studentName, g.classSubjectId,
        sub.name AS subjectName, sec.id AS sectionId, sec.name AS sectionName, c.name AS className,
        g.term, g.marksObtained, g.totalMarks
      FROM grades g
      JOIN users u ON u.id = g.studentId AND u.deletedAt IS NULL
      JOIN class_subjects cs ON cs.id = g.classSubjectId
      JOIN subjects sub ON sub.id = cs.subjectId
      JOIN sections sec ON sec.id = cs.sectionId
      JOIN classes c ON c.id = sec.classId
      WHERE g.schoolId = ? AND g.deletedAt IS NULL`;
    const params: (string | null)[] = [schoolId];
    if (classSubjectId) { sql += " AND g.classSubjectId = ?"; params.push(classSubjectId); }
    if (sectionId) { sql += " AND cs.sectionId = ?"; params.push(sectionId); }
    if (term) { sql += " AND g.term = ?"; params.push(term); }
    if (studentId) { sql += " AND g.studentId = ?"; params.push(studentId); }
    if (session.role === "TEACHER") {
      sql += " AND cs.teacherId = ?";
      params.push(session.userId);
    }
    sql += " ORDER BY g.term ASC, sub.name ASC, u.name ASC";
    const grades = await all(sql, ...params);

    // Report-card summary when a single student is requested.
    if (studentId && p.get("report") === "1") {
      const byTerm = new Map<string, { subjects: unknown[]; obtained: number; total: number }>();
      for (const g of grades as { term: string; marksObtained: number; totalMarks: number }[]) {
        const t = byTerm.get(g.term) ?? { subjects: [], obtained: 0, total: 0 };
        t.subjects.push(g);
        t.obtained += g.marksObtained;
        t.total += g.totalMarks;
        byTerm.set(g.term, t);
      }
      const terms = [...byTerm.entries()].map(([termName, t]) => ({
        term: termName,
        subjects: t.subjects,
        obtained: t.obtained,
        total: t.total,
        percentage: t.total > 0 ? Math.round((t.obtained / t.total) * 100) : null,
      }));
      const overallObtained = terms.reduce((s, t) => s + t.obtained, 0);
      const overallTotal = terms.reduce((s, t) => s + t.total, 0);
      return NextResponse.json({
        grades: grades.map(gradeShape),
        report: {
          studentId,
          terms,
          overall: {
            obtained: overallObtained,
            total: overallTotal,
            percentage: overallTotal > 0 ? Math.round((overallObtained / overallTotal) * 100) : null,
          },
        },
      });
    }
    return NextResponse.json({ grades: grades.map(gradeShape) });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { studentId, classSubjectId, term, marksObtained, totalMarks } = await req.json();
    if (!studentId || !classSubjectId || !term || marksObtained === undefined || totalMarks === undefined) {
      return NextResponse.json({ error: "Student, subject, term and marks are required" }, { status: 400 });
    }
    if (Number(marksObtained) < 0 || Number(totalMarks) <= 0 || Number(marksObtained) > Number(totalMarks)) {
      return NextResponse.json({ error: "Marks must be between 0 and the total marks" }, { status: 400 });
    }
    const cs = await getClassSubject(schoolId, classSubjectId);
    if (!cs) return NextResponse.json({ error: "Subject assignment not found in this school" }, { status: 404 });
    if (!teacherCanTeach(session, cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    if (!(await studentEnrolledInSection(studentId, cs.sectionId))) {
      return NextResponse.json({ error: "Student is not enrolled in this section" }, { status: 403 });
    }
    const clash = await get(
      "SELECT id FROM grades WHERE studentId = ? AND classSubjectId = ? AND term = ? AND deletedAt IS NULL",
      studentId, classSubjectId, String(term).trim()
    );
    if (clash) return NextResponse.json({ error: "A grade for this student, subject and term already exists — edit it instead" }, { status: 409 });
    const id = uid();
    await run(
      "INSERT INTO grades (id, schoolId, studentId, classSubjectId, term, marksObtained, totalMarks) VALUES (?,?,?,?,?,?,?)",
      id, schoolId, studentId, classSubjectId, String(term).trim(), Number(marksObtained), Number(totalMarks)
    );
    await writeAudit({
      schoolId, userId: session.userId, action: "grade.created", entity: "Grade", entityId: id,
      details: { studentId, classSubjectId, term: String(term).trim(), marksObtained: Number(marksObtained), totalMarks: Number(totalMarks) },
    });
    return NextResponse.json({ grade: { id } }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { id, marksObtained, totalMarks, term } = await req.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const existing = await get<{ id: string; classSubjectId: string; studentId: string; marksObtained: number; totalMarks: number; term: string }>(
      "SELECT id, classSubjectId, studentId, marksObtained, totalMarks, term FROM grades WHERE id = ? AND schoolId = ? AND deletedAt IS NULL",
      id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Grade not found" }, { status: 404 });
    const cs = await getClassSubject(schoolId, existing.classSubjectId);
    if (!cs || !teacherCanTeach(session, cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    const newObtained = marksObtained !== undefined ? Number(marksObtained) : existing.marksObtained;
    const newTotal = totalMarks !== undefined ? Number(totalMarks) : existing.totalMarks;
    if (newObtained < 0 || newTotal <= 0 || newObtained > newTotal) {
      return NextResponse.json({ error: "Marks must be between 0 and the total marks" }, { status: 400 });
    }
    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    if (marksObtained !== undefined) { updates.push("marksObtained = ?"); params.push(newObtained); }
    if (totalMarks !== undefined) { updates.push("totalMarks = ?"); params.push(newTotal); }
    if (term !== undefined && String(term).trim()) { updates.push("term = ?"); params.push(String(term).trim()); }
    if (updates.length > 0) await run(`UPDATE grades SET ${updates.join(", ")} WHERE id = ?`, ...params, id);
    await writeAudit({
      schoolId, userId: session.userId, action: "grade.changed", entity: "Grade", entityId: id,
      details: { studentId: existing.studentId, classSubjectId: existing.classSubjectId, oldMarks: existing.marksObtained, oldTotal: existing.totalMarks, newMarks: newObtained, newTotal, oldTerm: existing.term, newTerm: term ?? existing.term },
    });
    return NextResponse.json({ updated: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  // Soft-delete: grade history is never silently erased (Phase 2.6 rule).
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const existing = await get<{ id: string; classSubjectId: string; studentId: string }>(
      "SELECT id, classSubjectId, studentId FROM grades WHERE id = ? AND schoolId = ? AND deletedAt IS NULL",
      id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Grade not found" }, { status: 404 });
    const cs = await getClassSubject(schoolId, existing.classSubjectId);
    if (!cs || !teacherCanTeach(session, cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    await run("UPDATE grades SET deletedAt = ? WHERE id = ?", nowIso(), id);
    await writeAudit({ schoolId, userId: session.userId, action: "grade.deleted", entity: "Grade", entityId: id, details: { studentId: existing.studentId, classSubjectId: existing.classSubjectId } });
    return NextResponse.json({ deleted: true, softDeleted: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}
