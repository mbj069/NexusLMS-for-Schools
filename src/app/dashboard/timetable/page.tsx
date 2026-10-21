"use client";

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

const DAYS = [
  { d: 1, label: "Mon" },
  { d: 2, label: "Tue" },
  { d: 3, label: "Wed" },
  { d: 4, label: "Thu" },
  { d: 5, label: "Fri" },
  { d: 6, label: "Sat" },
];

interface SectionInfo {
  id: string;
  name: string;
  className: string;
  context?: string;
}
interface ClassSubject {
  id: string;
  subject: { name: string };
  teacher: { name: string };
}
interface Slot {
  id: string;
  dayOfWeek: number;
  periodNumber: number;
  startTime: string;
  endTime: string;
  classSubjectId: string | null;
  subject: { name: string } | null;
  teacher: { name: string } | null;
}

const input =
  "rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600";

function toMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function toHM(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function defaultTimes(n: number) {
  const times: { start: string; end: string }[] = [];
  let cur = 8 * 60;
  for (let i = 0; i < n; i++) {
    times.push({ start: toHM(cur), end: toHM(cur + 40) });
    cur += 45;
  }
  return times;
}

export default function TimetablePage() {
  const [role, setRole] = useState<string | null>(null);
  const [sections, setSections] = useState<SectionInfo[]>([]);
  const [sectionId, setSectionId] = useState("");
  const [subjects, setSubjects] = useState<ClassSubject[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [periodCount, setPeriodCount] = useState(8);
  const [times, setTimes] = useState<{ start: string; end: string }[]>(() => defaultTimes(8));
  const [grid, setGrid] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const isAdmin = role === "SCHOOL_ADMIN" || role === "SUPER_ADMIN";

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => me && setRole(me.role))
      .catch(() => {});
    fetch("/api/school/my-sections")
      .then((r) => (r.ok ? r.json() : { sections: [] }))
      .then((d) => {
        setSections(d.sections ?? []);
        if (d.sections?.length === 1) setSectionId(d.sections[0].id);
      })
      .catch(() => {});
  }, []);

  const loadSection = useCallback(
    async (sid: string) => {
      if (!sid) return;
      const [sRes, cRes] = await Promise.all([
        fetch(`/api/school/timetable?sectionId=${sid}`).then((r) => r.json()),
        isAdmin
          ? fetch(`/api/school/class-subjects?sectionId=${sid}`).then((r) => r.json())
          : Promise.resolve({ classSubjects: [] }),
      ]);
      const loaded: Slot[] = sRes.slots ?? [];
      setSlots(loaded);
      setSubjects(cRes.classSubjects ?? []);
      if (isAdmin) {
        const maxP = loaded.reduce((m, s) => Math.max(m, s.periodNumber), 0);
        const n = Math.max(8, maxP);
        setPeriodCount(n);
        const t = defaultTimes(n);
        for (const s of loaded) {
          const i = s.periodNumber - 1;
          if (t[i]) t[i] = { start: s.startTime, end: s.endTime };
        }
        setTimes(t);
        const g: Record<string, string> = {};
        for (const s of loaded) {
          if (s.classSubjectId) g[`${s.dayOfWeek}:${s.periodNumber}`] = s.classSubjectId;
        }
        setGrid(g);
      }
      setMsg("");
    },
    [isAdmin]
  );

  useEffect(() => {
    if (sectionId) loadSection(sectionId);
  }, [sectionId, loadSection]);

  function setTime(i: number, field: "start" | "end", v: string) {
    setTimes((t) => t.map((x, j) => (j === i ? { ...x, [field]: v } : x)));
  }
  function changePeriods(n: number) {
    const next = Math.min(12, Math.max(1, n));
    setPeriodCount(next);
    setTimes((t) => {
      const base = defaultTimes(next);
      return base.map((b, i) => t[i] ?? b);
    });
  }

  async function save() {
    if (!sectionId) return;
    setBusy(true);
    setMsg("");
    const payload = [];
    for (let p = 1; p <= periodCount; p++) {
      for (const { d } of DAYS) {
        payload.push({
          dayOfWeek: d,
          periodNumber: p,
          startTime: times[p - 1]?.start ?? "08:00",
          endTime: times[p - 1]?.end ?? "08:40",
          classSubjectId: grid[`${d}:${p}`] || null,
        });
      }
    }
    const res = await fetch("/api/school/timetable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sectionId, slots: payload }),
    });
    const data = await res.json();
    setBusy(false);
    setMsg(res.ok ? `Saved — ${data.saved} periods scheduled.` : data.error || "Save failed");
    if (res.ok) loadSection(sectionId);
  }

  async function clearAll() {
    if (!sectionId || !confirm("Clear the whole timetable for this section?")) return;
    await fetch(`/api/school/timetable?sectionId=${sectionId}`, { method: "DELETE" });
    loadSection(sectionId);
  }

  const sectionLabel = (s: SectionInfo) =>
    `${s.className} · Sec ${s.name}${s.context ? ` (${s.context})` : ""}`;

  // Read-only grid model shared by viewers
  const viewCells = new Map<string, Slot>();
  for (const s of slots) viewCells.set(`${s.dayOfWeek}:${s.periodNumber}`, s);
  const viewPeriods = [...new Set(slots.map((s) => s.periodNumber))].sort((a, b) => a - b);
  const periodTime = (p: number) => {
    const s = slots.find((x) => x.periodNumber === p);
    return s ? `${s.startTime}–${s.endTime}` : "";
  };

  return (
    <Shell>
      <h1 className="mb-1 text-2xl font-bold">Timetable</h1>
      <p className="mb-6 text-sm text-slate-500">
        {isAdmin
          ? "Build the weekly schedule for each section."
          : "Weekly class schedule."}
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={sectionId}
          onChange={(e) => setSectionId(e.target.value)}
          className={`${input} min-w-56 bg-white`}
        >
          <option value="">Select a section…</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {sectionLabel(s)}
            </option>
          ))}
        </select>
        {isAdmin && sectionId && (
          <>
            <label className="text-sm text-slate-600">
              Periods/day{" "}
              <input
                type="number"
                min={1}
                max={12}
                value={periodCount}
                onChange={(e) => changePeriods(Number(e.target.value))}
                className={`${input} w-20`}
              />
            </label>
            <button
              onClick={save}
              disabled={busy}
              className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60"
            >
              {busy ? "Saving…" : "Save timetable"}
            </button>
            <button
              onClick={clearAll}
              className="rounded-lg border px-4 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              Clear
            </button>
          </>
        )}
      </div>
      {msg && <p className="mb-4 text-sm text-green-700">{msg}</p>}

      {!sectionId ? (
        <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">
          {sections.length === 0
            ? "No sections available."
            : "Pick a section to view its timetable."}
        </div>
      ) : isAdmin ? (
        <div className="overflow-x-auto rounded-xl border bg-white">
          <table className="w-full min-w-3xl border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50">
                <th className="border-b p-2 text-left font-medium text-slate-500">Period</th>
                {DAYS.map(({ label }) => (
                  <th key={label} className="border-b p-2 font-medium text-slate-500">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: periodCount }, (_, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="p-2 align-top">
                    <div className="font-medium">P{i + 1}</div>
                    <div className="mt-1 flex items-center gap-1">
                      <input
                        type="time"
                        value={times[i]?.start ?? ""}
                        onChange={(e) => setTime(i, "start", e.target.value)}
                        className="w-24 rounded border px-1 py-0.5 text-xs"
                      />
                      <span className="text-xs text-slate-400">–</span>
                      <input
                        type="time"
                        value={times[i]?.end ?? ""}
                        onChange={(e) => setTime(i, "end", e.target.value)}
                        className="w-24 rounded border px-1 py-0.5 text-xs"
                      />
                    </div>
                  </td>
                  {DAYS.map(({ d }) => (
                    <td key={d} className="p-2 align-top">
                      <select
                        value={grid[`${d}:${i + 1}`] ?? ""}
                        onChange={(e) =>
                          setGrid((g) => ({ ...g, [`${d}:${i + 1}`]: e.target.value }))
                        }
                        className="w-full min-w-32 rounded border px-1 py-1 text-xs"
                      >
                        <option value="">— Free —</option>
                        {subjects.map((cs) => (
                          <option key={cs.id} value={cs.id}>
                            {cs.subject.name} · {cs.teacher.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : slots.length === 0 ? (
        <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">
          No timetable set for this section yet.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-white">
          <table className="w-full min-w-3xl border-collapse text-sm">
            <thead>
              <tr className="bg-slate-50">
                <th className="border-b p-2 text-left font-medium text-slate-500">Period</th>
                {DAYS.map(({ label }) => (
                  <th key={label} className="border-b p-2 font-medium text-slate-500">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {viewPeriods.map((p) => (
                <tr key={p} className="border-b last:border-0">
                  <td className="p-2 align-top">
                    <div className="font-medium">P{p}</div>
                    <div className="text-xs text-slate-400">{periodTime(p)}</div>
                  </td>
                  {DAYS.map(({ d }) => {
                    const s = viewCells.get(`${d}:${p}`);
                    return (
                      <td key={d} className="p-2 align-top">
                        {s?.subject ? (
                          <div className="rounded-lg bg-blue-50 px-2 py-1.5">
                            <div className="font-medium text-blue-900">{s.subject.name}</div>
                            <div className="text-xs text-blue-700">{s.teacher?.name}</div>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
