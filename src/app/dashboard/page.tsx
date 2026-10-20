import { redirect } from "next/navigation";
import { all, get } from "@/lib/db";
import { getSession } from "@/lib/auth";
import Shell from "@/components/Shell";

export const dynamic = "force-dynamic";

function Card({ title, value, hint }: { title: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border bg-white p-5">
      <div className="text-sm text-slate-500">{title}</div>
      <div className="mt-1 text-3xl font-bold">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

function count(table: string, schoolId: string, extra = ""): number {
  const row = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE schoolId = ? ${extra}`,
    schoolId
  );
  return row?.n ?? 0;
}

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role === "SUPER_ADMIN") redirect("/platform");
  const schoolId = session.schoolId!;

  if (session.role === "SCHOOL_ADMIN") {
    const teachers = count("users", schoolId, "AND role = 'TEACHER'");
    const students = count("users", schoolId, "AND role = 'STUDENT'");
    const parents = count("users", schoolId, "AND role = 'PARENT'");
    const admins = count("users", schoolId, "AND role = 'SCHOOL_ADMIN'");
    const classes = count("classes", schoolId);
    const sessions = all<{ id: string; name: string; isCurrent: number }>(
      "SELECT id, name, isCurrent FROM academic_sessions WHERE schoolId = ? ORDER BY startDate DESC LIMIT 5",
      schoolId
    );
    const current = sessions.find((s) => s.isCurrent === 1);
    return (
      <Shell>
        <h1 className="mb-1 text-2xl font-bold">Overview</h1>
        <p className="mb-6 text-sm text-slate-500">
          {current ? `Current session: ${current.name}` : "No academic session set up yet."}{" "}
          Head to <strong>Classes &amp; Subjects</strong> to finish setup.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card title="Teachers" value={teachers} />
          <Card title="Students" value={students} />
          <Card title="Parents" value={parents} />
          <Card title="Admins" value={admins} />
          <Card title="Classes" value={classes} hint="across all sessions" />
          <Card title="Sessions" value={sessions.length} />
        </div>
        <div className="mt-8 rounded-xl border bg-white p-5">
          <h2 className="mb-2 font-semibold">Getting started checklist</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
            <li>Create an academic session (Classes &amp; Subjects → Sessions)</li>
            <li>Add classes with their sections</li>
            <li>Add subjects, then assign each subject to a section with its teacher</li>
            <li>Add users (teachers, students, parents) on the Users page</li>
            <li>Enroll students into sections and link parents to their children</li>
          </ol>
        </div>
      </Shell>
    );
  }

  if (session.role === "TEACHER") {
    const teaching = all<{
      id: string;
      subjectName: string;
      sectionName: string;
      className: string;
      enrollmentCount: number;
    }>(
      `SELECT cs.id, sub.name AS subjectName, sec.name AS sectionName, c.name AS className,
        (SELECT COUNT(*) FROM enrollments e WHERE e.sectionId = sec.id) AS enrollmentCount
       FROM class_subjects cs
       JOIN subjects sub ON sub.id = cs.subjectId
       JOIN sections sec ON sec.id = cs.sectionId
       JOIN classes c ON c.id = sec.classId
       WHERE cs.schoolId = ? AND cs.teacherId = ?
       ORDER BY sub.name ASC`,
      schoolId,
      session.userId
    );
    return (
      <Shell>
        <h1 className="mb-1 text-2xl font-bold">My Classes</h1>
        <p className="mb-6 text-sm text-slate-500">Subjects you teach this session.</p>
        {teaching.length === 0 ? (
          <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">
            No subjects assigned to you yet. Ask your school admin to assign subjects under Classes &amp; Subjects.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {teaching.map((t) => (
              <div key={t.id} className="rounded-xl border bg-white p-5">
                <div className="font-semibold">{t.subjectName}</div>
                <div className="text-sm text-slate-500">
                  {t.className} · Section {t.sectionName}
                </div>
                <div className="mt-2 text-sm text-slate-600">
                  {t.enrollmentCount} students enrolled
                </div>
                <div className="mt-3 text-xs text-slate-400">
                  Lessons, assignments and quizzes land here in the next phase.
                </div>
              </div>
            ))}
          </div>
        )}
      </Shell>
    );
  }

  if (session.role === "STUDENT") {
    const enrollments = all<{
      id: string;
      rollNumber: string | null;
      sectionName: string;
      className: string;
    }>(
      `SELECT e.id, e.rollNumber, sec.name AS sectionName, c.name AS className
       FROM enrollments e
       JOIN sections sec ON sec.id = e.sectionId
       JOIN classes c ON c.id = sec.classId
       WHERE e.studentId = ?`,
      session.userId
    );
    const subjects = all<{ subjectName: string; teacherName: string; sectionId: string }>(
      `SELECT sub.name AS subjectName, t.name AS teacherName, cs.sectionId
       FROM class_subjects cs
       JOIN subjects sub ON sub.id = cs.subjectId
       JOIN users t ON t.id = cs.teacherId
       JOIN enrollments e ON e.sectionId = cs.sectionId
       WHERE e.studentId = ?
       ORDER BY sub.name ASC`,
      session.userId
    );
    return (
      <Shell>
        <h1 className="mb-1 text-2xl font-bold">My Learning</h1>
        <p className="mb-6 text-sm text-slate-500">Your classes and subjects.</p>
        {enrollments.length === 0 ? (
          <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">
            You&apos;re not enrolled in any section yet. Ask your school admin.
          </div>
        ) : (
          enrollments.map((e) => (
            <div key={e.id} className="rounded-xl border bg-white p-5">
              <div className="font-semibold">
                {e.className} · Section {e.sectionName}
              </div>
              {e.rollNumber && <div className="text-xs text-slate-500">Roll no. {e.rollNumber}</div>}
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {subjects.map((s, i) => (
                  <div key={i} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                    <span className="font-medium">{s.subjectName}</span>
                    <span className="text-slate-500"> · {s.teacherName}</span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </Shell>
    );
  }

  // PARENT
  const links = all<{
    studentId: string;
    studentName: string;
    sectionName: string | null;
    className: string | null;
    rollNumber: string | null;
  }>(
    `SELECT s.id AS studentId, s.name AS studentName, sec.name AS sectionName,
       c.name AS className, e.rollNumber
     FROM parent_children pc
     JOIN users s ON s.id = pc.studentId
     LEFT JOIN enrollments e ON e.studentId = s.id
     LEFT JOIN sections sec ON sec.id = e.sectionId
     LEFT JOIN classes c ON c.id = sec.classId
     WHERE pc.parentId = ?`,
    session.userId
  );
  return (
    <Shell>
      <h1 className="mb-1 text-2xl font-bold">My Children</h1>
      <p className="mb-6 text-sm text-slate-500">Follow each child&apos;s school life here.</p>
      {links.length === 0 ? (
        <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">
          No children linked to your account yet. Ask the school admin to link them.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {links.map((l, i) => (
            <div key={`${l.studentId}-${i}`} className="rounded-xl border bg-white p-5">
              <div className="font-semibold">{l.studentName}</div>
              {l.className && (
                <div className="text-sm text-slate-500">
                  {l.className} · Section {l.sectionName}
                  {l.rollNumber ? ` · Roll no. ${l.rollNumber}` : ""}
                </div>
              )}
              <div className="mt-3 text-xs text-slate-400">
                Attendance, grades and announcements for {l.studentName.split(" ")[0]} appear here in the next phase.
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}
