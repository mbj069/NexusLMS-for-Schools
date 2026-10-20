import { NextRequest, NextResponse } from "next/server";
import { all, run, uid, isUniqueViolation } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const subjects = all("SELECT id, name, code FROM subjects WHERE schoolId = ? ORDER BY name ASC", schoolId);
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
      run("INSERT INTO subjects (id, schoolId, name, code) VALUES (?,?,?,?)",
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

export const dynamic = "force-dynamic";
