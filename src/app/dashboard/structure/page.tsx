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
const iconBtn = "rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100";
const dangerBtn = "rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50";

async function api(method: string, url: string, body?: object) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

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

  // inline editing state
  const [editing, setEditing] = useState<{ type: string; id: string } | null>(null);
  const [editVals, setEditVals] = useState<Record<string, string>>({});
  const [addingSectionTo, setAddingSectionTo] = useState<string | null>(null);
  const [newSectionName, setNewSectionName] = useState("");

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
    const { ok, data } = await api("POST", url, body);
    if (!ok) setError(data.error || "Something went wrong");
    else load();
  }

  async function saveEdit(url: string, body: object) {
    setError("");
    const { ok, data } = await api("PUT", url, body);
    if (!ok) setError(data.error || "Could not save");
    else {
      setEditing(null);
      setEditVals({});
      load();
    }
  }

  async function remove(url: string, confirmMsg: string) {
    if (!confirm(confirmMsg)) return;
    setError("");
    const { ok, data } = await api("DELETE", url);
    if (!ok) setError(data.error || "Could not delete");
    else load();
  }

  function startEdit(type: string, id: string, vals: Record<string, string>) {
    setEditing({ type, id });
    setEditVals(vals);
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
                {editing?.type === "session" && editing.id === s.id ? (
                  <div className="rounded-lg bg-slate-50 p-2">
                    <input value={editVals.name ?? ""} onChange={(e) => setEditVals({ ...editVals, name: e.target.value })}
                      className={`${input} mb-2 w-full`} placeholder="Session name" />
                    <div className="flex gap-2">
                      <button onClick={() => saveEdit("/api/school/sessions", { id: s.id, name: editVals.name })}
                        className="rounded-md bg-blue-700 px-3 py-1 text-xs font-medium text-white">Save</button>
                      <button onClick={() => setEditing(null)} className={iconBtn}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-slate-50">
                    <button onClick={() => setActiveSession(s.id)} className={`text-left ${activeSession === s.id ? "font-medium text-blue-800" : ""}`}>
                      {s.name} {s.isCurrent && <span className="ml-1 rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">current</span>}
                      <span className="text-slate-400"> · {s._count.classes} classes</span>
                    </button>
                    <div className="flex gap-1">
                      <button onClick={() => startEdit("session", s.id, { name: s.name })} className={iconBtn}>Edit</button>
                      <button
                        onClick={() => remove(`/api/school/sessions?id=${s.id}`,
                          `Delete session "${s.name}"? This also removes its ${s._count.classes} classes and everything under them.`)}
                        className={dangerBtn}>Delete</button>
                    </div>
                  </div>
                )}
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
          <ul className="space-y-3 text-sm">
            {visibleClasses.map((c) => (
              <li key={c.id} className="rounded-lg bg-slate-50 px-3 py-2">
                {editing?.type === "class" && editing.id === c.id ? (
                  <div className="flex gap-2">
                    <input value={editVals.name ?? ""} onChange={(e) => setEditVals({ ...editVals, name: e.target.value })}
                      className={`${input} flex-1`} />
                    <button onClick={() => saveEdit("/api/school/classes", { id: c.id, name: editVals.name })}
                      className="rounded-md bg-blue-700 px-3 py-1 text-xs font-medium text-white">Save</button>
                    <button onClick={() => setEditing(null)} className={iconBtn}>Cancel</button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{c.name}</span>
                    <div className="flex gap-1">
                      <button onClick={() => startEdit("class", c.id, { name: c.name })} className={iconBtn}>Rename</button>
                      <button
                        onClick={() => remove(`/api/school/classes?id=${c.id}`,
                          `Delete class "${c.name}"? This also removes its sections, enrollments, timetables and attendance.`)}
                        className={dangerBtn}>Delete</button>
                    </div>
                  </div>
                )}
                <ul className="mt-2 space-y-1">
                  {c.sections.map((s) => (
                    <li key={s.id} className="flex items-center justify-between rounded bg-white px-2 py-1.5 text-xs">
                      {editing?.type === "section" && editing.id === s.id ? (
                        <div className="flex w-full flex-wrap items-center gap-2">
                          <input value={editVals.name ?? ""} onChange={(e) => setEditVals({ ...editVals, name: e.target.value })}
                            className={`${input} w-20 !py-1`} />
                          <select value={editVals.classTeacherId ?? ""} onChange={(e) => setEditVals({ ...editVals, classTeacherId: e.target.value })}
                            className={`${input} !py-1`}>
                            <option value="">No class teacher</option>
                            {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                          <button
                            onClick={() => saveEdit("/api/school/sections", {
                              id: s.id, name: editVals.name, classTeacherId: editVals.classTeacherId || null,
                            })}
                            className="rounded-md bg-blue-700 px-2 py-1 text-xs font-medium text-white">Save</button>
                          <button onClick={() => setEditing(null)} className={iconBtn}>Cancel</button>
                        </div>
                      ) : (
                        <>
                          <span>
                            Sec {s.name}
                            {s.classTeacher && <span className="text-slate-400"> · {s.classTeacher.name}</span>}
                            <span className="text-slate-400"> · {s._count.enrollments} students, {s._count.classSubjects} subjects</span>
                          </span>
                          <span className="flex gap-1">
                            <button
                              onClick={() => startEdit("section", s.id, { name: s.name, classTeacherId: s.classTeacher?.id ?? "" })}
                              className={iconBtn}>Edit</button>
                            <button
                              onClick={() => remove(`/api/school/sections?id=${s.id}`,
                                `Delete section ${s.name}? This also removes its ${s._count.enrollments} enrollments, timetable and attendance.`)}
                              className={dangerBtn}>Delete</button>
                          </span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                {addingSectionTo === c.id ? (
                  <div className="mt-2 flex gap-2">
                    <input value={newSectionName} onChange={(e) => setNewSectionName(e.target.value)}
                      placeholder="Section name, e.g. C" className={`${input} w-32 !py-1`} />
                    <button
                      onClick={async () => {
                        const { ok, data } = await api("POST", "/api/school/sections", { classId: c.id, name: newSectionName });
                        if (!ok) setError(data.error || "Could not add section");
                        else { setAddingSectionTo(null); setNewSectionName(""); load(); }
                      }}
                      className="rounded-md bg-blue-700 px-3 py-1 text-xs font-medium text-white">Add</button>
                    <button onClick={() => setAddingSectionTo(null)} className={iconBtn}>Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setAddingSectionTo(c.id)} className="mt-2 text-xs font-medium text-blue-700 hover:underline">
                    + Add section
                  </button>
                )}
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
          <ul className="space-y-1 text-sm">
            {subjects.map((s) => (
              <li key={s.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-slate-50">
                {editing?.type === "subject" && editing.id === s.id ? (
                  <div className="flex w-full gap-2">
                    <input value={editVals.name ?? ""} onChange={(e) => setEditVals({ ...editVals, name: e.target.value })}
                      className={`${input} flex-1 !py-1`} />
                    <input value={editVals.code ?? ""} onChange={(e) => setEditVals({ ...editVals, code: e.target.value })}
                      className={`${input} w-20 !py-1`} placeholder="Code" />
                    <button onClick={() => saveEdit("/api/school/subjects", { id: s.id, name: editVals.name, code: editVals.code })}
                      className="rounded-md bg-blue-700 px-2 py-1 text-xs font-medium text-white">Save</button>
                    <button onClick={() => setEditing(null)} className={iconBtn}>Cancel</button>
                  </div>
                ) : (
                  <>
                    <span>{s.name}{s.code ? <span className="text-slate-400"> ({s.code})</span> : ""}</span>
                    <span className="flex gap-1">
                      <button onClick={() => startEdit("subject", s.id, { name: s.name, code: s.code ?? "" })} className={iconBtn}>Edit</button>
                      <button
                        onClick={() => remove(`/api/school/subjects?id=${s.id}`,
                          `Delete subject "${s.name}"? Its teacher assignments will be removed and timetable slots become free periods.`)}
                        className={dangerBtn}>Delete</button>
                    </span>
                  </>
                )}
              </li>
            ))}
            {subjects.length === 0 && <li className="text-slate-500">No subjects yet.</li>}
          </ul>
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
              <li key={cs.id} className="flex items-center justify-between rounded-lg px-2 py-1 hover:bg-slate-50">
                <span>{cs.section.class.name} · {cs.section.name} — <strong>{cs.subject.name}</strong> · {cs.teacher.name}</span>
                <span className="flex items-center gap-1">
                  <select
                    value={cs.teacher.id}
                    onChange={async (e) => {
                      const { ok, data } = await api("PUT", "/api/school/class-subjects", { id: cs.id, teacherId: e.target.value });
                      if (!ok) setError(data.error || "Could not reassign");
                      else load();
                    }}
                    className="rounded border px-1 py-0.5 text-xs"
                    title="Change teacher"
                  >
                    {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  <button
                    onClick={() => remove(`/api/school/class-subjects?id=${cs.id}`,
                      `Unassign ${cs.subject.name} from ${cs.section.class.name} · ${cs.section.name}? Timetable slots become free periods.`)}
                    className={dangerBtn}>Unassign</button>
                </span>
              </li>
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
              <li key={e.id} className="flex items-center justify-between rounded-lg px-2 py-1 hover:bg-slate-50">
                <span>{e.rollNumber ? `#${e.rollNumber} ` : ""}{e.student.name}</span>
                <button
                  onClick={() => remove(`/api/school/enrollments?id=${e.id}`,
                    `Unenroll ${e.student.name}? Their attendance and grades in this section will be removed.`).then(() => loadEnrollments(enrollForm.sectionId))}
                  className={dangerBtn}>Unenroll</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
