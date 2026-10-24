"use client";

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

const input =
  "rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600";

interface ClassSubject {
  id: string;
  subject: { name: string };
  teacher: { name: string };
  section: { id: string; name: string; class: { name: string } };
}
interface Submission {
  id: string;
  studentId: string;
  studentName?: string;
  content: string;
  submittedAt: string;
  marks: number | null;
  feedback: string | null;
}
interface Assignment {
  id: string;
  classSubjectId: string;
  title: string;
  description: string;
  dueDate: string;
  totalMarks: number;
  subjectName: string;
  sectionName: string;
  className: string;
  submissionCount: number;
  mySubmission?: Submission | null;
}

export default function AssignmentsPage() {
  const [role, setRole] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<ClassSubject[]>([]);
  const [selected, setSelected] = useState("");
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [totalMarks, setTotalMarks] = useState("10");
  const [msg, setMsg] = useState("");
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const [subs, setSubs] = useState<Record<string, Submission[]>>({});
  const [grade, setGrade] = useState<Record<string, { marks: string; feedback: string }>>({});

  const load = useCallback(async (csId: string) => {
    const r = await fetch(`/api/school/assignments${csId ? `?classSubjectId=${csId}` : ""}`);
    const j = await r.json();
    setAssignments(j.assignments ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      const me = await (await fetch("/api/auth/me")).json();
      setRole(me.role ?? null);
      const s = await (await fetch("/api/school/my-class-subjects")).json();
      setSubjects(s.classSubjects ?? []);
      if (s.classSubjects?.length) {
        setSelected(s.classSubjects[0].id);
        load(s.classSubjects[0].id);
      } else {
        load("");
      }
    })();
  }, [load]);

  const canEdit = role === "TEACHER" || role === "SCHOOL_ADMIN" || role === "SUPER_ADMIN";

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    const r = await fetch("/api/school/assignments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classSubjectId: selected, title, description, dueDate, totalMarks: Number(totalMarks) }),
    });
    const j = await r.json();
    if (!r.ok) { setMsg(j.error ?? "Could not create assignment"); return; }
    setTitle(""); setDescription(""); setDueDate(""); setTotalMarks("10"); load(selected);
  }

  async function submit(a: Assignment) {
    setMsg("");
    const r = await fetch("/api/school/submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignmentId: a.id, content: answer[a.id] ?? "" }),
    });
    const j = await r.json();
    if (!r.ok) { setMsg(j.error ?? "Could not submit"); return; }
    load(selected);
  }

  async function loadSubs(a: Assignment) {
    const r = await fetch(`/api/school/submissions?assignmentId=${a.id}`);
    const j = await r.json();
    setSubs((s) => ({ ...s, [a.id]: j.submissions ?? [] }));
  }

  async function gradeSub(a: Assignment, s: Submission) {
    const g = grade[a.id + ":" + s.id] ?? { marks: "", feedback: "" };
    const r = await fetch("/api/school/submissions", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: s.id, marks: Number(g.marks), feedback: g.feedback || null }),
    });
    const j = await r.json();
    if (!r.ok) { setMsg(j.error ?? "Could not grade"); return; }
    loadSubs(a);
  }

  return (
    <Shell>
      <h1 className="mb-1 text-2xl font-bold">Assignments</h1>
      <p className="mb-6 text-sm text-slate-500">
        Text answers for now — file uploads will use object storage later, not the database or the app server.
        Students can resubmit while ungraded; once graded, a submission is locked.
      </p>
      {subjects.length === 0 ? (
        <p className="text-sm text-slate-500">No subjects assigned yet.</p>
      ) : (
        <>
          <label className="mb-4 block text-sm">
            <span className="mb-1 block font-medium">Subject</span>
            <select className={input} value={selected} onChange={(e) => { setSelected(e.target.value); load(e.target.value); }}>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>{s.section.class.name} {s.section.name} — {s.subject.name} ({s.teacher.name})</option>
              ))}
            </select>
          </label>

          {canEdit && (
            <form onSubmit={create} className="mb-8 rounded-xl border p-4">
              <h2 className="mb-3 font-semibold">New assignment</h2>
              <div className="flex flex-col gap-3">
                <input className={input} placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
                <textarea className={input} rows={3} placeholder="Instructions" value={description} onChange={(e) => setDescription(e.target.value)} required />
                <div className="flex gap-3">
                  <label className="text-sm">Due date <input type="date" className={input} value={dueDate} onChange={(e) => setDueDate(e.target.value)} required /></label>
                  <label className="text-sm">Total marks <input type="number" min={1} className={input} value={totalMarks} onChange={(e) => setTotalMarks(e.target.value)} required /></label>
                </div>
                <button className="w-fit rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">Create assignment</button>
              </div>
            </form>
          )}
          {msg && <p className="mb-4 text-sm text-red-600">{msg}</p>}

          <div className="flex flex-col gap-4">
            {assignments.length === 0 && <p className="text-sm text-slate-500">No assignments for this subject yet.</p>}
            {assignments.map((a) => (
              <article key={a.id} className="rounded-xl border p-4">
                <h3 className="font-semibold">{a.title}</h3>
                <p className="text-xs text-slate-500">{a.className} {a.sectionName} · {a.subjectName} · Due {new Date(a.dueDate).toLocaleDateString()} · {a.totalMarks} marks {canEdit ? `· ${a.submissionCount} submissions` : ""}</p>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{a.description}</p>

                {role === "STUDENT" && (
                  <div className="mt-3">
                    {a.mySubmission?.marks !== null && a.mySubmission ? (
                      <p className="text-sm font-medium text-green-700">Graded: {a.mySubmission.marks} / {a.totalMarks}{a.mySubmission.feedback ? ` — ${a.mySubmission.feedback}` : ""}</p>
                    ) : (
                      <>
                        <textarea className={input + " w-full"} rows={4} placeholder="Write your answer here" value={answer[a.id] ?? a.mySubmission?.content ?? ""} onChange={(e) => setAnswer((s) => ({ ...s, [a.id]: e.target.value }))} />
                        <button className="mt-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white" onClick={() => submit(a)}>
                          {a.mySubmission ? "Resubmit (still ungraded)" : "Submit"}
                        </button>
                        {a.mySubmission && <p className="mt-1 text-xs text-slate-500">Submitted {new Date(a.mySubmission.submittedAt).toLocaleString()}, awaiting grading.</p>}
                      </>
                    )}
                  </div>
                )}

                {canEdit && (
                  <div className="mt-3">
                    <button className="rounded-lg border px-3 py-1 text-sm" onClick={() => loadSubs(a)}>View submissions</button>
                    <button className="ml-2 rounded-lg border px-3 py-1 text-sm text-red-600" onClick={async () => { if (confirm("Delete this assignment and all its submissions?")) { await fetch(`/api/school/assignments?id=${a.id}`, { method: "DELETE" }); load(selected); } }}>Delete</button>
                    {(subs[a.id] ?? []).map((s) => (
                      <div key={s.id} className="mt-3 rounded-lg border p-3">
                        <p className="text-sm font-medium">{s.studentName ?? s.studentId} · {new Date(s.submittedAt).toLocaleString()}</p>
                        <p className="whitespace-pre-wrap text-sm text-slate-700">{s.content}</p>
                        {s.marks !== null ? (
                          <p className="mt-1 text-sm font-medium text-green-700">Marked: {s.marks} / {a.totalMarks}{s.feedback ? ` — ${s.feedback}` : ""}</p>
                        ) : (
                          <div className="mt-2 flex flex-wrap gap-2">
                            <input type="number" min={0} max={a.totalMarks} placeholder="Marks" className={input} value={(grade[a.id + ":" + s.id] ?? { marks: "" }).marks} onChange={(e) => setGrade((g) => ({ ...g, [a.id + ":" + s.id]: { marks: e.target.value, feedback: g[a.id + ":" + s.id]?.feedback ?? "" } }))} />
                            <input placeholder="Feedback (optional)" className={input} value={(grade[a.id + ":" + s.id] ?? { feedback: "" }).feedback} onChange={(e) => setGrade((g) => ({ ...g, [a.id + ":" + s.id]: { marks: g[a.id + ":" + s.id]?.marks ?? "", feedback: e.target.value } }))} />
                            <button className="rounded-lg bg-blue-600 px-3 py-1 text-sm text-white" onClick={() => gradeSub(a, s)}>Grade</button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </Shell>
  );
}
