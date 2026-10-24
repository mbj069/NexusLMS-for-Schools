import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse, writeAudit } from "@/lib/tenant";

export const dynamic = "force-dynamic";

const STATUSES = ["PRESENT", "ABSENT", "LATE", "LEAVE"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

async function sectionInSchool(sectionId: string, schoolId: string) {
  return get<{ id: string; classTeacherId: string | null }>(
    "SELECT id, classTeacherId FROM sections WHERE id = ? AND schoolId = ?",
    sectionId,
    schoolId
  );
}

/** Can this teacher mark/view attendance for the section? */
async function teacherCanAccessSection(
  sectionId: string,
  schoolId: string,
  teacherId: string
): Promise<boolean> {
  const teaches = await get(
    "SELECT id FROM class_subjects WHERE sectionId = ? AND schoolId = ? AND teacherId = ?",
    sectionId,
    schoolId,
    teacherId
  );
  if (teaches) return true;
  const sec = await get(
    "SELECT id FROM sections WHERE id = ? AND schoolId = ? AND classTeacherId = ?",
    sectionId,
    schoolId,
    teacherId
  );
  return !!sec;
}

async function childOf(parentId: string, studentId: string): Promise<boolean> {
  const row = await get(
    "SELECT id FROM parent_children WHERE parentId = ? AND studentId = ?",
    parentId,
    studentId
  );
  return !!row;
}

interface RosterRow {
  studentId: string;
  name: string;
  rollNumber: string | null;
  status: string | null;
}

/** Daily roster for marking: every enrolled student + their status that day (if any). */
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("PARENT"); // every signed-in role; branches enforce their own scope
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const p = req.nextUrl.searchParams;
    const sectionId = p.get("sectionId");
    const date = p.get("date");
    const month = p.get("month");
    const studentId = p.get("studentId");

    // ---- Single-student view (student themself, or parent of the child) ----
    if (studentId) {
      if (session.role === "STUDENT" && studentId !== session.userId) {
        return NextResponse.json({ error: "Not your record" }, { status: 403 });
      }
      if (session.role === "PARENT" && !(await childOf(session.userId, studentId))) {
        return NextResponse.json({ error: "Not your child" }, { status: 403 });
      }
      if (session.role === "TEACHER") {
        // teacher may view students in sections they teach
        const ok = await get(
          `SELECT e.id FROM enrollments e
           JOIN class_subjects cs ON cs.sectionId = e.sectionId
           WHERE e.studentId = ? AND cs.teacherId = ? AND e.schoolId = ?`,
          studentId,
          session.userId,
          schoolId
        );
        if (!ok) return NextResponse.json({ error: "Not your student" }, { status: 403 });
      }
      const student = await get<{ id: string; name: string }>(
        "SELECT id, name FROM users WHERE id = ? AND schoolId = ? AND role = 'STUDENT' AND deletedAt IS NULL",
        studentId,
        schoolId
      );
      if (!student) return NextResponse.json({ error: "Student not found" }, { status: 404 });

      let dateFilter = "";
      const args: (string | null)[] = [schoolId, studentId];
      if (month) {
        if (!MONTH_RE.test(month)) return NextResponse.json({ error: "month must be YYYY-MM" }, { status: 400 });
        dateFilter = "AND substr(date, 1, 7) = ?";
        args.push(month);
      }
      const records = await all<{ date: string; status: string }>(
        `SELECT date, status FROM attendance_records
         WHERE schoolId = ? AND studentId = ? ${dateFilter} ORDER BY date DESC`,
        ...args
      );
      const summary = summarize(records.map((r) => r.status));
      return NextResponse.json({ student, records, summary });
    }

    // ---- Section roster / monthly summary ----
    if (!sectionId) {
      return NextResponse.json({ error: "sectionId is required" }, { status: 400 });
    }
    const section = await sectionInSchool(sectionId, schoolId);
    if (!section) return NextResponse.json({ error: "Section not found in this school" }, { status: 404 });
    if (session.role === "TEACHER" && !(await teacherCanAccessSection(sectionId, schoolId, session.userId))) {
      return NextResponse.json({ error: "Not your section" }, { status: 403 });
    }

    const students = await all<{ id: string; name: string; rollNumber: string | null }>(
      `SELECT u.id, u.name, e.rollNumber
       FROM enrollments e JOIN users u ON u.id = e.studentId AND u.deletedAt IS NULL
       WHERE e.sectionId = ? AND e.schoolId = ?
       ORDER BY CAST(e.rollNumber AS INTEGER) ASC, u.name ASC`,
      sectionId,
      schoolId
    );

    if (month) {
      if (!MONTH_RE.test(month)) return NextResponse.json({ error: "month must be YYYY-MM" }, { status: 400 });
      const summary = [];
      for (const s of students) {
        const recs = await all<{ status: string }>(
          `SELECT status FROM attendance_records
           WHERE schoolId = ? AND sectionId = ? AND studentId = ? AND substr(date, 1, 7) = ?`,
          schoolId,
          sectionId,
          s.id,
          month
        );
        summary.push({ studentId: s.id, name: s.name, rollNumber: s.rollNumber, ...summarize(recs.map((r) => r.status)) });
      }
      return NextResponse.json({ summary });
    }

    if (!date || !DATE_RE.test(date)) {
      return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    }
    const marked = await all<{ studentId: string; status: string }>(
      `SELECT studentId, status FROM attendance_records
       WHERE schoolId = ? AND sectionId = ? AND date = ?`,
      schoolId,
      sectionId,
      date
    );
    const byStudent = new Map(marked.map((m) => [m.studentId, m.status]));
    const roster: RosterRow[] = students.map((s) => ({
      studentId: s.id,
      name: s.name,
      rollNumber: s.rollNumber,
      status: byStudent.get(s.id) ?? null,
    }));
    return NextResponse.json({ roster, markedCount: marked.length });
  } catch (e) {
    return toErrorResponse(e);
  }
}

function summarize(statuses: string[]) {
  const counts: Record<string, number> = { PRESENT: 0, ABSENT: 0, LATE: 0, LEAVE: 0 };
  for (const s of statuses) if (counts[s] !== undefined) counts[s]++;
  const total = statuses.length;
  const present = counts.PRESENT + counts.LATE; // late counts as attended
  return {
    total,
    present: counts.PRESENT,
    absent: counts.ABSENT,
    late: counts.LATE,
    leave: counts.LEAVE,
    percentage: total === 0 ? null : Math.round((present / total) * 100),
  };
}

/** Mark (or re-mark) a full day's attendance for a section. */
export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { sectionId, date, records } = (await req.json()) as {
      sectionId?: string;
      date?: string;
      records?: { studentId: string; status: string }[];
    };
    if (!sectionId || !date || !DATE_RE.test(date) || !Array.isArray(records) || records.length === 0) {
      return NextResponse.json(
        { error: "sectionId, date (YYYY-MM-DD) and records are required" },
        { status: 400 }
      );
    }
    const section = await sectionInSchool(sectionId, schoolId);
    if (!section) return NextResponse.json({ error: "Section not found in this school" }, { status: 404 });

    const canMark =
      session.role === "SCHOOL_ADMIN" ||
      session.role === "SUPER_ADMIN" ||
      (await teacherCanAccessSection(sectionId, schoolId, session.userId));
    if (!canMark) return NextResponse.json({ error: "Not your section" }, { status: 403 });

    // All students must be enrolled in this section
    const enrolled = new Set(
      (
        await all<{ studentId: string }>(
          "SELECT studentId FROM enrollments WHERE sectionId = ? AND schoolId = ?",
          sectionId,
          schoolId
        )
      ).map((r) => r.studentId)
    );

    // Audit trail (Phase 2.6): capture the previous status for this day
    // first, so every change records old -> new, not just the new value.
    // A parent disputing attendance needs "who changed it, from what, to what".
    const previous = new Map(
      (
        await all<{ studentId: string; status: string }>(
          "SELECT studentId, status FROM attendance_records WHERE schoolId = ? AND sectionId = ? AND date = ?",
          schoolId,
          sectionId,
          date
        )
      ).map((m) => [m.studentId, m.status])
    );
    let saved = 0;
    for (const r of records) {
      if (!enrolled.has(r.studentId)) continue;
      if (!STATUSES.includes(r.status as (typeof STATUSES)[number])) continue;
      const oldStatus = previous.get(r.studentId) ?? null;
      await run(
        `INSERT INTO attendance_records
           (id, schoolId, sectionId, date, studentId, status, markedById)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(sectionId, date, studentId)
         DO UPDATE SET status = excluded.status, markedById = excluded.markedById`,
        uid(),
        schoolId,
        sectionId,
        date,
        r.studentId,
        r.status,
        session.userId
      );
      saved++;
      if (oldStatus !== r.status) {
        await writeAudit({
          schoolId, userId: session.userId,
          action: oldStatus ? "attendance.changed" : "attendance.marked",
          entity: "Attendance", entityId: `${sectionId}:${date}:${r.studentId}`,
          details: { sectionId, date, studentId: r.studentId, oldStatus, newStatus: r.status },
        });
      }
    }
    return NextResponse.json({ saved, date });
  } catch (e) {
    return toErrorResponse(e);
  }
}
