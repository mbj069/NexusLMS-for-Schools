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
interface Question {
  id: string;
  text: string;
  type: "MCQ" | "SHORT";
  optionsJson: string | null;
  correctAnswer?: string | null;
  marks: number;
}
interface Quiz {
  id: string;
  classSubjectId: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  totalMarks: number;
  subjectName: string;
  sectionName: string;
  className: string;
  questionCount: number;
  myAttempt?: { score: number | null; submittedAt: string } | null;
}
interface Attempt {
  id: string;
  studentId: string;
  studentName?: string;
  answersJson: string;
  score: number | null;
  submittedAt: string;
}

export default function QuizzesPage() {
  const [role, setRole] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<ClassSubject[]>([]);
  const [selected, setSelected] = useState("");
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [title, setTitle] = useState("");
  const [totalMarks, setTotalMarks] = useState("10");
  const [dueDate, setDueDate] = useState("");
  const [msg, setMsg] = useState("");
  const [questions, setQuestions] = useState<Record<string, Question[]>>({});
  const [attempts, setAttempts] = useState<Record<string, Attempt[]>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [qText, setQText] = useState("");
  const [qType, setQType] = useState<"MCQ" | "SHORT">("MCQ");
  const [qOptions, setQOptions] = useState("");
  const [qCorrect, setQCorrect] = useState("");
  const [qMarks, setQMarks] = useState("1");
  const [finalScore, setFinalScore] = useState<Record<string, string>>({});

  const load = useCallback(async (csId: string) => {
    const r = await fetch(`/api/school/quizzes${csId ? `?classSubjectId=${csId}` : ""}`);
    const j = await r.json();
    setQuizzes(j.quizzes ?? []);
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

  async function createQuiz(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    const r = await fetch("/api/school/quizzes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classSubjectId: selected, title, totalMarks: Number(totalMarks), dueDate: dueDate || null }),
    });
    const j = await r.json();
    if (!r.ok) { setMsg(j.error ?? "Could not create quiz"); return; }
    setTitle(""); setTotalMarks("10"); setDueDate(""); load(selected);
  }

  async function loadQuestions(q: Quiz) {
    const r = await fetch(`/api/school/questions?quizId=${q.id}`);
    const j = await r.json();
    setQuestions((s) => ({ ...s, [q.id]: j.questions ?? [] }));
  }

  async function addQuestion(q: Quiz) {
    setMsg("");
    const options = qType === "MCQ" ? qOptions.split("\n").map((o) => o.trim()).filter(Boolean) : undefined;
    const r = await fetch("/api/school/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quizId: q.id, text: qText, type: qType, options, correctAnswer: qCorrect || null, marks: Number(qMarks) }),
    });
    const j = await r.json();
    if (!r.ok) { setMsg(j.error ?? "Could not add question"); return; }
    setQText(""); setQOptions(""); setQCorrect(""); setQMarks("1"); loadQuestions(q);
  }

  async function attempt(q: Quiz) {
    const qs = questions[q.id] ?? [];
    const payload = qs.map((qq) => ({ questionId: qq.id, answer: answers[`${q.id}:${qq.id}`] ?? "" }));
    const r = await fetch("/api/school/quiz-attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quizId: q.id, answers: payload }),
    });
    const j = await r.json();
    if (!r.ok) { setMsg(j.error ?? "Could not submit attempt"); return; }
    load(selected);
  }

  async function loadAttempts(q: Quiz) {
    const r = await fetch(`/api/school/quiz-attempts?quizId=${q.id}`);
    const j = await r.json();
    setAttempts((s) => ({ ...s, [q.id]: j.attempts ?? [] }));
  }

  async function gradeAttempt(q: Quiz, a: Attempt) {
    const r = await fetch("/api/school/quiz-attempts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id, score: Number(finalScore[a.id] ?? a.score ?? 0) }),
    });
    const j = await r.json();
    if (!r.ok) { setMsg(j.error ?? "Could not grade attempt"); return; }
    loadAttempts(q);
  }

  return (
    <Shell>
      <h1 className="mb-1 text-2xl font-bold">Quizzes</h1>
      <p className="mb-6 text-sm text-slate-500">
        MCQ questions are auto-graded on submission. Short-answer questions await teacher marking — the score shown is the MCQ part until a teacher sets the final score. Each student attempts a quiz once.
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
            <form onSubmit={createQuiz} className="mb-8 rounded-xl border p-4">
              <h2 className="mb-3 font-semibold">New quiz</h2>
              <div className="flex flex-wrap gap-3">
                <input className={input} placeholder="Quiz title" value={title} onChange={(e) => setTitle(e.target.value)} required />
                <label className="text-sm">Total marks <input type="number" min={1} className={input} value={totalMarks} onChange={(e) => setTotalMarks(e.target.value)} required /></label>
                <label className="text-sm">Due date <input type="date" className={input} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
                <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">Create quiz</button>
              </div>
            </form>
          )}
          {msg && <p className="mb-4 text-sm text-red-600">{msg}</p>}

          <div className="flex flex-col gap-4">
            {quizzes.length === 0 && <p className="text-sm text-slate-500">No quizzes for this subject yet.</p>}
            {quizzes.map((q) => (
              <article key={q.id} className="rounded-xl border p-4">
                <h3 className="font-semibold">{q.title}</h3>
                <p className="text-xs text-slate-500">{q.className} {q.sectionName} · {q.subjectName} · {q.questionCount} questions · {q.totalMarks} marks {q.dueDate ? `· Due ${new Date(q.dueDate).toLocaleDateString()}` : ""}</p>
                {role === "STUDENT" && q.myAttempt && (
                  <p className="mt-1 text-sm font-medium text-green-700">Attempted — score {q.myAttempt.score ?? "—"} / {q.totalMarks} (short answers, if any, still await teacher marking)</p>
                )}

                <button className="mt-3 rounded-lg border px-3 py-1 text-sm" onClick={() => loadQuestions(q)}>View questions</button>
                {canEdit && (
                  <>
                    <button className="ml-2 rounded-lg border px-3 py-1 text-sm" onClick={() => loadAttempts(q)}>View attempts</button>
                    <button className="ml-2 rounded-lg border px-3 py-1 text-sm text-red-600" onClick={async () => { if (confirm("Delete this quiz, its questions and attempts?")) { await fetch(`/api/school/quizzes?id=${q.id}`, { method: "DELETE" }); load(selected); } }}>Delete</button>
                  </>
                )}

                {(questions[q.id] ?? []).length > 0 && (
                  <div className="mt-3 flex flex-col gap-3">
                    {(questions[q.id] ?? []).map((qq, i) => {
                      const opts: string[] = qq.optionsJson ? JSON.parse(qq.optionsJson) : [];
                      return (
                        <div key={qq.id} className="rounded-lg border p-3">
                          <p className="text-sm font-medium">Q{i + 1}. {qq.text} <span className="text-slate-500">({qq.type}, {qq.marks} marks)</span></p>
                          {role === "STUDENT" && !q.myAttempt ? (
                            qq.type === "MCQ" ? (
                              <div className="mt-2 flex flex-col gap-1">
                                {opts.map((o) => (
                                  <label key={o} className="text-sm"><input type="radio" name={`${q.id}:${qq.id}`} checked={answers[`${q.id}:${qq.id}`] === o} onChange={() => setAnswers((s) => ({ ...s, [`${q.id}:${qq.id}`]: o }))} /> {o}</label>
                                ))}
                              </div>
                            ) : (
                              <textarea className={input + " mt-2 w-full"} rows={3} placeholder="Your answer" value={answers[`${q.id}:${qq.id}`] ?? ""} onChange={(e) => setAnswers((s) => ({ ...s, [`${q.id}:${qq.id}`]: e.target.value }))} />
                            )
                          ) : (
                            <p className="text-sm text-slate-500">{qq.type === "MCQ" ? `Options: ${opts.join(", ")}` : "Short answer"}{canEdit && qq.correctAnswer ? ` · Correct: ${qq.correctAnswer}` : ""}</p>
                          )}
                          {canEdit && <button className="mt-1 text-sm text-red-600" onClick={async () => { await fetch(`/api/school/questions?id=${qq.id}`, { method: "DELETE" }); loadQuestions(q); }}>Delete question</button>}
                        </div>
                      );
                    })}
                    {role === "STUDENT" && !q.myAttempt && (questions[q.id] ?? []).length > 0 && (
                      <button className="w-fit rounded-lg bg-blue-600 px-4 py-2 text-sm text-white" onClick={() => attempt(q)}>Submit quiz (once only)</button>
                    )}
                  </div>
                )}

                {canEdit && (
                  <div className="mt-4 rounded-lg border p-3">
                    <h4 className="mb-2 text-sm font-semibold">Add question</h4>
                    <div className="flex flex-col gap-2">
                      <input className={input} placeholder="Question text" value={qText} onChange={(e) => setQText(e.target.value)} />
                      <div className="flex gap-2">
                        <select className={input} value={qType} onChange={(e) => setQType(e.target.value as "MCQ" | "SHORT")}>
                          <option value="MCQ">MCQ</option>
                          <option value="SHORT">Short answer</option>
                        </select>
                        <input type="number" min={1} className={input} placeholder="Marks" value={qMarks} onChange={(e) => setQMarks(e.target.value)} />
                      </div>
                      {qType === "MCQ" && (
                        <>
                          <textarea className={input} rows={3} placeholder="Options, one per line" value={qOptions} onChange={(e) => setQOptions(e.target.value)} />
                          <input className={input} placeholder="Correct answer (must match an option exactly)" value={qCorrect} onChange={(e) => setQCorrect(e.target.value)} />
                        </>
                      )}
                      <button className="w-fit rounded-lg bg-blue-600 px-3 py-1 text-sm text-white" onClick={() => addQuestion(q)}>Add question</button>
                    </div>
                  </div>
                )}

                {canEdit && (attempts[q.id] ?? []).map((a) => (
                  <div key={a.id} className="mt-3 rounded-lg border p-3">
                    <p className="text-sm font-medium">{a.studentName ?? a.studentId} · Score {a.score ?? "—"} / {q.totalMarks} · {new Date(a.submittedAt).toLocaleString()}</p>
                    <div className="mt-2 flex gap-2">
                      <input type="number" min={0} max={q.totalMarks} className={input} placeholder="Final score" value={finalScore[a.id] ?? String(a.score ?? "")} onChange={(e) => setFinalScore((s) => ({ ...s, [a.id]: e.target.value }))} />
                      <button className="rounded-lg bg-blue-600 px-3 py-1 text-sm text-white" onClick={() => gradeAttempt(q, a)}>Set final score</button>
                    </div>
                  </div>
                ))}
              </article>
            ))}
          </div>
        </>
      )}
    </Shell>
  );
}
