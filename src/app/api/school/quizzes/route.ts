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
    let sql = `SELECT q.id, q.classSubjectId, q.title, q.description, q.dueDate, q.totalMarks, q.createdAt,
        sub.name AS subjectName, sec.name AS sectionName, c.name AS className,
        (SELECT COUNT(*) FROM questions qq WHERE qq.quizId = q.id) AS questionCount
      FROM quizzes q
      JOIN class_subjects cs ON cs.id = q.classSubjectId
      JOIN subjects sub ON sub.id = cs.subjectId
      JOIN sections sec ON sec.id = cs.sectionId
      JOIN classes c ON c.id = sec.classId
      WHERE q.schoolId = ? ${filter.sql}`;
    const params: (string | null)[] = [schoolId, ...filter.params];
    if (classSubjectId) {
      sql += " AND q.classSubjectId = ?";
      params.push(classSubjectId);
    }
    sql += " ORDER BY q.dueDate ASC, q.createdAt DESC";
    const quizzes = await all(sql, ...params);
    let withMine = quizzes as Record<string, unknown>[];
    if (session.role === "STUDENT") {
      const ids = (quizzes as { id: string }[]).map((q) => q.id);
      const mine = new Map<string, unknown>();
      if (ids.length) {
        const rows = await all<{ quizId: string; score: number | null; submittedAt: string }>(
          `SELECT quizId, score, submittedAt FROM quiz_attempts WHERE studentId = ? AND quizId IN (${ids.map(() => "?").join(",")})`,
          session.userId, ...ids
        );
        for (const r of rows) mine.set(r.quizId, r);
      }
      withMine = (quizzes as Record<string, unknown>[]).map((q) => ({ ...q, myAttempt: mine.get(String(q.id)) ?? null }));
    }
    return NextResponse.json({ quizzes: withMine });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { classSubjectId, title, description, dueDate, totalMarks } = await req.json();
    if (!classSubjectId || !title || totalMarks === undefined) {
      return NextResponse.json({ error: "Subject, title and total marks are required" }, { status: 400 });
    }
    if (Number(totalMarks) <= 0) return NextResponse.json({ error: "Total marks must be greater than 0" }, { status: 400 });
    const cs = await getClassSubject(schoolId, classSubjectId);
    if (!cs) return NextResponse.json({ error: "Subject assignment not found in this school" }, { status: 404 });
    if (!teacherCanTeach(session, cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    const id = uid();
    await run(
      "INSERT INTO quizzes (id, schoolId, classSubjectId, title, description, dueDate, totalMarks, createdAt) VALUES (?,?,?,?,?,?,?,?)",
      id, schoolId, classSubjectId, String(title).trim(), description ? String(description) : null, dueDate ? String(dueDate) : null, Number(totalMarks), nowIso()
    );
    await writeAudit({ schoolId, userId: session.userId, action: "quiz.created", entity: "Quiz", entityId: id, details: { classSubjectId, title: String(title).trim() } });
    return NextResponse.json({ quiz: { id } }, { status: 201 });
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
      "SELECT id, classSubjectId FROM quizzes WHERE id = ? AND schoolId = ?", id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
    const cs = await getClassSubject(schoolId, existing.classSubjectId);
    if (!cs || !teacherCanTeach(session, cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    const updates: string[] = [];
    const params: (string | number | null)[] = [];
    if (title !== undefined && String(title).trim()) { updates.push("title = ?"); params.push(String(title).trim()); }
    if (description !== undefined) { updates.push("description = ?"); params.push(description ? String(description) : null); }
    if (dueDate !== undefined) { updates.push("dueDate = ?"); params.push(dueDate ? String(dueDate) : null); }
    if (totalMarks !== undefined) {
      if (Number(totalMarks) <= 0) return NextResponse.json({ error: "Total marks must be greater than 0" }, { status: 400 });
      updates.push("totalMarks = ?"); params.push(Number(totalMarks));
    }
    if (updates.length > 0) await run(`UPDATE quizzes SET ${updates.join(", ")} WHERE id = ?`, ...params, id);
    await writeAudit({ schoolId, userId: session.userId, action: "quiz.updated", entity: "Quiz", entityId: id });
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
      "SELECT id, classSubjectId, title FROM quizzes WHERE id = ? AND schoolId = ?", id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
    const cs = await getClassSubject(schoolId, existing.classSubjectId);
    if (!cs || !teacherCanTeach(session, cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    await run("DELETE FROM quizzes WHERE id = ?", id);
    await writeAudit({ schoolId, userId: session.userId, action: "quiz.deleted", entity: "Quiz", entityId: id, details: { title: existing.title } });
    return NextResponse.json({ deleted: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}
