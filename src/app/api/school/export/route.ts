import { NextRequest, NextResponse } from "next/server";
import { all } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * GET /api/school/export — one-click backup of the caller's whole school workspace.
 *
 * - SCHOOL_ADMIN only, hard-scoped to their own school (multi-tenancy enforced
 *   by requireSchoolScope, same as every other school route).
 * - Users are exported WITHOUT passwordHash — the backup contains data, not credentials.
 * - submissions / questions / quiz_attempts carry no schoolId column; they are
 *   scoped through their parent assignmentId / quizId.
 * - Served as a file download so a school admin can keep their own copy.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);

    const school = await all(
      "SELECT id, name, slug, logoUrl, primaryColor, phone, address, createdAt FROM schools WHERE id = ?",
      schoolId
    );
    const academic_sessions = await all(
      "SELECT id, schoolId, name, startDate, endDate, isCurrent FROM academic_sessions WHERE schoolId = ? ORDER BY startDate",
      schoolId
    );
    const classes = await all(
      "SELECT id, schoolId, sessionId, name FROM classes WHERE schoolId = ?",
      schoolId
    );
    const sections = await all(
      "SELECT id, schoolId, classId, name, classTeacherId FROM sections WHERE schoolId = ?",
      schoolId
    );
    const subjects = await all(
      "SELECT id, schoolId, name, code FROM subjects WHERE schoolId = ?",
      schoolId
    );
    // Deliberately omits passwordHash — this file should never hold credentials.
    const users = await all(
      "SELECT id, schoolId, name, email, role, phone, createdAt, isActive FROM users WHERE schoolId = ? AND deletedAt IS NULL",
      schoolId
    );
    const class_subjects = await all(
      "SELECT id, schoolId, sectionId, subjectId, teacherId FROM class_subjects WHERE schoolId = ?",
      schoolId
    );
    const parent_children = await all(
      "SELECT id, schoolId, parentId, studentId FROM parent_children WHERE schoolId = ?",
      schoolId
    );
    const enrollments = await all(
      "SELECT id, schoolId, studentId, sectionId, rollNumber FROM enrollments WHERE schoolId = ?",
      schoolId
    );
    const timetable_slots = await all(
      "SELECT id, schoolId, sectionId, dayOfWeek, periodNumber, startTime, endTime, classSubjectId FROM timetable_slots WHERE schoolId = ?",
      schoolId
    );
    const attendance_records = await all(
      "SELECT id, schoolId, sectionId, date, studentId, status, markedById FROM attendance_records WHERE schoolId = ?",
      schoolId
    );
    const lessons = await all(
      "SELECT id, schoolId, classSubjectId, title, content, createdAt FROM lessons WHERE schoolId = ?",
      schoolId
    );
    const assignments = await all(
      "SELECT id, schoolId, classSubjectId, title, description, dueDate, totalMarks, createdAt FROM assignments WHERE schoolId = ?",
      schoolId
    );
    const quizzes = await all(
      "SELECT id, schoolId, classSubjectId, title, description, dueDate, totalMarks, createdAt FROM quizzes WHERE schoolId = ?",
      schoolId
    );

    const assignmentIds = (assignments as { id: string }[]).map((a) => a.id);
    const quizIds = (quizzes as { id: string }[]).map((q) => q.id);
    const inPlaceholders = (ids: string[]) => ids.map(() => "?").join(",");

    const submissions = assignmentIds.length
      ? await all(
          `SELECT id, assignmentId, studentId, content, submittedAt, marks, feedback FROM submissions WHERE assignmentId IN (${inPlaceholders(assignmentIds)})`,
          ...assignmentIds
        )
      : [];
    const questions = quizIds.length
      ? await all(
          `SELECT id, quizId, text, type, optionsJson, correctAnswer, marks FROM questions WHERE quizId IN (${inPlaceholders(quizIds)})`,
          ...quizIds
        )
      : [];
    const quiz_attempts = quizIds.length
      ? await all(
          `SELECT id, quizId, studentId, answersJson, score, submittedAt FROM quiz_attempts WHERE quizId IN (${inPlaceholders(quizIds)})`,
          ...quizIds
        )
      : [];

    const grades = await all(
      "SELECT id, schoolId, studentId, classSubjectId, term, marksObtained, totalMarks FROM grades WHERE schoolId = ?",
      schoolId
    );
    const announcements = await all(
      "SELECT id, schoolId, title, body, audience, sectionId, createdById, createdAt FROM announcements WHERE schoolId = ?",
      schoolId
    );
    const audit_logs = await all(
      "SELECT id, schoolId, userId, action, entity, entityId, details, createdAt FROM audit_logs WHERE schoolId = ?",
      schoolId
    );

    const slug = ((school[0] as { slug?: string } | undefined)?.slug ?? "school")
      .replace(/[^a-z0-9-]/gi, "-")
      .toLowerCase();
    const date = new Date().toISOString().slice(0, 10);
    const filename = `nexuslms-backup-${slug}-${date}.json`;

    const payload = {
      product: "NexusLMS",
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: session.email,
      school: (school[0] as object | undefined) ?? null,
      data: {
        academic_sessions,
        classes,
        sections,
        subjects,
        users,
        class_subjects,
        parent_children,
        enrollments,
        timetable_slots,
        attendance_records,
        lessons,
        assignments,
        submissions,
        quizzes,
        questions,
        quiz_attempts,
        grades,
        announcements,
        audit_logs,
      },
    };

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}
