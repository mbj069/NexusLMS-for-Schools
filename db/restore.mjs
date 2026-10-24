/**
 * Restore a NexusLMS school export (from GET /api/school/export) into a
 * database. This is the other half of the backup story: an export that
 * cannot be restored is not a backup.
 *
 * Usage:
 *   node db/restore.mjs <export.json> --password <temp-password-for-restored-users>
 *
 * - The export deliberately contains NO password hashes, so every restored
 *   user gets the supplied temporary password and MUST change it on first
 *   sign-in. Never reuse a real password here, and never print it.
 * - Refuses to run against a database that already holds schools, unless
 *   --force is given (which wipes existing schools first — owner only).
 * - Local:  DATABASE_URL=file:./restored.db node db/restore.mjs ...
 * - Turso:  TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node db/restore.mjs ...
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const passwordIdx = args.indexOf("--password");
const password = passwordIdx >= 0 ? args[passwordIdx + 1] : null;
const force = args.includes("--force");

if (!file || !password) {
  console.error("Usage: node db/restore.mjs <export.json> --password <temp-password> [--force]");
  process.exit(1);
}
if (password.length < 8) {
  console.error("Temporary password must be at least 8 characters.");
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(file, "utf8"));
if (payload.product !== "NexusLMS" || !payload.data || !payload.school) {
  console.error("Not a NexusLMS export (missing product/data/school).");
  process.exit(1);
}
const data = payload.data;
const uid = () => randomBytes(12).toString("hex");
const now = () => new Date().toISOString();
const passwordHash = bcrypt.hashSync(password, 12);

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
let run, get, all, close;
if (TURSO_URL) {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
  run = async (sql, ...params) => { await client.execute({ sql, args: params }); };
  get = async (sql, ...params) => (await client.execute({ sql, args: params })).rows[0];
  all = async (sql, ...params) => (await client.execute({ sql, args: params })).rows;
  close = async () => client.close();
  console.log(`Restoring into Turso database ${TURSO_URL}`);
} else {
  const raw = process.env.DATABASE_URL ?? "file:./dev.db";
  const p = raw.startsWith("file:") ? raw.slice(5) : raw;
  const dbPath = path.isAbsolute(p) ? p : path.resolve(root, p);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = OFF;");
  run = (sql, ...params) => db.prepare(sql).run(...params);
  get = (sql, ...params) => db.prepare(sql).get(...params);
  all = (sql, ...params) => db.prepare(sql).all(...params);
  close = () => db.close();
  console.log(`Restoring into ${dbPath}`);
}

// Schema must exist first (migrate, or /setup on a fresh deployment).
const schemaCheck = await get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schools'");
if (!schemaCheck) {
  console.error("Target database has no schema. Run `npm run db:migrate` against it first.");
  await close();
  process.exit(1);
}

const existing = await get("SELECT COUNT(*) AS n FROM schools");
if ((existing?.n ?? 0) > 0 && !force) {
  console.error(`Target already holds ${existing.n} school(s). Re-run with --force to wipe and restore, or restore into an empty database.`);
  await close();
  process.exit(1);
}
if (force && (existing?.n ?? 0) > 0) {
  console.log("Force: wiping existing schools first…");
  // Order matters with RESTRICT FKs: clear assignments before schools.
  await run("DELETE FROM class_subjects");
  await run("DELETE FROM attendance_records");
  await run("DELETE FROM announcements");
  await run("DELETE FROM schools");
}

const counts = {};
async function insertAll(table, rows, columns, mapRow) {
  let n = 0;
  for (const row of rows ?? []) {
    const values = mapRow(row);
    await run(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      ...values
    );
    n++;
  }
  counts[table] = n;
}

const s = payload.school;
await run(
  "INSERT INTO schools (id, name, slug, logoUrl, primaryColor, phone, address, createdAt) VALUES (?,?,?,?,?,?,?,?)",
  s.id, s.name, s.slug, s.logoUrl ?? null, s.primaryColor ?? "#1d4ed8", s.phone ?? null, s.address ?? null, s.createdAt ?? now()
);
counts.schools = 1;

await insertAll("academic_sessions", data.academic_sessions, ["id", "schoolId", "name", "startDate", "endDate", "isCurrent"], (r) => [r.id, r.schoolId, r.name, r.startDate, r.endDate, r.isCurrent]);
await insertAll("classes", data.classes, ["id", "schoolId", "sessionId", "name"], (r) => [r.id, r.schoolId, r.sessionId, r.name]);
await insertAll("sections", data.sections, ["id", "schoolId", "classId", "name", "classTeacherId"], (r) => [r.id, r.schoolId, r.classId, r.name, r.classTeacherId ?? null]);
await insertAll("subjects", data.subjects, ["id", "schoolId", "name", "code"], (r) => [r.id, r.schoolId, r.name, r.code ?? null]);
await insertAll("users", data.users, ["id", "schoolId", "name", "email", "passwordHash", "role", "phone", "createdAt", "isActive"], (r) => [r.id, r.schoolId, r.name, r.email, passwordHash, r.role, r.phone ?? null, r.createdAt ?? now(), r.isActive ?? 1]);
await insertAll("class_subjects", data.class_subjects, ["id", "schoolId", "sectionId", "subjectId", "teacherId"], (r) => [r.id, r.schoolId, r.sectionId, r.subjectId, r.teacherId]);
await insertAll("parent_children", data.parent_children, ["id", "schoolId", "parentId", "studentId"], (r) => [r.id, r.schoolId, r.parentId, r.studentId]);
await insertAll("enrollments", data.enrollments, ["id", "schoolId", "studentId", "sectionId", "rollNumber"], (r) => [r.id, r.schoolId, r.studentId, r.sectionId, r.rollNumber ?? null]);
await insertAll("timetable_slots", data.timetable_slots, ["id", "schoolId", "sectionId", "dayOfWeek", "periodNumber", "startTime", "endTime", "classSubjectId"], (r) => [r.id, r.schoolId, r.sectionId, r.dayOfWeek, r.periodNumber, r.startTime, r.endTime, r.classSubjectId ?? null]);
await insertAll("attendance_records", data.attendance_records, ["id", "schoolId", "sectionId", "date", "studentId", "status", "markedById"], (r) => [r.id, r.schoolId, r.sectionId, r.date, r.studentId, r.status, r.markedById]);
await insertAll("lessons", data.lessons, ["id", "schoolId", "classSubjectId", "title", "content", "createdAt"], (r) => [r.id, r.schoolId, r.classSubjectId, r.title, r.content, r.createdAt ?? now()]);
await insertAll("assignments", data.assignments, ["id", "schoolId", "classSubjectId", "title", "description", "dueDate", "totalMarks", "createdAt"], (r) => [r.id, r.schoolId, r.classSubjectId, r.title, r.description, r.dueDate, r.totalMarks, r.createdAt ?? now()]);
// Submissions in older exports carry no schoolId; derive it from the assignment.
const assignmentSchool = new Map((data.assignments ?? []).map((a) => [a.id, a.schoolId]));
await insertAll("submissions", data.submissions, ["id", "schoolId", "assignmentId", "studentId", "content", "submittedAt", "marks", "feedback"], (r) => [r.id, r.schoolId ?? assignmentSchool.get(r.assignmentId) ?? s.id, r.assignmentId, r.studentId, r.content, r.submittedAt, r.marks ?? null, r.feedback ?? null]);
await insertAll("quizzes", data.quizzes, ["id", "schoolId", "classSubjectId", "title", "description", "dueDate", "totalMarks", "createdAt"], (r) => [r.id, r.schoolId, r.classSubjectId, r.title, r.description ?? null, r.dueDate ?? null, r.totalMarks, r.createdAt ?? now()]);
const quizSchool = new Map((data.quizzes ?? []).map((q) => [q.id, q.schoolId]));
await insertAll("questions", data.questions, ["id", "schoolId", "quizId", "text", "type", "optionsJson", "correctAnswer", "marks"], (r) => [r.id, r.schoolId ?? quizSchool.get(r.quizId) ?? s.id, r.quizId, r.text, r.type, r.optionsJson ?? null, r.correctAnswer ?? null, r.marks]);
await insertAll("quiz_attempts", data.quiz_attempts, ["id", "schoolId", "quizId", "studentId", "answersJson", "score", "submittedAt"], (r) => [r.id, r.schoolId ?? quizSchool.get(r.quizId) ?? s.id, r.quizId, r.studentId, r.answersJson, r.score ?? null, r.submittedAt]);
await insertAll("grades", data.grades, ["id", "schoolId", "studentId", "classSubjectId", "term", "marksObtained", "totalMarks"], (r) => [r.id, r.schoolId, r.studentId, r.classSubjectId, r.term, r.marksObtained, r.totalMarks]);
await insertAll("announcements", data.announcements, ["id", "schoolId", "title", "body", "audience", "sectionId", "createdById", "createdAt"], (r) => [r.id, r.schoolId, r.title, r.body, r.audience ?? "ALL", r.sectionId ?? null, r.createdById, r.createdAt ?? now()]);
await insertAll("audit_logs", data.audit_logs, ["id", "schoolId", "userId", "action", "entity", "entityId", "details", "createdAt"], (r) => [r.id, r.schoolId ?? null, r.userId, r.action, r.entity ?? null, r.entityId ?? null, r.details ?? null, r.createdAt ?? now()]);

await close();
console.log("Restore complete:", counts);
console.log("All restored users share the temporary password you supplied — they must change it on first sign-in.");
