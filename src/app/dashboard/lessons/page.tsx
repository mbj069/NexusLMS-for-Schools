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
interface Lesson {
  id: string;
  classSubjectId: string;
  title: string;
  content: string;
  createdAt: string;
  subjectName: string;
  sectionName: string;
  className: string;
}

export default function LessonsPage() {
  const [role, setRole] = useState<string | null>(null);
  const [subjects, setSubjects] = useState<ClassSubject[]>([]);
  const [selected, setSelected] = useState("");
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState<Lesson | null>(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(async (csId: string) => {
    const r = await fetch(`/api/school/lessons${csId ? `?classSubjectId=${csId}` : ""}`);
    const j = await r.json();
    setLessons(j.lessons ?? []);
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
    const r = await fetch("/api/school/lessons", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classSubjectId: selected, title, content }),
    });
    const j = await r.json();
    if (!r.ok) { setMsg(j.error ?? "Could not create lesson"); return; }
    setTitle(""); setContent(""); load(selected);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const r = await fetch("/api/school/lessons", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editing.id, title: editing.title, content: editing.content }),
    });
    const j = await r.json();
    if (!r.ok) { setMsg(j.error ?? "Could not save lesson"); return; }
    setEditing(null); load(selected);
  }

  async function remove(id: string) {
    if (!confirm("Delete this lesson?")) return;
    await fetch(`/api/school/lessons?id=${id}`, { method: "DELETE" });
    load(selected);
  }

  return (
    <Shell>
      <h1 className="mb-1 text-2xl font-bold">Lessons</h1>
      <p className="mb-6 text-sm text-slate-500">
        {canEdit
          ? "Write a lesson for a subject you teach. Students and parents see only their own sections."
          : "Lessons for your subjects, in newest-first order."}
      </p>
      {subjects.length === 0 ? (
        <p className="text-sm text-slate-500">No subjects assigned yet.</p>
      ) : (
        <>
          <label className="mb-4 block text-sm">
            <span className="mb-1 block font-medium">Subject</span>
            <select
              className={input}
              value={selected}
              onChange={(e) => { setSelected(e.target.value); load(e.target.value); }}
            >
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.section.class.name} {s.section.name} — {s.subject.name} ({s.teacher.name})
                </option>
              ))}
            </select>
          </label>

          {canEdit && (
            <form onSubmit={create} className="mb-8 rounded-xl border p-4">
              <h2 className="mb-3 font-semibold">New lesson</h2>
              <div className="flex flex-col gap-3">
                <input className={input} placeholder="Lesson title" value={title} onChange={(e) => setTitle(e.target.value)} required />
                <textarea className={input} rows={5} placeholder="Lesson content — notes, explanation, reading" value={content} onChange={(e) => setContent(e.target.value)} required />
                <button className="w-fit rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white">Publish lesson</button>
              </div>
            </form>
          )}
          {msg && <p className="mb-4 text-sm text-red-600">{msg}</p>}

          <div className="flex flex-col gap-4">
            {lessons.length === 0 && <p className="text-sm text-slate-500">No lessons for this subject yet.</p>}
            {lessons.map((l) => (
              <article key={l.id} className="rounded-xl border p-4">
                {editing?.id === l.id ? (
                  <form onSubmit={saveEdit} className="flex flex-col gap-3">
                    <input className={input} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
                    <textarea className={input} rows={5} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
                    <div className="flex gap-2">
                      <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">Save</button>
                      <button type="button" className="rounded-lg border px-4 py-2 text-sm" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  </form>
                ) : (
                  <>
                    <h3 className="font-semibold">{l.title}</h3>
                    <p className="mb-2 text-xs text-slate-500">{l.className} {l.sectionName} · {l.subjectName} · {new Date(l.createdAt).toLocaleDateString()}</p>
                    <p className="whitespace-pre-wrap text-sm text-slate-700">{l.content}</p>
                    {canEdit && (
                      <div className="mt-3 flex gap-2">
                        <button className="rounded-lg border px-3 py-1 text-sm" onClick={() => setEditing(l)}>Edit</button>
                        <button className="rounded-lg border px-3 py-1 text-sm text-red-600" onClick={() => remove(l.id)}>Delete</button>
                      </div>
                    )}
                  </>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </Shell>
  );
}
