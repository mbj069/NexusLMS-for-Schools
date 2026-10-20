import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, isUniqueViolation } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const links = (await all<{
      id: string;
      parentId: string;
      parentName: string;
      studentId: string;
      studentName: string;
    }>(
      `SELECT pc.id, p.id AS parentId, p.name AS parentName, s.id AS studentId, s.name AS studentName
       FROM parent_children pc
       JOIN users p ON p.id = pc.parentId
       JOIN users s ON s.id = pc.studentId
       WHERE pc.schoolId = ? ORDER BY p.name ASC`,
      schoolId
    )).map((r) => ({
      id: r.id,
      parent: { id: r.parentId, name: r.parentName },
      student: { id: r.studentId, name: r.studentName },
    }));
    return NextResponse.json({ links });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { parentId, studentId } = await req.json();
    if (!parentId || !studentId) {
      return NextResponse.json({ error: "Parent and student are required" }, { status: 400 });
    }
    const parent = await get(
      "SELECT id FROM users WHERE id = ? AND schoolId = ? AND role = 'PARENT'", parentId, schoolId
    );
    const student = await get(
      "SELECT id FROM users WHERE id = ? AND schoolId = ? AND role = 'STUDENT'", studentId, schoolId
    );
    if (!parent || !student) {
      return NextResponse.json({ error: "Parent or student not found in this school" }, { status: 404 });
    }
    const id = uid();
    try {
      await run("INSERT INTO parent_children (id, schoolId, parentId, studentId) VALUES (?,?,?,?)",
        id, schoolId, parentId, studentId);
    } catch (e) {
      if (isUniqueViolation(e)) {
        return NextResponse.json({ error: "That parent is already linked to this student" }, { status: 409 });
      }
      throw e;
    }
    return NextResponse.json({ link: { id } }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export const dynamic = "force-dynamic";
