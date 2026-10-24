/**
 * Phase 3 test harness — lessons, assignments, quizzes, gradebook over
 * real HTTP on a throwaway DB, mirroring test-hardening.mjs:
 *  - role gates (student cannot create lessons, teacher cannot teach
 *    another teacher's subject, parent sees only their child's grades)
 *  - cross-tenant isolation for Phase 3 routes
 *  - submission lock after grading, quiz attempt-once, MCQ auto-grade,
 *    correctAnswer never leaked to students
 *  - grade bounds, duplicate-term guard, grade-change audit in export
 * Usage: node scripts/test-phase3.mjs
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const DB = path.join(root, "test-phase3.db");
const PORT = 3105;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_SECRET = "test-only-secret-for-phase3-harness";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
async function req(method, url, cookie, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json, text: json ? JSON.stringify(json) : "" };
}
async function login(email, password) {
  const raw = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (raw.status !== 200) throw new Error(`login failed for ${email}: ${raw.status}`);
  return raw.headers.get("set-cookie")?.split(";")[0] ?? "";
}
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.status === 200) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  if (fs.existsSync(DB)) fs.unlinkSync(DB);
  const env = { ...process.env, DATABASE_URL: `file:${DB}`, AUTH_SECRET: TEST_SECRET };
  execSync("node db/migrate.mjs", { cwd: root, env, stdio: "inherit" });
  execSync("node db/seed.mjs", { cwd: root, env, stdio: "inherit" });
  // Second school + admin, for cross-tenant checks.
  let schoolB, adminBId;
  {
    const bcrypt = (await import("bcryptjs")).default;
    const { DatabaseSync } = await import("node:sqlite");
    const { randomBytes } = await import("node:crypto");
    const db = new DatabaseSync(DB);
    db.exec("PRAGMA foreign_keys = ON;");
    schoolB = randomBytes(12).toString("hex");
    adminBId = randomBytes(12).toString("hex");
    const hash = bcrypt.hashSync("TestPass123", 12);
    db.prepare("INSERT INTO schools (id, name, slug, createdAt) VALUES (?,?,?,?)").run(schoolB, "Second Test School", "second-test", new Date().toISOString());
    db.prepare("INSERT INTO users (id, schoolId, name, email, passwordHash, role, createdAt) VALUES (?,?,?,?,?,?,?)").run(adminBId, schoolB, "B Admin", "adminb@test.edu", hash, "SCHOOL_ADMIN", new Date().toISOString());
    db.close();
  }

  const proc = spawn("npx", ["next", "dev", "-p", String(PORT)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  try {
    if (!(await waitReady())) throw new Error("dev server did not become ready");
    const adminA = await login("admin@demo.edu", "demo1234");
    const teacherA = await login("teacher@demo.edu", "demo1234");
    const teacher2 = await login("teacher2@demo.edu", "demo1234");
    const studentA = await login("student@demo.edu", "demo1234");
    const student2 = await login("student2@demo.edu", "demo1234");
    const parentA = await login("parent@demo.edu", "demo1234");
    const adminB = await login("adminb@test.edu", "TestPass123");

    // Teacher A's class subjects (Math + English, Section A)
    const csA = await req("GET", "/api/school/my-class-subjects", teacherA);
    const mathCs = (csA.json?.classSubjects ?? []).find((c) => c.subject.name === "Mathematics");
    const sciCs = (csA.json?.classSubjects ?? []).find((c) => c.subject.name === "Science");
    check("teacher A sees Math class-subject", !!mathCs, JSON.stringify(csA.json).slice(0, 200));
    check("teacher2 does NOT teach Math (teacher A does)", !(csA.json?.classSubjects ?? []).some((c) => c.subject.name === "Mathematics" && c.teacher.name === "Sara Malik"), "");

    // --- Lessons ------------------------------------------------------------
    const lesson = await req("POST", "/api/school/lessons", teacherA, { classSubjectId: mathCs.id, title: "Algebra intro", content: "x + 2 = 5" });
    check("teacher creates lesson for own subject", lesson.status === 201, `status=${lesson.status} ${lesson.text.slice(0, 200)}`);
    const lessonOtherTeacher = await req("POST", "/api/school/lessons", teacher2, { classSubjectId: mathCs.id, title: "Hijack", content: "no" });
    check("other teacher cannot create lesson for Math", lessonOtherTeacher.status === 403, `status=${lessonOtherTeacher.status}`);
    const lessonStudent = await req("POST", "/api/school/lessons", studentA, { classSubjectId: mathCs.id, title: "Hijack", content: "no" });
    check("student cannot create lesson", lessonStudent.status === 403, `status=${lessonStudent.status}`);
    const lessonsStudent = await req("GET", `/api/school/lessons?classSubjectId=${mathCs.id}`, studentA);
    check("enrolled student reads lesson", lessonsStudent.status === 200 && lessonsStudent.text.includes("Algebra intro"), `status=${lessonsStudent.status}`);

    // --- Assignments + submissions -------------------------------------------
    const asg = await req("POST", "/api/school/assignments", teacherA, { classSubjectId: mathCs.id, title: "Solve 5 equations", description: "Show working", dueDate: "2026-11-01", totalMarks: 10 });
    check("teacher creates assignment", asg.status === 201, `status=${asg.status} ${asg.text.slice(0, 200)}`);
    const asgId = asg.json?.assignment?.id;
    const sub1 = await req("POST", "/api/school/submissions", studentA, { assignmentId: asgId, content: "x=3" });
    check("student submits", sub1.status === 201, `status=${sub1.status} ${sub1.text.slice(0, 200)}`);
    const subResubmit = await req("POST", "/api/school/submissions", studentA, { assignmentId: asgId, content: "x=3, corrected" });
    check("student can resubmit while ungraded", subResubmit.status === 200, `status=${subResubmit.status}`);
    const subs = await req("GET", `/api/school/submissions?assignmentId=${asgId}`, teacherA);
    const subId = subs.json?.submissions?.[0]?.id;
    check("teacher lists submissions", subs.status === 200 && !!subId, `status=${subs.status}`);
    const gradeOver = await req("PUT", "/api/school/submissions", teacherA, { id: subId, marks: 99, feedback: "too high" });
    check("grading above total marks is rejected", gradeOver.status === 400, `status=${gradeOver.status}`);
    const gradeOk = await req("PUT", "/api/school/submissions", teacherA, { id: subId, marks: 8, feedback: "Good working" });
    check("teacher grades submission", gradeOk.status === 200, `status=${gradeOk.status} ${gradeOk.text.slice(0, 200)}`);
    const subAfterGrade = await req("POST", "/api/school/submissions", studentA, { assignmentId: asgId, content: "try again" });
    check("submission locked after grading", subAfterGrade.status === 409, `status=${subAfterGrade.status}`);
    const subOtherStudent = await req("GET", `/api/school/submissions?assignmentId=${asgId}`, student2);
    check("other student sees only own submissions (empty)", subOtherStudent.status === 200 && (subOtherStudent.json?.submissions ?? []).length === 0, `status=${subOtherStudent.status} ${subOtherStudent.text.slice(0, 200)}`);

    // --- Quizzes ---------------------------------------------------------------
    const quiz = await req("POST", "/api/school/quizzes", teacherA, { classSubjectId: mathCs.id, title: "Algebra quiz", totalMarks: 5 });
    check("teacher creates quiz", quiz.status === 201, `status=${quiz.status}`);
    const quizId = quiz.json?.quiz?.id;
    const qBad = await req("POST", "/api/school/questions", teacherA, { quizId, text: "2+2?", type: "MCQ", options: ["3", "4"], correctAnswer: "5", marks: 2 });
    check("MCQ correct answer must be an option", qBad.status === 400, `status=${qBad.status}`);
    const qOk = await req("POST", "/api/school/questions", teacherA, { quizId, text: "2+2?", type: "MCQ", options: ["3", "4"], correctAnswer: "4", marks: 5 });
    check("teacher adds MCQ question", qOk.status === 201, `status=${qOk.status}`);
    const qId = qOk.json?.question?.id;
    const qsStudent = await req("GET", `/api/school/questions?quizId=${quizId}`, studentA);
    check("student questions hide correctAnswer", qsStudent.status === 200 && !("correctAnswer" in (qsStudent.json?.questions?.[0] ?? {})), `status=${qsStudent.status} ${qsStudent.text.slice(0, 200)}`);
    const att1 = await req("POST", "/api/school/quiz-attempts", studentA, { quizId, answers: [{ questionId: qId, answer: "4" }] });
    check("student attempt auto-grades MCQ (5/5)", att1.status === 201 && att1.json?.attempt?.score === 5, `status=${att1.status} ${att1.text.slice(0, 200)}`);
    const att2 = await req("POST", "/api/school/quiz-attempts", studentA, { quizId, answers: [{ questionId: qId, answer: "3" }] });
    check("second attempt is blocked", att2.status === 409, `status=${att2.status}`);
    const attWrong = await req("POST", "/api/school/quiz-attempts", student2, { quizId, answers: [{ questionId: qId, answer: "3" }] });
    check("wrong MCQ answer scores 0", attWrong.status === 201 && attWrong.json?.attempt?.score === 0, `status=${attWrong.status} ${attWrong.text.slice(0, 200)}`);

    // --- Cross-tenant (school B) ------------------------------------------------
    const sessB = await req("POST", "/api/school/sessions", adminB, { name: "2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isCurrent: true });
    const classB = await req("POST", "/api/school/classes", adminB, { name: "Grade 9", sessionId: sessB.json?.session?.id ?? sessB.json?.id, sections: ["A"] });
    const classesB = await req("GET", "/api/school/classes", adminB);
    const sectionBId = classesB.json?.classes?.[0]?.sections?.[0]?.id;
    const subjB = await req("POST", "/api/school/subjects", adminB, { name: "History" });
    const teacherBUser = await req("POST", "/api/school/users", adminB, { name: "B Teacher", email: "teacherb@test.edu", password: "TestPass123", role: "TEACHER" });
    const csB = await req("POST", "/api/school/class-subjects", adminB, { sectionId: sectionBId, subjectId: subjB.json?.subject?.id, teacherId: teacherBUser.json?.user?.id });
    const csBId = csB.json?.classSubject?.id ?? csB.json?.id;
    check("school B class-subject created for tenant test", !!csBId, `status=${csB.status} ${csB.text.slice(0, 200)}`);
    if (csBId) {
      const lessonBFromA = await req("POST", "/api/school/lessons", teacherA, { classSubjectId: csBId, title: "Cross", content: "no" });
      check("teacher A cannot create lesson for school B subject", lessonBFromA.status === 404, `status=${lessonBFromA.status}`);
      const lessonsBFromA = await req("GET", `/api/school/lessons?classSubjectId=${csBId}`, teacherA);
      check("teacher A listing school B lessons sees none", lessonsBFromA.status === 200 && (lessonsBFromA.json?.lessons ?? []).length === 0, `status=${lessonsBFromA.status}`);
    }

    // --- Grades ------------------------------------------------------------------
    // Student ids from the Section A roster
    const classesA = await req("GET", "/api/school/classes", adminA);
    const sectionAId = classesA.json?.classes?.[0]?.sections?.[0]?.id;
    const roster = await req("GET", `/api/school/attendance?sectionId=${sectionAId}&date=2026-10-24`, teacherA);
    const aliId = (roster.json?.roster ?? []).find((r) => r.name === "Ali Raza")?.studentId;
    check("roster gives Ali Raza id for grade test", !!aliId, JSON.stringify(roster.json).slice(0, 200));
    const gradeBad = await req("POST", "/api/school/grades", teacherA, { studentId: aliId, classSubjectId: mathCs.id, term: "Mid-Term", marksObtained: 120, totalMarks: 100 });
    check("grade above total is rejected", gradeBad.status === 400, `status=${gradeBad.status}`);
    const gradeCreate = await req("POST", "/api/school/grades", teacherA, { studentId: aliId, classSubjectId: mathCs.id, term: "Mid-Term", marksObtained: 85, totalMarks: 100 });
    check("teacher creates grade", gradeCreate.status === 201, `status=${gradeCreate.status} ${gradeCreate.text.slice(0, 200)}`);
    const gradeId = gradeCreate.json?.grade?.id;
    const gradeDup = await req("POST", "/api/school/grades", teacherA, { studentId: aliId, classSubjectId: mathCs.id, term: "Mid-Term", marksObtained: 90, totalMarks: 100 });
    check("duplicate student/subject/term grade is rejected", gradeDup.status === 409, `status=${gradeDup.status}`);
    const gradeChange = await req("PUT", "/api/school/grades", teacherA, { id: gradeId, marksObtained: 90 });
    check("teacher edits grade", gradeChange.status === 200, `status=${gradeChange.status}`);
    const gradeOtherStudent = await req("GET", `/api/school/grades?studentId=${aliId}`, student2);
    check("student cannot read another student's grades", gradeOtherStudent.status === 403, `status=${gradeOtherStudent.status}`);
    const gradeParent = await req("GET", `/api/school/grades?studentId=${aliId}`, parentA);
    check("parent reads child's grades", gradeParent.status === 200 && (gradeParent.json?.grades ?? []).length >= 1, `status=${gradeParent.status}`);
    const report = await req("GET", `/api/school/grades?studentId=${aliId}&report=1`, parentA);
    check("report card computes 90% for edited grade", report.status === 200 && report.json?.report?.overall?.percentage === 90, `status=${report.status} ${report.text.slice(0, 300)}`);
    const gradeDel = await req("DELETE", `/api/school/grades?id=${gradeId}`, teacherA);
    check("grade soft-delete", gradeDel.status === 200 && gradeDel.json?.softDeleted === true, `status=${gradeDel.status}`);
    const gradesAfterDel = await req("GET", `/api/school/grades?classSubjectId=${mathCs.id}`, teacherA);
    check("soft-deleted grade no longer listed", !(gradesAfterDel.json?.grades ?? []).some((g) => g.id === gradeId), "");

    // --- Audit in export ----------------------------------------------------------
    const expRes = await fetch(`${BASE}/api/school/export`, { headers: { Cookie: adminA } });
    const exp = await expRes.json();
    const hasGradeChange = (exp.data?.audit_logs ?? []).some((a) => a.action === "grade.changed" && a.details && JSON.parse(a.details).oldMarks === 85 && JSON.parse(a.details).newMarks === 90);
    check("grade change audit (85 -> 90) in export", hasGradeChange, `audit rows=${(exp.data?.audit_logs ?? []).length}`);
    const hasSubGrade = (exp.data?.audit_logs ?? []).some((a) => a.action === "submission.graded" && a.details && JSON.parse(a.details).newMarks === 8);
    check("submission grading audit in export", hasSubGrade, "");

    console.log(failures === 0 ? "\nALL PHASE 3 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  } finally {
    try { process.kill(-proc.pid, "SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch { /* dead */ } }
    await new Promise((r) => setTimeout(r, 2000));
    try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch { /* dead */ } }
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
