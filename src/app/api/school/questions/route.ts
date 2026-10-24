import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse, writeAudit } from "@/lib/tenant";
import { getClassSubject, teacherCanTeach, canReadClassSubject } from "@/lib/phase3";

export const dynamic = "force-dynamic";

async function quizInSchool(schoolId: string, quizId: string) {
  const quiz = await get<{ id: string; schoolId: string; classSubjectId: string }>(
    "SELECT id, schoolId, classSubjectId FROM quizzes WHERE id = ? AND schoolId = ?",
    quizId, schoolId
  );
  if (!quiz) return null;
  const cs = await getClassSubject(schoolId, quiz.classSubjectId);
  if (!cs) return null;
  return { quiz, cs };
}

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("PARENT");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const quizId = req.nextUrl.searchParams.get("quizId");
    if (!quizId) return NextResponse.json({ error: "quizId is required" }, { status: 400 });
    const found = await quizInSchool(schoolId, quizId);
    if (!found) return NextResponse.json({ error: "Quiz not found in this school" }, { status: 404 });
    if (!(await canReadClassSubject(session, found.cs))) {
      return NextResponse.json({ error: "Not your subject" }, { status: 403 });
    }
    // Students and parents NEVER receive correctAnswer through this API —
    // otherwise a student could read the answer key before attempting.
    const isStaff = session.role === "TEACHER" || session.role === "SCHOOL_ADMIN" || session.role === "SUPER_ADMIN";
    const rows = await all(
      isStaff
        ? "SELECT id, quizId, text, type, optionsJson, correctAnswer, marks FROM questions WHERE quizId = ? ORDER BY rowid ASC"
        : "SELECT id, quizId, text, type, optionsJson, marks FROM questions WHERE quizId = ? ORDER BY rowid ASC",
      quizId
    );
    return NextResponse.json({ questions: rows });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { quizId, text, type, options, correctAnswer, marks } = await req.json();
    if (!quizId || !text || !type || marks === undefined) {
      return NextResponse.json({ error: "Quiz, question text, type and marks are required" }, { status: 400 });
    }
    if (type !== "MCQ" && type !== "SHORT") return NextResponse.json({ error: "Type must be MCQ or SHORT" }, { status: 400 });
    if (Number(marks) <= 0) return NextResponse.json({ error: "Marks must be greater than 0" }, { status: 400 });
    const found = await quizInSchool(schoolId, quizId);
    if (!found) return NextResponse.json({ error: "Quiz not found in this school" }, { status: 404 });
    if (!teacherCanTeach(session, found.cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    let optionsJson: string | null = null;
    if (type === "MCQ") {
      const opts = Array.isArray(options) ? options.map((o: unknown) => String(o).trim()).filter(Boolean) : [];
      if (opts.length < 2) return NextResponse.json({ error: "MCQ needs at least 2 options" }, { status: 400 });
      if (!correctAnswer || !opts.includes(String(correctAnswer).trim())) {
        return NextResponse.json({ error: "Correct answer must be one of the options" }, { status: 400 });
      }
      optionsJson = JSON.stringify(opts);
    }
    const id = uid();
    await run(
      "INSERT INTO questions (id, schoolId, quizId, text, type, optionsJson, correctAnswer, marks) VALUES (?,?,?,?,?,?,?,?)",
      id, schoolId, quizId, String(text).trim(), type, optionsJson, correctAnswer ? String(correctAnswer).trim() : null, Number(marks)
    );
    return NextResponse.json({ question: { id } }, { status: 201 });
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
    const existing = await get<{ id: string; quizId: string }>(
      "SELECT id, quizId FROM questions WHERE id = ? AND schoolId = ?", id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Question not found" }, { status: 404 });
    const found = await quizInSchool(schoolId, existing.quizId);
    if (!found || !teacherCanTeach(session, found.cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    await run("DELETE FROM questions WHERE id = ?", id);
    await writeAudit({ schoolId, userId: session.userId, action: "question.deleted", entity: "Question", entityId: id, details: { quizId: existing.quizId } });
    return NextResponse.json({ deleted: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}
