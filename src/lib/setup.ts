import bcrypt from "bcryptjs";
import { run, get, uid, nowIso } from "./db";

// One-click database setup for deployments (e.g. Vercel + Turso).
// - Empty database  -> creates schema + demo seed, no auth needed (safe: it
//   only produces the intended initial state).
// - Already seeded  -> requires the setup key (AUTH_SECRET) to reset + reseed,
//   so nobody can wipe a live demo but the owner.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logoUrl TEXT,
  primaryColor TEXT NOT NULL DEFAULT '#1d4ed8',
  phone TEXT,
  address TEXT,
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS academic_sessions (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  startDate TEXT NOT NULL,
  endDate TEXT NOT NULL,
  isCurrent INTEGER NOT NULL DEFAULT 0,
  UNIQUE (schoolId, name)
);
CREATE INDEX IF NOT EXISTS idx_sessions_school ON academic_sessions(schoolId);
CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL,
  sessionId TEXT NOT NULL REFERENCES academic_sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  UNIQUE (sessionId, name)
);
CREATE INDEX IF NOT EXISTS idx_classes_school ON classes(schoolId);
CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL,
  classId TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  classTeacherId TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (classId, name)
);
CREATE INDEX IF NOT EXISTS idx_sections_school ON sections(schoolId);
CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  UNIQUE (schoolId, name)
);
CREATE INDEX IF NOT EXISTS idx_subjects_school ON subjects(schoolId);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  schoolId TEXT REFERENCES schools(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  passwordHash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN','SCHOOL_ADMIN','TEACHER','STUDENT','PARENT')),
  phone TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE (schoolId, email)
);
CREATE INDEX IF NOT EXISTS idx_users_school ON users(schoolId);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE TABLE IF NOT EXISTS class_subjects (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL,
  sectionId TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  subjectId TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  teacherId TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  UNIQUE (sectionId, subjectId)
);
CREATE INDEX IF NOT EXISTS idx_cs_school ON class_subjects(schoolId);
CREATE INDEX IF NOT EXISTS idx_cs_teacher ON class_subjects(teacherId);
CREATE TABLE IF NOT EXISTS parent_children (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL,
  parentId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  studentId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (parentId, studentId)
);
CREATE INDEX IF NOT EXISTS idx_pc_school ON parent_children(schoolId);
CREATE TABLE IF NOT EXISTS enrollments (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL,
  studentId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sectionId TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  rollNumber TEXT,
  UNIQUE (sectionId, studentId)
);
CREATE INDEX IF NOT EXISTS idx_enr_school ON enrollments(schoolId);
CREATE INDEX IF NOT EXISTS idx_enr_student ON enrollments(studentId);
CREATE TABLE IF NOT EXISTS timetable_slots (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL,
  sectionId TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  dayOfWeek INTEGER NOT NULL,
  periodNumber INTEGER NOT NULL,
  startTime TEXT NOT NULL,
  endTime TEXT NOT NULL,
  classSubjectId TEXT REFERENCES class_subjects(id) ON DELETE SET NULL,
  UNIQUE (sectionId, dayOfWeek, periodNumber)
);
CREATE INDEX IF NOT EXISTS idx_tt_school ON timetable_slots(schoolId);
CREATE TABLE IF NOT EXISTS attendance_records (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL,
  sectionId TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  studentId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('PRESENT','ABSENT','LATE','LEAVE')),
  markedById TEXT NOT NULL REFERENCES users(id),
  UNIQUE (sectionId, date, studentId)
);
CREATE INDEX IF NOT EXISTS idx_att_school ON attendance_records(schoolId);
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL,
  classSubjectId TEXT NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lessons_school ON lessons(schoolId);
CREATE INDEX IF NOT EXISTS idx_lessons_cs ON lessons(classSubjectId);
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL,
  classSubjectId TEXT NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  dueDate TEXT NOT NULL,
  totalMarks INTEGER NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assign_school ON assignments(schoolId);
CREATE INDEX IF NOT EXISTS idx_assign_cs ON assignments(classSubjectId);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  assignmentId TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  studentId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  submittedAt TEXT NOT NULL,
  marks INTEGER,
  feedback TEXT,
  UNIQUE (assignmentId, studentId)
);
CREATE TABLE IF NOT EXISTS quizzes (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL,
  classSubjectId TEXT NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  dueDate TEXT,
  totalMarks INTEGER NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quiz_school ON quizzes(schoolId);
CREATE INDEX IF NOT EXISTS idx_quiz_cs ON quizzes(classSubjectId);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  quizId TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('MCQ','SHORT')),
  optionsJson TEXT,
  correctAnswer TEXT,
  marks INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quizId);
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id TEXT PRIMARY KEY,
  quizId TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  studentId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answersJson TEXT NOT NULL,
  score INTEGER,
  submittedAt TEXT NOT NULL,
  UNIQUE (quizId, studentId)
);
CREATE TABLE IF NOT EXISTS grades (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL,
  studentId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  classSubjectId TEXT NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  marksObtained REAL NOT NULL,
  totalMarks REAL NOT NULL,
  UNIQUE (studentId, classSubjectId, term)
);
CREATE INDEX IF NOT EXISTS idx_grades_school ON grades(schoolId);
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'ALL',
  sectionId TEXT REFERENCES sections(id) ON DELETE SET NULL,
  createdById TEXT NOT NULL REFERENCES users(id),
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ann_school ON announcements(schoolId);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  schoolId TEXT REFERENCES schools(id) ON DELETE CASCADE,
  userId TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entityId TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_school ON audit_logs(schoolId);
`;

const DEMO_PASSWORD = "demo1234";

export async function isSeeded(): Promise<boolean> {
  try {
    const table = await get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'"
    );
    if (!table) return false;
    const row = await get<{ n: number }>("SELECT COUNT(*) AS n FROM users");
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

async function applySchema(): Promise<void> {
  // Split into individual statements (no triggers/procedures in this schema,
  // so a plain split is safe) — works identically on both drivers.
  const statements = SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const sql of statements) {
    await run(sql);
  }
}

export async function seedDemo(): Promise<void> {
  await applySchema();

  // Wipe any existing demo school (idempotent).
  // class_subjects.teacherId is ON DELETE RESTRICT (deliberate), so clear it
  // before the cascaded school delete. attendance_records.markedById and
  // announcements.createdById have no ON DELETE action — clear them too so
  // FK ordering can never block the wipe.
  const existing = await get<{ id: string }>(
    "SELECT id FROM schools WHERE slug = 'demo-academy'"
  );
  if (existing) {
    await run("DELETE FROM class_subjects WHERE schoolId = ?", existing.id);
    await run("DELETE FROM attendance_records WHERE schoolId = ?", existing.id);
    await run("DELETE FROM announcements WHERE schoolId = ?", existing.id);
    await run("DELETE FROM schools WHERE id = ?", existing.id);
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  const schoolId = uid();
  await run(
    "INSERT INTO schools (id, name, slug, phone, address, primaryColor, createdAt) VALUES (?,?,?,?,?,?,?)",
    schoolId,
    "Demo Academy",
    "demo-academy",
    "+92 300 0000000",
    "Demo data — not a real school",
    "#1d4ed8",
    nowIso()
  );

  const sessionId = uid();
  await run(
    "INSERT INTO academic_sessions (id, schoolId, name, startDate, endDate, isCurrent) VALUES (?,?,?,?,?,1)",
    sessionId,
    schoolId,
    "2026-27",
    "2026-04-01",
    "2027-03-31"
  );

  async function addUser(
    name: string,
    email: string,
    role: string,
    sid: string | null = schoolId
  ): Promise<string> {
    const id = uid();
    await run(
      "INSERT INTO users (id, schoolId, name, email, passwordHash, role, createdAt) VALUES (?,?,?,?,?,?,?)",
      id,
      sid,
      name,
      email.toLowerCase(),
      passwordHash,
      role,
      nowIso()
    );
    return id;
  }

  await addUser("Platform Admin", "superadmin@nexusms.app", "SUPER_ADMIN", null);
  const adminId = await addUser("Ayesha Khan", "admin@demo.edu", "SCHOOL_ADMIN");
  const teacherId = await addUser("Bilal Ahmed", "teacher@demo.edu", "TEACHER");
  const teacher2Id = await addUser("Sara Malik", "teacher2@demo.edu", "TEACHER");
  const studentId = await addUser("Ali Raza", "student@demo.edu", "STUDENT");
  const student2Id = await addUser("Fatima Noor", "student2@demo.edu", "STUDENT");
  const parentId = await addUser("Kamran Raza", "parent@demo.edu", "PARENT");

  const classId = uid();
  await run(
    "INSERT INTO classes (id, schoolId, sessionId, name) VALUES (?,?,?,?)",
    classId,
    schoolId,
    sessionId,
    "Grade 8"
  );
  const sectionId = uid();
  await run(
    "INSERT INTO sections (id, schoolId, classId, name, classTeacherId) VALUES (?,?,?,?,?)",
    sectionId,
    schoolId,
    classId,
    "A",
    teacherId
  );

  async function addSubject(name: string, code: string): Promise<string> {
    const id = uid();
    await run(
      "INSERT INTO subjects (id, schoolId, name, code) VALUES (?,?,?,?)",
      id,
      schoolId,
      name,
      code
    );
    return id;
  }
  const mathId = await addSubject("Mathematics", "MATH-08");
  const sciId = await addSubject("Science", "SCI-08");
  const engId = await addSubject("English", "ENG-08");

  for (const [subjectId, tid] of [
    [mathId, teacherId],
    [sciId, teacher2Id],
    [engId, teacherId],
  ] as const) {
    await run(
      "INSERT INTO class_subjects (id, schoolId, sectionId, subjectId, teacherId) VALUES (?,?,?,?,?)",
      uid(),
      schoolId,
      sectionId,
      subjectId,
      tid
    );
  }

  await run(
    "INSERT INTO enrollments (id, schoolId, studentId, sectionId, rollNumber) VALUES (?,?,?,?,?)",
    uid(),
    schoolId,
    studentId,
    sectionId,
    "01"
  );
  await run(
    "INSERT INTO enrollments (id, schoolId, studentId, sectionId, rollNumber) VALUES (?,?,?,?,?)",
    uid(),
    schoolId,
    student2Id,
    sectionId,
    "02"
  );
  await run(
    "INSERT INTO parent_children (id, schoolId, parentId, studentId) VALUES (?,?,?,?)",
    uid(),
    schoolId,
    parentId,
    studentId
  );

  await run(
    "INSERT INTO announcements (id, schoolId, title, body, audience, createdById, createdAt) VALUES (?,?,?,?,?,?,?)",
    uid(),
    schoolId,
    "Welcome to Demo Academy on NexusLMS",
    "This is demo data. Explore attendance, assignments, and quizzes as they land in the next phases.",
    "ALL",
    adminId,
    nowIso()
  );
}
