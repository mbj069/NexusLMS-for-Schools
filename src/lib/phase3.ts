import { get, all } from "./db";
import type { Session } from "./auth";
import { AuthError } from "./tenant";

/**
 * Shared Phase 3 helpers: every lesson/assignment/quiz/grade hangs off a
 * class_subject (a subject taught to a section by a teacher). Access is
 * decided here, once, so no Phase 3 route can forget a check:
 * - SCHOOL_ADMIN / SUPER_ADMIN: any class_subject in their school
 * - TEACHER: only class_subjects they teach
 * - STUDENT: only class_subjects for sections they are enrolled in
 * - PARENT: only class_subjects for sections their linked children are
 *   enrolled in (and, for a specific student, only their own children)
 */
export interface ClassSubjectRow {
  id: string;
  schoolId: string;
  sectionId: string;
  subjectId: string;
  teacherId: string;
  subjectName: string;
  sectionName: string;
  className: string;
  teacherName: string;
}

export async function getClassSubject(
  schoolId: string,
  classSubjectId: string
): Promise<ClassSubjectRow | undefined> {
  return get<ClassSubjectRow>(
    `SELECT cs.id, cs.schoolId, cs.sectionId, cs.subjectId, cs.teacherId,
            sub.name AS subjectName, sec.name AS sectionName, c.name AS className,
            t.name AS teacherName
     FROM class_subjects cs
     JOIN subjects sub ON sub.id = cs.subjectId
     JOIN sections sec ON sec.id = cs.sectionId
     JOIN classes c ON c.id = sec.classId
     JOIN users t ON t.id = cs.teacherId
     WHERE cs.id = ? AND cs.schoolId = ?`,
    classSubjectId,
    schoolId
  );
}

export function teacherCanTeach(session: Session, cs: ClassSubjectRow): boolean {
  if (session.role === "SCHOOL_ADMIN" || session.role === "SUPER_ADMIN") return true;
  return session.role === "TEACHER" && cs.teacherId === session.userId;
}

export async function studentEnrolledInSection(
  studentId: string,
  sectionId: string
): Promise<boolean> {
  const row = await get(
    "SELECT id FROM enrollments WHERE studentId = ? AND sectionId = ?",
    studentId,
    sectionId
  );
  return !!row;
}

export async function childOf(parentId: string, studentId: string): Promise<boolean> {
  const row = await get(
    "SELECT id FROM parent_children WHERE parentId = ? AND studentId = ?",
    parentId,
    studentId
  );
  return !!row;
}

/** Can this session read content attached to this class_subject? */
export async function canReadClassSubject(
  session: Session,
  cs: ClassSubjectRow
): Promise<boolean> {
  if (session.role === "SCHOOL_ADMIN" || session.role === "SUPER_ADMIN") return true;
  if (session.role === "TEACHER") return cs.teacherId === session.userId;
  if (session.role === "STUDENT") {
    return studentEnrolledInSection(session.userId, cs.sectionId);
  }
  if (session.role === "PARENT") {
    const children = await all<{ studentId: string }>(
      "SELECT studentId FROM parent_children WHERE parentId = ?",
      session.userId
    );
    for (const c of children) {
      if (await studentEnrolledInSection(c.studentId, cs.sectionId)) return true;
    }
    return false;
  }
  return false;
}

export async function requireReadableClassSubject(
  session: Session,
  schoolId: string,
  classSubjectId: string
): Promise<ClassSubjectRow> {
  const cs = await getClassSubject(schoolId, classSubjectId);
  if (!cs) throw new AuthError(404, "Subject assignment not found in this school");
  if (!(await canReadClassSubject(session, cs))) {
    throw new AuthError(403, "Not your subject");
  }
  return cs;
}

/** Role-filter SQL fragment for listing rows joined to class_subjects as cs. */
export function roleFilterSql(
  session: Session
): { sql: string; params: (string | null)[] } {
  if (session.role === "SCHOOL_ADMIN" || session.role === "SUPER_ADMIN") {
    return { sql: "", params: [] };
  }
  if (session.role === "TEACHER") {
    return { sql: " AND cs.teacherId = ?", params: [session.userId] };
  }
  if (session.role === "STUDENT") {
    return {
      sql: " AND EXISTS (SELECT 1 FROM enrollments e WHERE e.studentId = ? AND e.sectionId = cs.sectionId)",
      params: [session.userId],
    };
  }
  // PARENT
  return {
    sql: " AND EXISTS (SELECT 1 FROM parent_children pc JOIN enrollments e ON e.studentId = pc.studentId WHERE pc.parentId = ? AND e.sectionId = cs.sectionId)",
    params: [session.userId],
  };
}
