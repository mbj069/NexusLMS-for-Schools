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
interface Grade {
  id: string;
  studentId: string;
  studentName: string;
  classSubjectId: string;
  subjectName: string;
  sectionName: string;
  className: string;
  term: string;
  marksObtained: number;
  totalMarks: number;
}
interface StudentRow {
  studentId: string;
  name: string;
}

export default function GradesPage() {
  const [role, setRole] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<ClassSubject[]>([]);
  const [selected, setSelected] = useState("");
  const [grades, setGrades] = useState<Grade[]>([]);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [studentId, setStudentId] = useState("");
  const [term, setTerm] = useState("");
  const [obtained, setObtained] = useState("");
  const [total, setTotal] = useState("100");
  const [msg, setMsg] = useState("");
  const [report, setReport] = useState<{ terms: { term: string; subjects: Grade[]; obtained: number; total: number; percentage: number | null }[]; overall: { obtained: number; total: number; percentage: number | null } } | null>(null);
  const [reportStudent, setReportStudent] = useState("");
  const [children, setChildren] = useState<{ studentId: string; studentName: string }[]>([]);

  const load = useCallback(async (csId: string) => {
    const r = await fetch(`/api/school/grades${csId ? `?classSubjectId=${csId}` : ""}`);
    const j = await r.json();
    setGrades(j.grades ?? []);
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
      if (me.role === "PARENT") {
        const sec = await (await fetch("/api/school/my-sections")).json();
        const kids = new Map<string, string>();
        for (const sct of sec.sections ?? []) {
          if (sct.studentId) kids.set(sct.studentId, sct.studentName);
        }
        setChildren([...kids.entries()].map(([studentId, studentName]) => ({ studentId, studentName })));
        if (kids.size) setReportStudent([...kids.keys()][0]);
      }
    })();
  }, [load]);

  // Staff grade-entry student list: students of the currently selected
  // subject's section, via that section's attendance roster (which lists
  // every enrolled student, marked or not).
  useEffect(() => {
    if (!canEdit || !selected) return;
    const subj = subjects.find((s) => s.id === selected);
    if (!subj) return;
    (async () => {
      const att = await (await fetch(`/api/school/attendance?sectionId=${subj.section.id}&date=${new Date().toISOString().slice(0, 10)}`)).json();
      setStudents((att.roster ?? []).map((r: { studentId: string; name: string }) => ({ studentId: r.studentId, name: r.name })));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, subjects]);

  const canEdit = role === "TEACHER" || role === "SCHOOL_ADMIN" || role === "SUPER_ADMIN";

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    const r = await fetch("/api/school/grades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studentId, classSubjectId: selected, term, marksObtained: Number(obtained), totalMarks: Number(total) }),
    });
    const j = await r.json();
    if (!r.ok) { setMsg(j.error ?? "Could not save grade"); return; }
    setObtained(""); load(selected);
  }

  async function loadReport() {
    setMsg("");
    const sid = role === "PARENT" ? reportStudent : undefined;
    // For students, the API forces self when studentId is omitted only if
    // they pass their own id — the grades list already shows their grades;
    // report for students is loaded via the section list path below.
    const url = `/api/school/grades?report=1${sid ? `&studentId=${sid}` : ""}`;
    const r = await fetch(url);
    const j = await r.json();
    if (!r.ok) { setMsg(j.error ?? "Could not load report"); return; }
    setReport(j.report ?? null);
    setGrades(j.grades ?? []);
  }

  return (
    <Shell>
      <h1 className="mb-1 text-2xl font-bold">Gradebook & Report Cards</h1>
      <p className="mb-6 text-sm text-slate-500">
        Term grades, separate from assignment and quiz marks. Every grade change is audited old → new, and deleting a grade soft-deletes it — history is never silently erased.
      </p>

      {role === "PARENT" && (
        <div className="mb-6 rounded-xl border p-4">
          <h2 className="mb-3 font-semibold">Report card</h2>
          <div className="flex gap-2">
            <select className={input} value={reportStudent} onChange={(e) => setReportStudent(e.target.value)}>
              {children.map((c) => (
                <option key={c.studentId} value={c.studentId}>{c.studentName}</option>
              ))}
            </select>
            <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white" onClick={loadReport}>Show report</button>
          </div>
        </div>
      )}

      {role === "STUDENT" && (
        <div className="mb-6 rounded-xl border p-4">
          <h2 className="mb-3 font-semibold">My report card</h2>
          <p className="mb-3 text-sm text-slate-500">Your grades below, grouped by term. Ask your teacher if a grade looks wrong — every change is logged.</p>
          <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white" onClick={loadReport}>Show my report summary</button>
        </div>
      )}

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
              <h2 className="mb-3 font-semibold">Enter a grade</h2>
              <div className="flex flex-wrap gap-3">
                <select className={input} value={studentId} onChange={(e) => setStudentId(e.target.value)} required>
                  <option value="">Select student…</option>
                  {students.map((s) => (
                    <option key={s.studentId} value={s.studentId}>{s.name}</option>
                  ))}
                </select>
                <input className={input} placeholder="Term (e.g. Mid-Term)" value={term} onChange={(e) => setTerm(e.target.value)} required />
                <input type="number" min={0} className={input} placeholder="Marks obtained" value={obtained} onChange={(e) => setObtained(e.target.value)} required />
                <input type="number" min={1} className={input} placeholder="Total marks" value={total} onChange={(e) => setTotal(e.target.value)} required />
                <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">Save grade</button>
              </div>
              <p className="mt-2 text-xs text-slate-500">Student list comes from the first section in your list. If a student is missing, pick their section&apos;s subject above — the list refreshes from attendance rosters per section in a future polish pass; grades can also be entered via the API with any enrolled student.</p>
            </form>
          )}
          {msg && <p className="mb-4 text-sm text-red-600">{msg}</p>}

          {report && (
            <div className="mb-6 rounded-xl border p-4">
              <h2 className="mb-2 font-semibold">Report summary</h2>
              {report.terms.map((t) => (
                <p key={t.term} className="text-sm">{t.term}: {t.obtained} / {t.total} ({t.percentage ?? "—"}%)</p>
              ))}
              <p className="mt-2 text-sm font-semibold">Overall: {report.overall.obtained} / {report.overall.total} ({report.overall.percentage ?? "—"}%)</p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {grades.length === 0 && <p className="text-sm text-slate-500">No grades for this subject yet.</p>}
            {grades.map((g) => (
              <div key={g.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border p-3">
                <div>
                  <p className="text-sm font-medium">{g.studentName} — {g.subjectName} ({g.className} {g.sectionName})</p>
                  <p className="text-xs text-slate-500">{g.term}: {g.marksObtained} / {g.totalMarks} ({Math.round((g.marksObtained / g.totalMarks) * 100)}%)</p>
                </div>
                {canEdit && (
                  <button className="rounded-lg border px-3 py-1 text-sm text-red-600" onClick={async () => { if (confirm("Remove this grade? It is soft-deleted, not erased from history.")) { await fetch(`/api/school/grades?id=${g.id}`, { method: "DELETE" }); load(selected); } }}>Remove</button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </Shell>
  );
}
