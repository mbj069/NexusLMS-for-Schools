/**
 * NexusLMS demo seed — creates a clearly-labeled DEMO school ("Demo Academy")
 * with one user per role, so a new deployment can be explored end-to-end.
 * Run: node db/seed.mjs  (or: npm run db:seed)
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const raw = process.env.DATABASE_URL ?? "file:./dev.db";
const p = raw.startsWith("file:") ? raw.slice(5) : raw;
const dbPath = path.isAbsolute(p) ? p : path.resolve(root, p);

const DEMO_PASSWORD = "demo1234";
const uid = () => randomBytes(12).toString("hex");
const now = () => new Date().toISOString();
const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, 12);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");

// Idempotent: wipe existing demo school
const existing = db.prepare("SELECT id FROM schools WHERE slug = 'demo-academy'").get();
if (existing) {
  console.log("Removing existing demo school…");
  db.prepare("DELETE FROM schools WHERE id = ?").run(existing.id);
}

const run = (sql, ...params) => db.prepare(sql).run(...params);

const schoolId = uid();
run(
  "INSERT INTO schools (id, name, slug, phone, address, primaryColor, createdAt) VALUES (?,?,?,?,?,?,?)",
  schoolId, "Demo Academy", "demo-academy", "+92 300 0000000",
  "Demo data — not a real school", "#1d4ed8", now()
);

const sessionId = uid();
run(
  "INSERT INTO academic_sessions (id, schoolId, name, startDate, endDate, isCurrent) VALUES (?,?,?,?,?,1)",
  sessionId, schoolId, "2026-27", "2026-04-01", "2027-03-31"
);

function addUser(name, email, role, sid = schoolId) {
  const id = uid();
  run(
    "INSERT INTO users (id, schoolId, name, email, passwordHash, role, createdAt) VALUES (?,?,?,?,?,?,?)",
    id, sid, name, email.toLowerCase(), passwordHash, role, now()
  );
  return id;
}

const superAdminId = addUser("Platform Admin", "superadmin@nexusms.app", "SUPER_ADMIN", null);
const adminId = addUser("Ayesha Khan", "admin@demo.edu", "SCHOOL_ADMIN");
const teacherId = addUser("Bilal Ahmed", "teacher@demo.edu", "TEACHER");
const teacher2Id = addUser("Sara Malik", "teacher2@demo.edu", "TEACHER");
const studentId = addUser("Ali Raza", "student@demo.edu", "STUDENT");
const student2Id = addUser("Fatima Noor", "student2@demo.edu", "STUDENT");
const parentId = addUser("Kamran Raza", "parent@demo.edu", "PARENT");

const classId = uid();
run("INSERT INTO classes (id, schoolId, sessionId, name) VALUES (?,?,?,?)",
  classId, schoolId, sessionId, "Grade 8");
const sectionId = uid();
run("INSERT INTO sections (id, schoolId, classId, name, classTeacherId) VALUES (?,?,?,?,?)",
  sectionId, schoolId, classId, "A", teacherId);

function addSubject(name, code) {
  const id = uid();
  run("INSERT INTO subjects (id, schoolId, name, code) VALUES (?,?,?,?)", id, schoolId, name, code);
  return id;
}
const mathId = addSubject("Mathematics", "MATH-08");
const sciId = addSubject("Science", "SCI-08");
const engId = addSubject("English", "ENG-08");

function assign(subjectId, tid) {
  run("INSERT INTO class_subjects (id, schoolId, sectionId, subjectId, teacherId) VALUES (?,?,?,?,?)",
    uid(), schoolId, sectionId, subjectId, tid);
}
assign(mathId, teacherId);
assign(sciId, teacher2Id);
assign(engId, teacherId);

run("INSERT INTO enrollments (id, schoolId, studentId, sectionId, rollNumber) VALUES (?,?,?,?,?)",
  uid(), schoolId, studentId, sectionId, "01");
run("INSERT INTO enrollments (id, schoolId, studentId, sectionId, rollNumber) VALUES (?,?,?,?,?)",
  uid(), schoolId, student2Id, sectionId, "02");
run("INSERT INTO parent_children (id, schoolId, parentId, studentId) VALUES (?,?,?,?)",
  uid(), schoolId, parentId, studentId);

run("INSERT INTO announcements (id, schoolId, title, body, audience, createdById, createdAt) VALUES (?,?,?,?,?,?,?)",
  uid(), schoolId, "Welcome to Demo Academy on NexusLMS",
  "This is demo data. Explore attendance, assignments, and quizzes as they land in the next phases.",
  "ALL", adminId, now());

db.close();
console.log("\nDemo seed complete. Sign in with any of these (password: demo1234):");
console.log("  superadmin@nexusms.app  → platform admin (manages schools)");
console.log("  admin@demo.edu          → school admin");
console.log("  teacher@demo.edu        → teacher");
console.log("  student@demo.edu        → student");
console.log("  parent@demo.edu         → parent");
console.log(`\n(super admin id: ${superAdminId})`);
