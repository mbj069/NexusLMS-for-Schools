/**
 * NexusLMS demo seed — creates a clearly-labeled DEMO school ("Demo Academy")
 * with one user per role, so a new deployment can be explored end-to-end.
 *
 * Local:  node db/seed.mjs            (uses DATABASE_URL, default file:./dev.db)
 * Turso:   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node db/seed.mjs
 */
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const DEMO_PASSWORD = "demo1234";
const uid = () => randomBytes(12).toString("hex");
const now = () => new Date().toISOString();
const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 12);

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

// --- driver adapter -------------------------------------------------------
let run, get, close;
if (TURSO_URL) {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
  run = async (sql, ...params) => { await client.execute({ sql, args: params }); };
  get = async (sql, ...params) => (await client.execute({ sql, args: params })).rows[0];
  close = async () => client.close();
  console.log(`Seeding Turso database ${TURSO_URL}`);
} else {
  const raw = process.env.DATABASE_URL ?? "file:./dev.db";
  const p = raw.startsWith("file:") ? raw.slice(5) : raw;
  const dbPath = path.isAbsolute(p) ? p : path.resolve(root, p);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  run = (sql, ...params) => db.prepare(sql).run(...params);
  get = (sql, ...params) => db.prepare(sql).get(...params);
  close = () => db.close();
  console.log(`Seeding ${dbPath}`);
}

// --- seed -----------------------------------------------------------------
// Idempotent: wipe existing demo school
const existing = await get("SELECT id FROM schools WHERE slug = 'demo-academy'");
if (existing) {
  console.log("Removing existing demo school…");
  await run("DELETE FROM schools WHERE id = ?", existing.id);
}

const schoolId = uid();
await run(
  "INSERT INTO schools (id, name, slug, phone, address, primaryColor, createdAt) VALUES (?,?,?,?,?,?,?)",
  schoolId, "Demo Academy", "demo-academy", "+92 300 0000000",
  "Demo data — not a real school", "#1d4ed8", now()
);

const sessionId = uid();
await run(
  "INSERT INTO academic_sessions (id, schoolId, name, startDate, endDate, isCurrent) VALUES (?,?,?,?,?,1)",
  sessionId, schoolId, "2026-27", "2026-04-01", "2027-03-31"
);

async function addUser(name, email, role, sid = schoolId) {
  const id = uid();
  await run(
    "INSERT INTO users (id, schoolId, name, email, passwordHash, role, createdAt) VALUES (?,?,?,?,?,?,?)",
    id, sid, name, email.toLowerCase(), passwordHash, role, now()
  );
  return id;
}

const superAdminId = await addUser("Platform Admin", "superadmin@nexusms.app", "SUPER_ADMIN", null);
const adminId = await addUser("Ayesha Khan", "admin@demo.edu", "SCHOOL_ADMIN");
const teacherId = await addUser("Bilal Ahmed", "teacher@demo.edu", "TEACHER");
const teacher2Id = await addUser("Sara Malik", "teacher2@demo.edu", "TEACHER");
const studentId = await addUser("Ali Raza", "student@demo.edu", "STUDENT");
const student2Id = await addUser("Fatima Noor", "student2@demo.edu", "STUDENT");
const parentId = await addUser("Kamran Raza", "parent@demo.edu", "PARENT");

const classId = uid();
await run("INSERT INTO classes (id, schoolId, sessionId, name) VALUES (?,?,?,?)",
  classId, schoolId, sessionId, "Grade 8");
const sectionId = uid();
await run("INSERT INTO sections (id, schoolId, classId, name, classTeacherId) VALUES (?,?,?,?,?)",
  sectionId, schoolId, classId, "A", teacherId);

async function addSubject(name, code) {
  const id = uid();
  await run("INSERT INTO subjects (id, schoolId, name, code) VALUES (?,?,?,?)", id, schoolId, name, code);
  return id;
}
const mathId = await addSubject("Mathematics", "MATH-08");
const sciId = await addSubject("Science", "SCI-08");
const engId = await addSubject("English", "ENG-08");

async function assign(subjectId, tid) {
  await run("INSERT INTO class_subjects (id, schoolId, sectionId, subjectId, teacherId) VALUES (?,?,?,?,?)",
    uid(), schoolId, sectionId, subjectId, tid);
}
await assign(mathId, teacherId);
await assign(sciId, teacher2Id);
await assign(engId, teacherId);

await run("INSERT INTO enrollments (id, schoolId, studentId, sectionId, rollNumber) VALUES (?,?,?,?,?)",
  uid(), schoolId, studentId, sectionId, "01");
await run("INSERT INTO enrollments (id, schoolId, studentId, sectionId, rollNumber) VALUES (?,?,?,?,?)",
  uid(), schoolId, student2Id, sectionId, "02");
await run("INSERT INTO parent_children (id, schoolId, parentId, studentId) VALUES (?,?,?,?)",
  uid(), schoolId, parentId, studentId);

await run("INSERT INTO announcements (id, schoolId, title, body, audience, createdById, createdAt) VALUES (?,?,?,?,?,?,?)",
  uid(), schoolId, "Welcome to Demo Academy on NexusLMS",
  "This is demo data. Explore attendance, assignments, and quizzes as they land in the next phases.",
  "ALL", adminId, now());

await close();
console.log("\nDemo seed complete. Sign in with any of these (password: demo1234):");
console.log("  superadmin@nexusms.app  → platform admin (manages schools)");
console.log("  admin@demo.edu          → school admin");
console.log("  teacher@demo.edu        → teacher");
console.log("  student@demo.edu        → student");
console.log("  parent@demo.edu         → parent");
console.log(`\n(super admin id: ${superAdminId})`);
