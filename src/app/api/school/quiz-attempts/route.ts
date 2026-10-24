import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, nowIso } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse, writeAudit } from "@/lib/tenant";
import { getClassSubject, teacherCanTeach, studentEnrolledInSection, childOf, canReadClassSubject } from "@/lib/phase3";

export const dynamic = "force-dynamic";

async function quizInSchool(schoolId: string, quizId: string) {
  const quiz = await get<{ id: string; schoolId: string; classSubjectId: string; totalMarks: number }>(
    "SELECT id, schoolId, classSubjectId, totalMarks FROM quizzes WHERE id = ? AND schoolId = ?",
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

    if (session.role === "STUDENT") {
      const rows = await all(
        "SELECT id, quizId, studentId, answersJson, score, submittedAt FROM quiz_attempts WHERE quizId = ? AND studentId = ? AND schoolId = ?",
        quizId, session.userId, schoolId
      );
      return NextResponse.json({ attempts: rows });
    }
    if (session.role === "PARENT") {
      const childId = req.nextUrl.searchParams.get("studentId");
      if (!childId || !(await childOf(session.userId, childId))) {
        return NextResponse.json({ error: "Not your child" }, { status: 403 });
      }
      const rows = await all(
        "SELECT id, quizId, studentId, answersJson, score, submittedAt FROM quiz_attempts WHERE quizId = ? AND studentId = ? AND schoolId = ?",
        quizId, childId, schoolId
      );
      return NextResponse.json({ attempts: rows });
    }
    if (!teacherCanTeach(session, found.cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    const rows = await all(
      `SELECT a.id, a.quizId, a.studentId, u.name AS studentName, a.answersJson, a.score, a.submittedAt
       FROM quiz_attempts a JOIN users u ON u.id = a.studentId
       WHERE a.quizId = ? AND a.schoolId = ? ORDER BY u.name ASC`,
      quizId, schoolId
    );
    return NextResponse.json({ attempts: rows });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  // Student attempts a quiz exactly once. MCQ questions are auto-graded;
  // SHORT questions score 0 at submission and await teacher marking
  // (PUT below), which sets the final score.
  try {
    const session = await requireAuth("STUDENT");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    if (session.role !== "STUDENT") {
      return NextResponse.json({ error: "Only students attempt quizzes" }, { status: 403 });
    }
    const { quizId, answers } = await req.json() as { quizId?: string; answers?: { questionId: string; answer: string }[] };
    if (!quizId || !Array.isArray(answers)) {
      return NextResponse.json({ error: "Quiz and answers are required" }, { status: 400 });
    }
    const found = await quizInSchool(schoolId, quizId);
    if (!found) return NextResponse.json({ error: "Quiz not found in this school" }, { status: 404 });
    if (!(await canReadClassSubject(session, found.cs))) {
      return NextResponse.json({ error: "You are not enrolled in this section" }, { status: 403 });
    }
    if (!(await studentEnrolledInSection(session.userId, found.cs.sectionId))) {
      return NextResponse.json({ error: "You are not enrolled in this section" }, { status: 403 });
    }
    const existing = await get(
      "SELECT id FROM quiz_attempts WHERE quizId = ? AND studentId = ?",
      quizId, session.userId
    );
    if (existing) return NextResponse.json({ error: "You have already attempted this quiz" }, { status: 409 });
    const questions = await all<{ id: string; type: string; correctAnswer: string | null; marks: number }>(
      "SELECT id, type, correctAnswer, marks FROM questions WHERE quizId = ? AND schoolId = ?",
      quizId, schoolId
    );
    const byId = new Map(questions.map((q) => [q.id, q]));
    let score = 0;
    let hasShort = false;
    for (const a of answers) {
      const q = byId.get(a.questionId);
      if (!q) return NextResponse.json({ error: "An answer refers to a question that is not in this quiz" }, { status: 400 });
      if (q.type === "MCQ") {
        if (q.correctAnswer !== null && String(a.answer).trim() === q.correctAnswer) score += q.marks;
      } else {
        hasShort = true;
      }
    }
    const id = uid();
    await run(
      "INSERT INTO quiz_attempts (id, schoolId, quizId, studentId, answersJson, score, submittedAt) VALUES (?,?,?,?,?,?,?)",
      id, schoolId, quizId, session.userId, JSON.stringify(answers), score, nowIso()
    );
    return NextResponse.json({ attempt: { id, score, hasShortAnswer: hasShort } }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  // Teacher sets the final score for an attempt (used for SHORT questions,
  // and to correct an auto-grade). Audited old -> new.
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { id, score } = await req.json();
    if (!id || score === undefined) {
      return NextResponse.json({ error: "id and score are required" }, { status: 400 });
    }
    const existing = await get<{ id: string; quizId: string; studentId: string; score: number | null }>(
      "SELECT id, quizId, studentId, score FROM quiz_attempts WHERE id = ? AND schoolId = ?",
      id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Attempt not found" }, { status: 404 });
    const found = await quizInSchool(schoolId, existing.quizId);
    if (!found || !teacherCanTeach(session, found.cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    if (Number(score) < 0 || Number(score) > found.quiz.totalMarks) {
      return NextResponse.json({ error: `Score must be between 0 and ${found.quiz.totalMarks}` }, { status: 400 });
    }
    await run("UPDATE quiz_attempts SET score = ? WHERE id = ?", Number(score), id);
    await writeAudit({
      schoolId, userId: session.userId, action: "quiz_attempt.graded", entity: "QuizAttempt", entityId: id,
      details: { quizId: existing.quizId, studentId: existing.studentId, oldScore: existing.score, newScore: Number(score) },
    });
    return NextResponse.json({ updated: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}
