import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse } from "@/lib/tenant";

export const dynamic = "force-dynamic";

// dayOfWeek: 1 = Monday … 6 = Saturday (Pakistan school week; Sunday off)

interface SlotRow {
  id: string;
  dayOfWeek: number;
  periodNumber: number;
  startTime: string;
  endTime: string;
  classSubjectId: string | null;
  subjectName: string | null;
  teacherName: string | null;
}

function shape(r: SlotRow) {
  return {
    id: r.id,
    dayOfWeek: r.dayOfWeek,
    periodNumber: r.periodNumber,
    startTime: r.startTime,
    endTime: r.endTime,
    classSubjectId: r.classSubjectId,
    subject: r.subjectName ? { name: r.subjectName } : null,
    teacher: r.teacherName ? { name: r.teacherName } : null,
  };
}

async function sectionInSchool(sectionId: string, schoolId: string) {
  return get("SELECT id FROM sections WHERE id = ? AND schoolId = ?", sectionId, schoolId);
}

/** Students/parents may only view their own section's timetable. */
async function viewerSectionIds(sessionUserId: string, role: string): Promise<string[] | null> {
  if (role === "STUDENT") {
    const rows = await all<{ sectionId: string }>(
      "SELECT sectionId FROM enrollments WHERE studentId = ?",
      sessionUserId
    );
    return rows.map((r) => r.sectionId);
  }
  if (role === "PARENT") {
    const rows = await all<{ sectionId: string }>(
      `SELECT e.sectionId FROM parent_children pc
       JOIN enrollments e ON e.studentId = pc.studentId
       WHERE pc.parentId = ?`,
      sessionUserId
    );
    return rows.map((r) => r.sectionId);
  }
  return null; // TEACHER / SCHOOL_ADMIN / SUPER_ADMIN: no restriction
}

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("PARENT"); // every signed-in role; students/parents are section-scoped below
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const sectionId = req.nextUrl.searchParams.get("sectionId");
    if (!sectionId) {
      return NextResponse.json({ error: "sectionId is required" }, { status: 400 });
    }
    if (!(await sectionInSchool(sectionId, schoolId))) {
      return NextResponse.json({ error: "Section not found in this school" }, { status: 404 });
    }
    const allowed = await viewerSectionIds(session.userId, session.role);
    if (allowed && !allowed.includes(sectionId)) {
      return NextResponse.json({ error: "Not your section" }, { status: 403 });
    }

    const rows = await all<SlotRow>(
      `SELECT ts.id, ts.dayOfWeek, ts.periodNumber, ts.startTime, ts.endTime,
              ts.classSubjectId, sub.name AS subjectName, t.name AS teacherName
       FROM timetable_slots ts
       LEFT JOIN class_subjects cs ON cs.id = ts.classSubjectId
       LEFT JOIN subjects sub ON sub.id = cs.subjectId
       LEFT JOIN users t ON t.id = cs.teacherId
       WHERE ts.schoolId = ? AND ts.sectionId = ?
       ORDER BY ts.periodNumber ASC, ts.dayOfWeek ASC`,
      schoolId,
      sectionId
    );
    return NextResponse.json({ slots: rows.map(shape) });
  } catch (e) {
    return toErrorResponse(e);
  }
}

interface IncomingSlot {
  dayOfWeek: number;
  periodNumber: number;
  startTime: string;
  endTime: string;
  classSubjectId: string | null;
}

/**
 * Replace the whole weekly grid for a section in one call.
 * The editor always sends the complete grid, so replace-by-delete is safe.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { sectionId, slots } = (await req.json()) as {
      sectionId?: string;
      slots?: IncomingSlot[];
    };
    if (!sectionId || !Array.isArray(slots)) {
      return NextResponse.json({ error: "sectionId and slots are required" }, { status: 400 });
    }
    if (!(await sectionInSchool(sectionId, schoolId))) {
      return NextResponse.json({ error: "Section not found in this school" }, { status: 404 });
    }

    // Validate every referenced class-subject belongs to this section
    const csIds = [...new Set(slots.map((s) => s.classSubjectId).filter(Boolean))] as string[];
    const valid = new Set<string>();
    for (const csId of csIds) {
      const row = await get<{ id: string }>(
        "SELECT id FROM class_subjects WHERE id = ? AND schoolId = ? AND sectionId = ?",
        csId,
        schoolId,
        sectionId
      );
      if (row) valid.add(csId);
    }

    // De-dupe on (day, period) — last one wins
    const seen = new Map<string, IncomingSlot>();
    for (const s of slots) {
      const day = Number(s.dayOfWeek);
      const period = Number(s.periodNumber);
      if (!Number.isInteger(day) || day < 1 || day > 6) continue;
      if (!Number.isInteger(period) || period < 1 || period > 12) continue;
      if (!s.startTime || !s.endTime) continue;
      seen.set(`${day}:${period}`, {
        dayOfWeek: day,
        periodNumber: period,
        startTime: String(s.startTime),
        endTime: String(s.endTime),
        classSubjectId: s.classSubjectId && valid.has(s.classSubjectId) ? s.classSubjectId : null,
      });
    }

    await run("DELETE FROM timetable_slots WHERE schoolId = ? AND sectionId = ?", schoolId, sectionId);
    let n = 0;
    for (const s of seen.values()) {
      await run(
        `INSERT INTO timetable_slots
           (id, schoolId, sectionId, dayOfWeek, periodNumber, startTime, endTime, classSubjectId)
         VALUES (?,?,?,?,?,?,?,?)`,
        uid(),
        schoolId,
        sectionId,
        s.dayOfWeek,
        s.periodNumber,
        s.startTime,
        s.endTime,
        s.classSubjectId
      );
      n++;
    }
    return NextResponse.json({ saved: n });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const sectionId = req.nextUrl.searchParams.get("sectionId");
    if (!sectionId) {
      return NextResponse.json({ error: "sectionId is required" }, { status: 400 });
    }
    if (!(await sectionInSchool(sectionId, schoolId))) {
      return NextResponse.json({ error: "Section not found in this school" }, { status: 404 });
    }
    await run("DELETE FROM timetable_slots WHERE schoolId = ? AND sectionId = ?", schoolId, sectionId);
    return NextResponse.json({ cleared: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}
