"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/Shell";

interface Session { id: string; name: string; isCurrent: boolean; _count: { classes: number } }
interface Section { id: string; name: string; classTeacher: { id: string; name: string } | null; _count: { enrollments: number; classSubjects: number } }
interface Class { id: string; name: string; sessionId: string; sections: Section[] }
interface Subject { id: string; name: string; code: string | null }
interface ClassSubject {
  id: string;
  subject: { name: string };
  teacher: { id: string; name: string };
  section: { id: string; name: string; class: { name: string } };
}
interface User { id: string; name: string; email: string; role: string }
interface Enrollment { id: string; rollNumber: string | null; student: { id: string; name: string } }

const input = "rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600";
const btn = "rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60";

export default function StructurePage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [classes, setClasses] = useState<Class[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [classSubjects, setClassSubjects] = useState<ClassSubject[]>([]);
  const [teachers, setTeachers] = useState<User[]>([]);
  const [students, setStudents] = useState<User[]>([]);
  const [activeSession, setActiveSession] = useState("");
  const [error, setError] = useState("");

  const [sessionForm, setSessionForm] = useState({ name: "", startDate: "", endDate: "", isCurrent: true });
  const [classForm, setClassForm] = useState({ name: "", sections: "A,B" });
  const [subjectForm, setSubjectForm] = useState({ name: "", code: "" });
  const [assignForm, setAssignForm] = useState({ sectionId: "", subjectId: "", teacherId: "" });
  const [enrollForm, setEnrollForm] = useState({ sectionId: "", studentId: "", rollNumber: "" });
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);

  async function load() {
    const [s, c, sub, cs, u] = await Promise.all([
      fetch("/api/school/sessions").then((r) => r.json()),
      fetch("/api/school/classes").then((r) => r.json()),
      fetch("/api/school/subjects").then((r) => r.json()),
      fetch("/api/school/class-subjects").then((r) => r.json()),
      fetch("/api/school/users").then((r) => r.json()),
    ]);
    setSessions(s.sessions ?? []);
    setClasses(c.classes ?? []);
    setSubjects(sub.subjects ?? []);
    setClassSubjects(cs.classSubjects ?? []);
    const all: User[] = u.users ?? [];
    setTeachers(all.filter((x) => x.role === "TEACHER"));
    setStudents(all.filter((x) => x.role === "STUDENT"));
    if (!activeSession) {
      const cur = (s.sessions ?? []).find((x: Session) => x.isCurrent) ?? (s.sessions ?? [])[0];
      if (cur) setActiveSession(cur.id);
    }
  }

  useEffect(() => { load(); }, []);

  async function post(url: string, body: object) {
    setError("");
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) setError(data.error || "Something went wrong");
    else load();
  }

  async function loadEnrollments(sectionId: string) {
    if (!sectionId) { setEnrollments([]); return; }
    const res = await fetch(`/api/school/enrollments?sectionId=${sectionId}`);
    const data = await res.json();
    setEnrollments(data.enrollments ?? []);
  }

  const visibleClasses = activeSession ? classes.filter((c) => c.sessionId === activeSession) : classes;
  const allSections = visibleClasses.flatMap((c) => c.sections.map((s) => ({ ...s, className: c.name })));

  return (
    <Shell>
      <h1 className="mb-1 text-2xl font-bold">Classes &amp; Subjects</h1>
      <p className="mb-6 text-sm text-slate-500">Set up sessions, classes, sections, subjects, and who teaches what.</p>
      {error && <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Sessions */}
        <section className="rounded-xl border bg-white p-5">
          <h2 className="mb-3 font-semibold">Academic sessions</h2>
          <form onSubmit={(e) => { e.preventDefault(); post("/api/school/sessions", sessionForm); setSessionForm({ name: "", startDate: "", endDate: "", isCurrent: true }); }}
            className="mb-4 grid grid-cols-2 gap-2">
            <input required placeholder="Name, e.g. 2026-27" value={sessionForm.name}
              onChange={(e) => setSessionForm({ ...sessionForm, name: e.target.value })} className={input} />
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={sessionForm.isCurrent}
                onChange={(e) => setSessionForm({ ...sessionForm, isCurrent: e.target.checked })} /> Current
            </label>
            <input required type="date" value={sessionForm.startDate}
              onChange={(e) => setSessionForm({ ...sessionForm, startDate: e.target.value })} className={input} />
            <input required type="date" value={sessionForm.endDate}
              onChange={(e) => setSessionForm({ ...sessionForm, endDate: e.target.value })} className={input} />
            <button className={`${btn} col-span-2`}>Add session</button>
          </form>
          <ul className="space-y-1 text-sm">
            {sessions.map((s) => (
              <li key={s.id}>
                <button onClick={() => setActiveSession(s.id)}
                  className={`w-full rounded-lg px-3 py-2 text-left ${activeSession === s.id ? "bg-blue-50 font-medium text-blue-800" : "hover:bg-slate-50"}`}>
                  {s.name} {s.isCurrent && <span className="ml-1 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">current</span>}
                  <span className="text-slate-400"> · {s._count.classes} classes</span>
                </button>
              </li>
            ))}
            {sessions.length === 0 && <li className="text-slate-500">No sessions yet.</li>}
          </ul>
        </section>

        {/* Classes */}
        <section className="rounded-xl border bg-white p-5">
          <h2 className="mb-3 font-semibold">Classes</h2>
          <form onSubmit={(e) => { e.preventDefault(); post("/api/school/classes", { name: classForm.name, sessionId: activeSession, sections: classForm.sections.split(",").map((x) => x.trim()).filter(Boolean) }); setClassForm({ name: "", sections: "A,B" }); }}
            className="mb-4 grid grid-cols-2 gap-2">
            <input required placeholder="Class name, e.g. Grade 8" value={classForm.name}
              onChange={(e) => setClassForm({ ...classForm, name: e.target.value })} className={input} />
            <input placeholder="Sections, comma separated" value={classForm.sections}
              onChange={(e) => setClassForm({ ...classForm, sections: e.target.value })} className={input} />
            <button className={`${btn} col-span-2`} disabled={!activeSession}>Add class to selected session</button>
          </form>
          <ul className="space-y-2 text-sm">
            {visibleClasses.map((c) => (
              <li key={c.id} className="rounded-lg bg-slate-50 px-3 py-2">
                <span className="font-medium">{c.name}</span>
                <span className="text-slate-500"> — {c.sections.map((s) => `${s.name} (${s._count.enrollments} students, ${s._count.classSubjects} subjects)`).join(" · ")}</span>
              </li>
            ))}
            {visibleClasses.length === 0 && <li className="text-slate-500">No classes in this session yet.</li>}
          </ul>
        </section>

        {/* Subjects */}
        <section className="rounded-xl border bg-white p-5">
          <h2 className="mb-3 font-semibold">Subjects</h2>
          <form onSubmit={(e) => { e.preventDefault(); post("/api/school/subjects", subjectForm); setSubjectForm({ name: "", code: "" }); }}
            className="mb-4 flex gap-2">
            <input required placeholder="Subject name" value={subjectForm.name}
              onChange={(e) => setSubjectForm({ ...subjectForm, name: e.target.value })} className={`${input} flex-1`} />
            <input placeholder="Code" value={subjectForm.code}
              onChange={(e) => setSubjectForm({ ...subjectForm, code: e.target.value })} className={`${input} w-24`} />
            <button className={btn}>Add</button>
          </form>
          <div className="flex flex-wrap gap-2">
            {subjects.map((s) => (
              <span key={s.id} className="rounded-full bg-slate-100 px-3 py-1 text-sm">
                {s.name}{s.code ? ` (${s.code})` : ""}
              </span>
            ))}
            {subjects.length === 0 && <span className="text-sm text-slate-500">No subjects yet.</span>}
          </div>
        </section>

        {/* Assign subjects to sections */}
        <section className="rounded-xl border bg-white p-5">
          <h2 className="mb-3 font-semibold">Assign subject → section → teacher</h2>
          <form onSubmit={(e) => { e.preventDefault(); post("/api/school/class-subjects", assignForm); setAssignForm({ sectionId: "", subjectId: "", teacherId: "" }); }}
            className="mb-4 grid grid-cols-3 gap-2">
            <select required value={assignForm.sectionId} onChange={(e) => setAssignForm({ ...assignForm, sectionId: e.target.value })} className={input}>
              <option value="">Section…</option>
              {allSections.map((s) => <option key={s.id} value={s.id}>{s.className} · {s.name}</option>)}
            </select>
            <select required value={assignForm.subjectId} onChange={(e) => setAssignForm({ ...assignForm, subjectId: e.target.value })} className={input}>
              <option value="">Subject…</option>
              {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select required value={assignForm.teacherId} onChange={(e) => setAssignForm({ ...assignForm, teacherId: e.target.value })} className={input}>
              <option value="">Teacher…</option>
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button className={`${btn} col-span-3`}>Assign</button>
          </form>
          <ul className="space-y-1 text-sm text-slate-600">
            {classSubjects.map((cs) => (
              <li key={cs.id}>{cs.section.class.name} · {cs.section.name} — <strong>{cs.subject.name}</strong> · {cs.teacher.name}</li>
            ))}
            {classSubjects.length === 0 && <li className="text-slate-500">Nothing assigned yet.</li>}
          </ul>
        </section>
      </div>

      {/* Enrollments */}
      <section className="mt-6 rounded-xl border bg-white p-5">
        <h2 className="mb-3 font-semibold">Enroll students into a section</h2>
        <form onSubmit={(e) => { e.preventDefault(); post("/api/school/enrollments", enrollForm).then(() => loadEnrollments(enrollForm.sectionId)); }}
          className="mb-4 flex flex-col gap-2 sm:flex-row">
          <select required value={enrollForm.sectionId}
            onChange={(e) => { setEnrollForm({ ...enrollForm, sectionId: e.target.value }); loadEnrollments(e.target.value); }}
            className={`${input} flex-1`}>
            <option value="">Section…</option>
            {allSections.map((s) => <option key={s.id} value={s.id}>{s.className} · {s.name}</option>)}
          </select>
          <select required value={enrollForm.studentId} onChange={(e) => setEnrollForm({ ...enrollForm, studentId: e.target.value })}
            className={`${input} flex-1`}>
            <option value="">Student…</option>
            {students.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.email})</option>)}
          </select>
          <input placeholder="Roll no." value={enrollForm.rollNumber}
            onChange={(e) => setEnrollForm({ ...enrollForm, rollNumber: e.target.value })} className={`${input} sm:w-32`} />
          <button className={btn}>Enroll</button>
        </form>
        {enrollments.length > 0 && (
          <ul className="grid gap-1 text-sm text-slate-600 sm:grid-cols-2">
            {enrollments.map((e) => (
              <li key={e.id}>{e.rollNumber ? `#${e.rollNumber} ` : ""}{e.student.name}</li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
