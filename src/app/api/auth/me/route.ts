import { NextResponse } from "next/server";
import { get } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { toErrorResponse } from "@/lib/tenant";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const school = session.schoolId
      ? await get<{ name: string }>("SELECT name FROM schools WHERE id = ?", session.schoolId)
      : null;
    return NextResponse.json({
      name: session.name,
      email: session.email,
      role: session.role,
      schoolId: session.schoolId,
      schoolName: school?.name ?? null,
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export const dynamic = "force-dynamic";
