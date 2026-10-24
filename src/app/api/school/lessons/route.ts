import { NextRequest, NextResponse } from "next/server";
import { all, get, run, uid, nowIso } from "@/lib/db";
import { requireAuth, requireSchoolScope, toErrorResponse, writeAudit } from "@/lib/tenant";
import { getClassSubject, teacherCanTeach, roleFilterSql } from "@/lib/phase3";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth("PARENT");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const classSubjectId = req.nextUrl.searchParams.get("classSubjectId");
    const filter = roleFilterSql(session);
    let sql = `SELECT l.id, l.classSubjectId, l.title, l.content, l.createdAt,
        sub.name AS subjectName, sec.name AS sectionName, c.name AS className
      FROM lessons l
      JOIN class_subjects cs ON cs.id = l.classSubjectId
      JOIN subjects sub ON sub.id = cs.subjectId
      JOIN sections sec ON sec.id = cs.sectionId
      JOIN classes c ON c.id = sec.classId
      WHERE l.schoolId = ? ${filter.sql}`;
    const params: (string | null)[] = [schoolId, ...filter.params];
    if (classSubjectId) {
      sql += " AND l.classSubjectId = ?";
      params.push(classSubjectId);
    }
    sql += " ORDER BY l.createdAt DESC";
    const lessons = await all(sql, ...params);
    return NextResponse.json({ lessons });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { classSubjectId, title, content } = await req.json();
    if (!classSubjectId || !title || !content) {
      return NextResponse.json({ error: "Subject, title and content are required" }, { status: 400 });
    }
    const cs = await getClassSubject(schoolId, classSubjectId);
    if (!cs) return NextResponse.json({ error: "Subject assignment not found in this school" }, { status: 404 });
    if (!teacherCanTeach(session, cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    const id = uid();
    await run(
      "INSERT INTO lessons (id, schoolId, classSubjectId, title, content, createdAt) VALUES (?,?,?,?,?,?)",
      id, schoolId, classSubjectId, String(title).trim(), String(content), nowIso()
    );
    await writeAudit({ schoolId, userId: session.userId, action: "lesson.created", entity: "Lesson", entityId: id, details: { classSubjectId, title: String(title).trim() } });
    return NextResponse.json({ lesson: { id, classSubjectId, title: String(title).trim() } }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const { id, title, content } = await req.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const existing = await get<{ id: string; classSubjectId: string }>(
      "SELECT id, classSubjectId FROM lessons WHERE id = ? AND schoolId = ?", id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
    const cs = await getClassSubject(schoolId, existing.classSubjectId);
    if (!cs || !teacherCanTeach(session, cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    const updates: string[] = [];
    const params: (string | null)[] = [];
    if (title !== undefined && String(title).trim()) { updates.push("title = ?"); params.push(String(title).trim()); }
    if (content !== undefined) { updates.push("content = ?"); params.push(String(content)); }
    if (updates.length > 0) await run(`UPDATE lessons SET ${updates.join(", ")} WHERE id = ?`, ...params, id);
    await writeAudit({ schoolId, userId: session.userId, action: "lesson.updated", entity: "Lesson", entityId: id });
    return NextResponse.json({ updated: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await requireAuth("TEACHER");
    const schoolId = requireSchoolScope(session, req.nextUrl.searchParams);
    const id = req.nextUrl.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const existing = await get<{ id: string; classSubjectId: string; title: string }>(
      "SELECT id, classSubjectId, title FROM lessons WHERE id = ? AND schoolId = ?", id, schoolId
    );
    if (!existing) return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
    const cs = await getClassSubject(schoolId, existing.classSubjectId);
    if (!cs || !teacherCanTeach(session, cs)) {
      return NextResponse.json({ error: "You do not teach this subject" }, { status: 403 });
    }
    await run("DELETE FROM lessons WHERE id = ?", id);
    await writeAudit({ schoolId, userId: session.userId, action: "lesson.deleted", entity: "Lesson", entityId: id, details: { title: existing.title } });
    return NextResponse.json({ deleted: true });
  } catch (e) {
    return toErrorResponse(e);
  }
}
