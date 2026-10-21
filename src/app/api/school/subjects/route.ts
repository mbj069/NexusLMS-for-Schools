import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, isUniqueViolation } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const subjects = await all("SELECT id, name, code FROM subjects WHERE schoolId = ? ORDER BY name ASC", schoolId);
    return NextResponse.json({ subjects });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { name, code } = await req.json();
    if (!name) return NextResponse.json({ error: "Subject name is required" }, { status: 400 });
    const id = uid();
    try {
      await run("INSERT INTO subjects (id, schoolId, name, code) VALUES (?,?,?,?)",
        id, schoolId, String(name).trim(), code?.trim() || null);
    } catch (e) {
      if (isUniqueViolation(e)) {
        return NextResponse.json({ error: "That subject already exists" }, { status: 409 });
      }
      throw e;
    }
    return NextResponse.json(
      { subject: { id, name: String(name).trim(), code: code?.trim() || null } },
      { status: 201 }
    );
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { id, name, code } = await req.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const existing = await get("SELECT id FROM subjects WHERE id = ? AND schoolId = ?", id, schoolId);
    if (!existing) return NextResponse.json({ error: "Subject not found" }, { status: 404 });

    const updates: string[] = [];
    const params: (string | null)[] = [];
    if (name !== undefined && String(name).trim()) {
      const clash = await get(
        "SELECT id FROM subjects WHERE schoolId = ? AND name = ? AND id != ?",
        schoolId, String(name).trim(), id
      );
      if (clash) return NextResponse.json({ error: "That subject already exists" }, { status: 409 });
      updates.push("name = ?");
      params.push(String(name).trim());
    }
    if (code !== undefined) {
      updates.push("code = ?");
      params.push(String(code).trim() || null);
    }
    if (updates.length > 0) {
      await run(`UPDATE subjects SET ${updates.join(", ")} WHERE id = ?`, ...params, id);
    }
    return NextResponse.json({ updated: true });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: "That subject already exists" }, { status: 409 });
    }
    return toErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await requireAuth("SCHOOL_ADMIN");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const existing = await get("SELECT id FROM subjects WHERE id = ? AND schoolId = ?", id, schoolId);
    if (!existing) return NextResponse.json({ error: "Subject not found" }, { status: 404 });
    const assigned = await get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM class_subjects WHERE subjectId = ?", id
    );
    // Cascades class_subjects; timetable slots for them become free periods (SET NULL).
    await run("DELETE FROM subjects WHERE id = ?", id);
    return NextResponse.json({ deleted: true, assignmentsRemoved: assigned?.n ?? 0 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export const dynamic = "force-dynamic";
