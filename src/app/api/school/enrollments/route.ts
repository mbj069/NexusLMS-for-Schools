import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, isUniqueViolation } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const sectionId = req.nextUrl.searchParams.get("sectionId");
    if (!sectionId) return NextResponse.json({ error: "sectionId is required" }, { status: 400 });
    const section = await get("SELECT id FROM sections WHERE id = ? AND schoolId = ?", sectionId, schoolId);
    if (!section) return NextResponse.json({ error: "Section not found" }, { status: 404 });
    const enrollments = (await all<{ id: string; rollNumber: string | null; studentId: string; studentName: string }>(
      `SELECT e.id, e.rollNumber, u.id AS studentId, u.name AS studentName
       FROM enrollments e JOIN users u ON u.id = e.studentId AND u.deletedAt IS NULL
       WHERE e.sectionId = ? ORDER BY e.rollNumber ASC`,
      sectionId
    )).map((r) => ({
      id: r.id,
      rollNumber: r.rollNumber,
      student: { id: r.studentId, name: r.studentName },
    }));
    return NextResponse.json({ enrollments });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { sectionId, studentId, rollNumber } = await req.json();
    if (!sectionId || !studentId) {
      return NextResponse.json({ error: "Section and student are required" }, { status: 400 });
    }
    const section = await get("SELECT id FROM sections WHERE id = ? AND schoolId = ?", sectionId, schoolId);
    const student = await get(
      "SELECT id FROM users WHERE id = ? AND schoolId = ? AND role = 'STUDENT' AND deletedAt IS NULL AND isActive = 1",
      studentId, schoolId
    );
    if (!section || !student) {
      return NextResponse.json({ error: "Section or student not found in this school" }, { status: 404 });
    }
    const id = uid();
    try {
      await run(
        "INSERT INTO enrollments (id, schoolId, studentId, sectionId, rollNumber) VALUES (?,?,?,?,?)",
        id, schoolId, studentId, sectionId, rollNumber?.trim() || null
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        return NextResponse.json({ error: "That student is already enrolled in this section" }, { status: 409 });
      }
      throw e;
    }
    return NextResponse.json({ enrollment: { id } }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const existing = await get<{ id: string; studentId: string }>(
      "SELECT id, studentId FROM enrollments WHERE id = ? AND schoolId = ?", id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Enrollment not found" }, { status: 404 });
    // Cascades this student's attendance, submissions, quiz attempts and grades
    // within the section. Parent links are kept.
    await run("DELETE FROM enrollments WHERE id = ?", id);
    return NextResponse.json({ deleted: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export const dynamic = "force-dynamic";
