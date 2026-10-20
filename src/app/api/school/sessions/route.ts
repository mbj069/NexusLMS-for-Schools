import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, nowIso, isUniqueViolation, transaction } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const rows = all<{
      id: string;
      name: string;
      isCurrent: number;
      classCount: number;
    }>(
      `SELECT s.id, s.name, s.isCurrent,
        (SELECT COUNT(*) FROM classes c WHERE c.sessionId = s.id) AS classCount
       FROM academic_sessions s WHERE s.schoolId = ? ORDER BY s.startDate DESC`,
      schoolId
    );
    const sessions = rows.map((r) => ({
      id: r.id,
      name: r.name,
      isCurrent: r.isCurrent === 1,
      _count: { classes: r.classCount },
    }));
    return NextResponse.json({ sessions });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { name, startDate, endDate, isCurrent } = await req.json();
    if (!name || !startDate || !endDate) {
      return NextResponse.json({ error: "Name, start date and end date are required" }, { status: 400 });
    }
    if (get("SELECT id FROM academic_sessions WHERE schoolId = ? AND name = ?", schoolId, String(name).trim())) {
      return NextResponse.json({ error: "A session with that name already exists" }, { status: 409 });
    }
    const id = uid();
    transaction(() => {
      if (isCurrent) {
        run("UPDATE academic_sessions SET isCurrent = 0 WHERE schoolId = ?", schoolId);
      }
      run(
        "INSERT INTO academic_sessions (id, schoolId, name, startDate, endDate, isCurrent) VALUES (?,?,?,?,?,?)",
        id,
        schoolId,
        String(name).trim(),
        new Date(startDate).toISOString(),
        new Date(endDate).toISOString(),
        isCurrent ? 1 : 0
      );
    });
    run(
      "INSERT INTO audit_logs (id, schoolId, userId, action, entity, entityId, createdAt) VALUES (?,?,?,?,?,?,?)",
      uid(),
      schoolId,
      session.userId,
      "session.created",
      "AcademicSession",
      id,
      nowIso()
    );
    const created = get("SELECT id, name, isCurrent FROM academic_sessions WHERE id = ?", id) as {
      id: string;
      name: string;
      isCurrent: number;
    };
    return NextResponse.json(
      { session: { ...created, isCurrent: created.isCurrent === 1 } },
      { status: 201 }
    );
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: "A session with that name already exists" }, { status: 409 });
    }
    return toErrorResponse(e);
  }
}

export const dynamic = "force-dynamic";
