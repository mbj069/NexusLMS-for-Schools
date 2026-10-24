-- NexusLMS schema (SQLite). Applied idempotently by db/migrate.mjs.
-- Tenancy rule: every domain table carries schoolId.

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
  schoolId TEXT REFERENCES schools(id) ON DELETE CASCADE, -- NULL => platform super-admin
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  passwordHash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN','SCHOOL_ADMIN','TEACHER','STUDENT','PARENT')),
  phone TEXT,
  createdAt TEXT NOT NULL,
  -- Hardening (Phase 2.6): revocation + disable + soft-delete.
  -- tokenVersion is stamped into every JWT; bumping it (password change,
  -- disable, restore) invalidates all previously issued tokens immediately.
  -- isActive = 0 blocks login AND kills existing sessions via the DB check.
  -- deletedAt = soft-delete: the row stays for audit/restore, but every
  -- live query must exclude it (see users route + roster/listing joins).
  tokenVersion INTEGER NOT NULL DEFAULT 0,
  isActive INTEGER NOT NULL DEFAULT 1,
  deletedAt TEXT,
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
  -- Hardening: schoolId is denormalised here (copied from the assignment)
  -- so a submission is directly tenant-scoped and directly auditable,
  -- instead of only reachable through a join that a future query might skip.
  schoolId TEXT REFERENCES schools(id) ON DELETE CASCADE,
  assignmentId TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  studentId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  submittedAt TEXT NOT NULL,
  marks INTEGER,
  feedback TEXT,
  UNIQUE (assignmentId, studentId)
);
CREATE INDEX IF NOT EXISTS idx_sub_school ON submissions(schoolId);

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
  schoolId TEXT REFERENCES schools(id) ON DELETE CASCADE, -- denormalised from quiz, same reason as submissions
  quizId TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('MCQ','SHORT')),
  optionsJson TEXT,
  correctAnswer TEXT,
  marks INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quizId);
CREATE INDEX IF NOT EXISTS idx_questions_school ON questions(schoolId);

CREATE TABLE IF NOT EXISTS quiz_attempts (
  id TEXT PRIMARY KEY,
  schoolId TEXT REFERENCES schools(id) ON DELETE CASCADE, -- denormalised from quiz
  quizId TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  studentId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  answersJson TEXT NOT NULL,
  score INTEGER,
  submittedAt TEXT NOT NULL,
  UNIQUE (quizId, studentId)
);
CREATE INDEX IF NOT EXISTS idx_attempts_school ON quiz_attempts(schoolId);

CREATE TABLE IF NOT EXISTS grades (
  id TEXT PRIMARY KEY,
  schoolId TEXT NOT NULL,
  studentId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  classSubjectId TEXT NOT NULL REFERENCES class_subjects(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  marksObtained REAL NOT NULL,
  totalMarks REAL NOT NULL,
  deletedAt TEXT, -- soft-delete: grade history is never silently erased (Phase 3 must respect this)
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
  -- Hardening: machine-readable before/after detail, e.g.
  -- {"oldStatus":"PRESENT","newStatus":"ABSENT"} or {"oldMarks":70,"newMarks":75}.
  -- Never put passwords or tokens here.
  details TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_school ON audit_logs(schoolId);
