import { NextRequest, NextResponse } from "next/server";
import { get } from "@/lib/db";
import { verifyPassword, createSessionToken, sessionCookie, type Role } from "@/lib/auth";
import { toErrorResponse } from "@/lib/tenant";

interface UserRow {
  id: string;
  schoolId: string | null;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
}

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }
    // Note: if the same email exists in multiple schools, the school-scoped
    // account takes precedence over the platform account.
    const user = get<UserRow>(
      "SELECT id, schoolId, name, email, passwordHash, role FROM users WHERE email = ? ORDER BY schoolId DESC LIMIT 1",
      String(email).toLowerCase().trim()
    );
    if (!user || !(await verifyPassword(String(password), user.passwordHash))) {
      return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
    }
    const token = await createSessionToken({
      userId: user.id,
      schoolId: user.schoolId,
      role: user.role,
      name: user.name,
      email: user.email,
    });
    const res = NextResponse.json({
      ok: true,
      role: user.role,
      redirect: user.role === "SUPER_ADMIN" ? "/platform" : "/dashboard",
    });
    res.cookies.set(sessionCookie(token));
    return res;
  } catch (e) {
    return toErrorResponse(e);
  }
}

export const dynamic = "force-dynamic";
