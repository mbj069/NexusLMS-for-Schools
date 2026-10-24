import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, nowIso } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse, writeAudit } from "@/lib/tenant";
import { getClassSubject, teacherCanTeach, roleFilterSql } from "@/lib/phase3";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("PARENT");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const classSubjectId = req.nextUrl.searchParams.get("classSubjectId");
    const filter = roleFilterSql(session);
    let sql = `SELECT a.id, a.classSubjectId, a.title, a.description, a.dueDate, a.totalMarks, a.createdAt,
        sub.name AS subjectName, sec.name AS sectionName, c.name AS className,
        (SELECT COUNT(*) FROM submissions s WHERE s.assignmentId = a.id) AS submissionCount
      FROM assignments a
      JOIN class_subjects cs ON cs.id = a.classSubjectId
      JOIN subjects sub ON sub.id = cs.subjectId
      JOIN sections sec ON sec.id = cs.sectionId
      JOIN classes c ON c.id = sec.classId
      WHERE a.schoolId = ? ${filter.sql}`;
    const params: (string | null)[] = [schoolId, ...filter.params];
    if (classSubjectId) {
      sql += " AND a.classSubjectId = ?";
      params.push(classSubjectId);
    }
    sql += " ORDER BY a.dueDate ASC, a.createdAt DESC";
    const assignments = await all<{
      id: string;
      classSubjectId: string;
      title: string;
      description: string;
      dueDate: string;
      totalMarks: number;
      createdAt: string;
      subjectName: string;
      sectionName: string;
      className: string;
      submissionCount: number;
    }>(sql, ...params);
    // For students, attach their own submission (marks/feedback) to each row.
    let withMine = assignments;
    if (session.role === "STUDENT") {
      const ids = assignments.map((a) => a.id);
      const mine = new Map<string, unknown>();
      if (ids.length) {
        const rows = await all<{ assignmentId: string; content: string; submittedAt: string; marks: number | null; feedback: string | null }>(
          `SELECT assignmentId, content, submittedAt, marks, feedback FROM submissions WHERE studentId = ? AND assignmentId IN (${ids.map(() => "?").join(",")})`,
          session.userId, ...ids
        );
        for (const r of rows) mine.set(r.assignmentId, r);
      }
      withMine = assignments.map((a) => ({ ...a, mySubmission: mine.get(a.id) ?? null }));
    }
    return NextResponse.json({ assignments: withMine });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { classSubjectId, title, description, dueDate, totalMarks } = await req.json();
    if (!classSubjectId || !title || !description || !dueDate || totalMarks === undefined) {
      return NextResponse.json({ error: "Subject, title, description, due date and total marks are required" }, { status: 400 });
    }
    if (Number(totalMarks) <= 0) return NextResponse.json({ error: "Total marks must be greater than 0" }, { status: 400 });
    const cs = await getClassSubject(schoolId, classSubjectId);
    if (!cs) return NextResponse.json({ error: "Subject assignment not found in this school" }, { status: 404 });
    if (!teacherCanTeach(session, cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    const id = uid();
    await run(
      "INSERT INTO assignments (id, schoolId, classSubjectId, title, description, dueDate, totalMarks, createdAt) VALUES (?,?,?,?,?,?,?,?)",
      id, schoolId, classSubjectId, String(title).trim(), String(description), String(dueDate), Number(totalMarks), nowIso()
    );
    await writeAudit({ schoolId, userId: session.userId, action: "assignment.created", entity: "Assignment", entityId: id, details: { classSubjectId, title: String(title).trim(), totalMarks: Number(totalMarks) } });
    return NextResponse.json({ assignment: { id, classSubjectId, title: String(title).trim() } }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { id, title, description, dueDate, totalMarks } = await req.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const existing = await get<{ id: string; classSubjectId: string }>(
      "SELECT id, classSubjectId FROM assignments WHERE id = ? AND schoolId = ?", id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    const cs = await getClassSubject(schoolId, existing.classSubjectId);
    if (!cs || !teacherCanTeach(session, cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    if (title !== undefined && String(title).trim()) { updates.push("title = ?"); params.push(String(title).trim()); }
    if (description !== undefined) { updates.push("description = ?"); params.push(String(description)); }
    if (dueDate !== undefined) { updates.push("dueDate = ?"); params.push(String(dueDate)); }
    if (totalMarks !== undefined) {
      if (Number(totalMarks) <= 0) return NextResponse.json({ error: "Total marks must be greater than 0" }, { status: 400 });
      updates.push("totalMarks = ?"); params.push(Number(totalMarks));
    }
    if (updates.length > 0) await run(`UPDATE assignments SET ${updates.join(", ")} WHERE id = ?`, ...params, id);
    await writeAudit({ schoolId, userId: session.userId, action: "assignment.updated", entity: "Assignment", entityId: id });
    return NextResponse.json({ updated: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const existing = await get<{ id: string; classSubjectId: string; title: string }>(
      "SELECT id, classSubjectId, title FROM assignments WHERE id = ? AND schoolId = ?", id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    const cs = await getClassSubject(schoolId, existing.classSubjectId);
    if (!cs || !teacherCanTeach(session, cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    await run("DELETE FROM assignments WHERE id = ?", id);
    await writeAudit({ schoolId, userId: session.userId, action: "assignment.deleted", entity: "Assignment", entityId: id, details: { title: existing.title } });
    return NextResponse.json({ deleted: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}
