import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, nowIso, isUniqueViolation } from "@/lib/db";
import { requireAuth, toErrorResponse } from "@/lib/tenant";

function slugify(name: string) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

interface SchoolRow {
  id: string;
  name: string;
  slug: string;
  phone: string | null;
  createdAt: string;
  userCount: number;
  sessionCount: number;
}

// Platform super-admin: list all school workspaces
export async function GET() {
  try {
    await requireAuth("SUPER_ADMIN");
    const rows = all<SchoolRow>(
      `SELECT s.id, s.name, s.slug, s.phone, s.createdAt,
        (SELECT COUNT(*) FROM users u WHERE u.schoolId = s.id) AS userCount,
        (SELECT COUNT(*) FROM academic_sessions a WHERE a.schoolId = s.id) AS sessionCount
       FROM schools s ORDER BY s.createdAt DESC`
    );
    const schools = rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      phone: r.phone,
      createdAt: r.createdAt,
      _count: { users: r.userCount, sessions: r.sessionCount },
    }));
    return NextResponse.json({ schools });
  } catch (e) {
    return toErrorResponse(e);
  }
}

// Platform super-admin: provision a new school workspace
export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("SUPER_ADMIN");
    const { name, slug, phone, address, primaryColor } = await req.json();
    if (!name || typeof name !== "string") {
      return NextResponse.json({ error: "School name is required" }, { status: 400 });
    }
    const finalSlug = (slug && String(slug).trim()) || slugify(name);
    if (!finalSlug) {
      return NextResponse.json({ error: "Could not derive a URL slug from the name" }, { status: 400 });
    }
    if (get("SELECT id FROM schools WHERE slug = ?", finalSlug)) {
      return NextResponse.json({ error: "That URL slug is already taken" }, { status: 409 });
    }
    const id = uid();
    run(
      "INSERT INTO schools (id, name, slug, logoUrl, primaryColor, phone, address, createdAt) VALUES (?,?,?,?,?,?,?,?)",
      id,
      name.trim(),
      finalSlug,
      null,
      primaryColor || "#1d4ed8",
      phone?.trim() || null,
      address?.trim() || null,
      nowIso()
    );
    run(
      "INSERT INTO audit_logs (id, schoolId, userId, action, entity, entityId, createdAt) VALUES (?,?,?,?,?,?,?)",
      uid(),
      null,
      session.userId,
      "school.created",
      "School",
      id,
      nowIso()
    );
    const school = get("SELECT id, name, slug, phone, createdAt FROM schools WHERE id = ?", id);
    return NextResponse.json({ school }, { status: 201 });
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json({ error: "That URL slug is already taken" }, { status: 409 });
    }
    return toErrorResponse(e);
  }
}

export const dynamic = "force-dynamic";
