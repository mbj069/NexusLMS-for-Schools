import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, nowIso } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse, writeAudit } from "@/lib/tenant";
import { getClassSubject, teacherCanTeach, studentEnrolledInSection, childOf } from "@/lib/phase3";

export const dynamic = "force-dynamic";

/**
 * Submissions are text answers (Phase 3 v1 — no file uploads yet, by the
 * hardening decision: files go to object storage with signed URLs, and
 * that is not built until the storage decision is made, rather than
 * storing files in the DB or on the ephemeral app server).
 * Rules: a student may submit once and resubmit while ungraded; once a
 * teacher has marked it, it is locked (409). Grading is assignment
 * grading only — it does not write a gradebook grade (see /grades).
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("PARENT");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const assignmentId = req.nextUrl.searchParams.get("assignmentId");
    if (!assignmentId) return NextResponse.json({ error: "assignmentId is required" }, { status: 400 });
    const assignment = await get<{ id: string; schoolId: string; classSubjectId: string; title: string; totalMarks: number }>(
      "SELECT id, schoolId, classSubjectId, title, totalMarks FROM assignments WHERE id = ? AND schoolId = ?",
      assignmentId, schoolId
    );
    if (!assignment) return NextResponse.json({ error: "Assignment not found in this school" }, { status: 404 });
    const cs = await getClassSubject(schoolId, assignment.classSubjectId);
    if (!cs) return NextResponse.json({ error: "Subject assignment not found" }, { status: 404 });

    if (session.role === "STUDENT") {
      const rows = await all(
        "SELECT id, assignmentId, studentId, content, submittedAt, marks, feedback FROM submissions WHERE assignmentId = ? AND studentId = ?",
        assignmentId, session.userId
      );
      return NextResponse.json({ submissions: rows });
    }
    if (session.role === "PARENT") {
      const childId = req.nextUrl.searchParams.get("studentId");
      if (!childId || !(await childOf(session.userId, childId))) {
        return NextResponse.json({ error: "Not your child" }, { status: 403 });
      }
      const rows = await all(
        "SELECT id, assignmentId, studentId, content, submittedAt, marks, feedback FROM submissions WHERE assignmentId = ? AND studentId = ?",
        assignmentId, childId
      );
      return NextResponse.json({ submissions: rows });
    }
    // TEACHER / ADMIN: must teach this subject (teachers) or be admin.
    if (!teacherCanTeach(session, cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    const rows = await all(
      `SELECT s.id, s.assignmentId, s.studentId, u.name AS studentName, e.rollNumber,
              s.content, s.submittedAt, s.marks, s.feedback
       FROM submissions s
       JOIN users u ON u.id = s.studentId
       LEFT JOIN enrollments e ON e.studentId = s.studentId AND e.sectionId = ?
       WHERE s.assignmentId = ? AND s.schoolId = ?
       ORDER BY u.name ASC`,
      cs.sectionId, assignmentId, schoolId
    );
    return NextResponse.json({ submissions: rows });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("STUDENT");
    if (session.role !== "STUDENT") {
      return NextResponse.json({ error: "Only students submit assignments" }, { status: 403 });
    }
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { assignmentId, content } = await req.json();
    if (!assignmentId || !content) {
      return NextResponse.json({ error: "Assignment and answer text are required" }, { status: 400 });
    }
    const assignment = await get<{ id: string; classSubjectId: string }>(
      "SELECT id, classSubjectId FROM assignments WHERE id = ? AND schoolId = ?",
      assignmentId, schoolId
    );
    if (!assignment) return NextResponse.json({ error: "Assignment not found in this school" }, { status: 404 });
    const cs = await getClassSubject(schoolId, assignment.classSubjectId);
    if (!cs) return NextResponse.json({ error: "Subject assignment not found" }, { status: 404 });
    if (!(await studentEnrolledInSection(session.userId, cs.sectionId))) {
      return NextResponse.json({ error: "You are not enrolled in this section" }, { status: 403 });
    }
    const existing = await get<{ id: string; marks: number | null }>(
      "SELECT id, marks FROM submissions WHERE assignmentId = ? AND studentId = ?",
      assignmentId, session.userId
    );
    if (existing && existing.marks !== null) {
      return NextResponse.json({ error: "This submission has already been graded and cannot be changed" }, { status: 409 });
    }
    if (existing) {
      await run(
        "UPDATE submissions SET content = ?, submittedAt = ? WHERE id = ?",
        String(content), nowIso(), existing.id
      );
      return NextResponse.json({ submission: { id: existing.id, resubmitted: true } });
    }
    const id = uid();
    await run(
      "INSERT INTO submissions (id, schoolId, assignmentId, studentId, content, submittedAt) VALUES (?,?,?,?,?,?)",
      id, schoolId, assignmentId, session.userId, String(content), nowIso()
    );
    return NextResponse.json({ submission: { id } }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  // Grade a submission.
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { id, marks, feedback } = await req.json();
    if (!id || marks === undefined) {
      return NextResponse.json({ error: "id and marks are required" }, { status: 400 });
    }
    const existing = await get<{ id: string; assignmentId: string; studentId: string; marks: number | null }>(
      "SELECT id, assignmentId, studentId, marks FROM submissions WHERE id = ? AND schoolId = ?",
      id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Submission not found" }, { status: 404 });
    const assignment = await get<{ classSubjectId: string; totalMarks: number }>(
      "SELECT classSubjectId, totalMarks FROM assignments WHERE id = ?",
      existing.assignmentId
    );
    if (!assignment) return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    const cs = await getClassSubject(schoolId, assignment.classSubjectId);
    if (!cs || !teacherCanTeach(session, cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    if (Number(marks) < 0 || Number(marks) > assignment.totalMarks) {
      return NextResponse.json({ error: `Marks must be between 0 and ${assignment.totalMarks}` }, { status: 400 });
    }
    await run(
      "UPDATE submissions SET marks = ?, feedback = ? WHERE id = ?",
      Number(marks), feedback !== undefined ? String(feedback) : null, id
    );
    await writeAudit({
      schoolId, userId: session.userId, action: "submission.graded", entity: "Submission", entityId: id,
      details: { assignmentId: existing.assignmentId, studentId: existing.studentId, oldMarks: existing.marks, newMarks: Number(marks) },
    });
    return NextResponse.json({ updated: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}
