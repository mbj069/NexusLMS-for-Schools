"use client";

import { useCallback, useEffect, useState } from "react";
import Shell from "@/components/Shell";

const STATUSES = [
  { v: "PRESENT", label: "Present", active: "bg-green-600 text-white border-green-600" },
  { v: "ABSENT", label: "Absent", active: "bg-red-600 text-white border-red-600" },
  { v: "LATE", label: "Late", active: "bg-amber-500 text-white border-amber-500" },
  { v: "LEAVE", label: "Leave", active: "bg-sky-600 text-white border-sky-600" },
] as const;

const input =
  "rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600";

interface SectionInfo {
  id: string;
  name: string;
  className: string;
  context?: string;
  studentId?: string;
  studentName?: string;
}
interface RosterRow {
  studentId: string;
  name: string;
  rollNumber: string | null;
  status: string | null;
}
interface SummaryRow {
  studentId: string;
  name: string;
  rollNumber: string | null;
  total: number;
  present: number;
  absent: number;
  late: number;
  leave: number;
  percentage: number | null;
}
interface RecordRow {
  date: string;
  status: string;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
function monthStr() {
  return todayStr().slice(0, 7);
}

function StatusBadge({ status }: { status: string }) {
  const s = STATUSES.find((x) => x.v === status);
  return (
    <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${s?.active ?? "bg-slate-100 text-slate-600"}`}>
      {s?.label ?? status}
    </span>
  );
}

export default function AttendancePage() {
  const [role, setRole] = useState<string | null>(null);
  const [meId, setMeId] = useState("");
  const [sections, setSections] = useState<SectionInfo[]>([]);
  const [sectionId, setSectionId] = useState("");
  const [date, setDate] = useState(todayStr());
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<"mark" | "summary">("mark");
  const [month, setMonth] = useState(monthStr());
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // student / parent single view
  const [childId, setChildId] = useState("");
  const [single, setSingle] = useState<{ summary: SummaryRow; records: RecordRow[]; name: string } | null>(null);

  const canMark = role === "TEACHER" || role === "SCHOOL_ADMIN" || role === "SUPER_ADMIN";
  const isViewer = role === "STUDENT" || role === "PARENT";

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => {
        if (me) {
          setRole(me.role);
          setMeId(me.id);
        }
      })
      .catch(() => {});
    fetch("/api/school/my-sections")
      .then((r) => (r.ok ? r.json() : { sections: [] }))
      .then((d) => {
        const list: SectionInfo[] = d.sections ?? [];
        setSections(list);
        if (list.length === 1) setSectionId(list[0].id);
      })
      .catch(() => {});
  }, []);

  const loadRoster = useCallback(async (sid: string, d: string) => {
    if (!sid || !d) return;
    const res = await fetch(`/api/school/attendance?sectionId=${sid}&date=${d}`).then((r) => r.json());
    const rows: RosterRow[] = res.roster ?? [];
    setRoster(rows);
    const m: Record<string, string> = {};
    for (const r of rows) if (r.status) m[r.studentId] = r.status;
    setMarks(m);
    setMsg(
      res.markedCount > 0 && res.markedCount === rows.length
        ? `Attendance already marked for ${d} — editing will overwrite it.`
        : ""
    );
  }, []);

  const loadSummary = useCallback(async (sid: string, m: string) => {
    if (!sid || !m) return;
    const res = await fetch(`/api/school/attendance?sectionId=${sid}&month=${m}`).then((r) => r.json());
    setSummary(res.summary ?? []);
  }, []);

  const loadSingle = useCallback(async (sid: string, m: string, label: string) => {
    if (!sid || !m) return;
    const res = await fetch(`/api/school/attendance?studentId=${sid}&month=${m}`).then((r) => r.json());
    if (res.student) setSingle({ summary: res.summary, records: res.records ?? [], name: label });
    else setSingle(null);
  }, []);

  useEffect(() => {
    if (!canMark || !sectionId) return;
    if (tab === "mark") loadRoster(sectionId, date);
    else loadSummary(sectionId, month);
  }, [sectionId, date, month, tab, canMark, loadRoster, loadSummary]);

  useEffect(() => {
    if (role === "STUDENT" && meId) loadSingle(meId, month, "My");
    if (role === "PARENT" && childId) {
      const c = children.find((x) => x.studentId === childId);
      loadSingle(childId, month, c?.studentName ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, meId, childId, month]);

  const children = [...new Map(sections.filter((s) => s.studentId).map((s) => [s.studentId!, s])).values()];

  function setMark(id: string, v: string) {
    setMarks((m) => ({ ...m, [id]: v }));
  }
  function markAllPresent() {
    const m: Record<string, string> = {};
    for (const r of roster) m[r.studentId] = "PRESENT";
    setMarks(m);
  }

  async function save() {
    if (!sectionId) return;
    setBusy(true);
    setMsg("");
    const records = roster
      .filter((r) => marks[r.studentId])
      .map((r) => ({ studentId: r.studentId, status: marks[r.studentId] }));
    const res = await fetch("/api/school/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sectionId, date, records }),
    });
    const data = await res.json();
    setBusy(false);
    setMsg(res.ok ? `Saved attendance for ${data.saved} students on ${date}.` : data.error || "Save failed");
    if (res.ok) loadRoster(sectionId, date);
  }

  const sectionLabel = (s: SectionInfo) =>
    `${s.className} · Sec ${s.name}${s.context ? ` (${s.context})` : ""}`;

  return (
    <Shell>
      <h1 className="mb-1 text-2xl font-bold">Attendance</h1>
      <p className="mb-6 text-sm text-slate-500">
        {canMark ? "Mark daily attendance and review monthly summaries." : "Attendance record."}
      </p>

      {canMark && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="flex rounded-lg border bg-white p-0.5 text-sm">
              {(["mark", "summary"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`rounded-md px-3 py-1.5 capitalize ${tab === t ? "bg-blue-600 text-white" : "text-slate-600"}`}
                >
                  {t === "mark" ? "Mark" : "Summary"}
                </button>
              ))}
            </div>
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
            {tab === "mark" ? (
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${input} bg-white`} />
            ) : (
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={`${input} bg-white`} />
            )}
          </div>
          {msg && <p className="mb-4 text-sm text-slate-600">{msg}</p>}

          {!sectionId ? (
            <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">
              {sections.length === 0 ? "No sections assigned to you." : "Pick a section to continue."}
            </div>
          ) : tab === "mark" ? (
            <div className="rounded-xl border bg-white">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <div className="text-sm font-medium">
                  {roster.length} students · {date}
                </div>
                <div className="flex gap-2">
                  <button onClick={markAllPresent} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-50">
                    Mark all present
                  </button>
                  <button
                    onClick={save}
                    disabled={busy || roster.length === 0}
                    className="rounded-lg bg-blue-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60"
                  >
                    {busy ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
              <ul className="divide-y">
                {roster.map((r) => (
                  <li key={r.studentId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                    <div className="text-sm">
                      <span className="font-medium">{r.name}</span>
                      {r.rollNumber && <span className="ml-2 text-xs text-slate-400">Roll {r.rollNumber}</span>}
                    </div>
                    <div className="flex gap-1.5">
                      {STATUSES.map((s) => (
                        <button
                          key={s.v}
                          onClick={() => setMark(r.studentId, s.v)}
                          className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                            marks[r.studentId] === s.v ? s.active : "border-slate-200 text-slate-500 hover:bg-slate-50"
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border bg-white">
              <table className="w-full min-w-xl border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 text-left">
                    <th className="border-b p-2 font-medium text-slate-500">Student</th>
                    <th className="border-b p-2 font-medium text-slate-500">Present</th>
                    <th className="border-b p-2 font-medium text-slate-500">Absent</th>
                    <th className="border-b p-2 font-medium text-slate-500">Late</th>
                    <th className="border-b p-2 font-medium text-slate-500">Leave</th>
                    <th className="border-b p-2 font-medium text-slate-500">%</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((s) => (
                    <tr key={s.studentId} className="border-b last:border-0">
                      <td className="p-2 font-medium">
                        {s.name}
                        {s.rollNumber && <span className="ml-2 text-xs text-slate-400">#{s.rollNumber}</span>}
                      </td>
                      <td className="p-2 text-green-700">{s.present}</td>
                      <td className="p-2 text-red-700">{s.absent}</td>
                      <td className="p-2 text-amber-700">{s.late}</td>
                      <td className="p-2 text-sky-700">{s.leave}</td>
                      <td className="p-2 font-semibold">{s.percentage === null ? "—" : `${s.percentage}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {summary.length === 0 && (
                <p className="p-8 text-center text-sm text-slate-500">No attendance marked this month yet.</p>
              )}
            </div>
          )}
        </>
      )}

      {isViewer && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            {role === "PARENT" && (
              <select value={childId} onChange={(e) => setChildId(e.target.value)} className={`${input} min-w-56 bg-white`}>
                <option value="">Select a child…</option>
                {children.map((c) => (
                  <option key={c.studentId} value={c.studentId}>
                    {c.studentName}
                  </option>
                ))}
              </select>
            )}
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={`${input} bg-white`} />
          </div>
          {!single ? (
            <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">
              {role === "PARENT" && !childId ? "Select a child to view their attendance." : "No attendance records yet."}
            </div>
          ) : (
            <>
              <div className="mb-4 grid gap-4 sm:grid-cols-4">
                {[
                  { label: "Attendance", value: single.summary.percentage === null ? "—" : `${single.summary.percentage}%` },
                  { label: "Present", value: single.summary.present },
                  { label: "Absent", value: single.summary.absent },
                  { label: "Late / Leave", value: `${single.summary.late} / ${single.summary.leave}` },
                ].map((c) => (
                  <div key={c.label} className="rounded-xl border bg-white p-4">
                    <div className="text-xs text-slate-500">{c.label}</div>
                    <div className="mt-1 text-2xl font-bold">{c.value}</div>
                  </div>
                ))}
              </div>
              <div className="rounded-xl border bg-white">
                <ul className="divide-y">
                  {single.records.map((r) => (
                    <li key={r.date} className="flex items-center justify-between px-4 py-2.5 text-sm">
                      <span>{r.date}</span>
                      <StatusBadge status={r.status} />
                    </li>
                  ))}
                </ul>
                {single.records.length === 0 && (
                  <p className="p-8 text-center text-sm text-slate-500">Nothing marked this month.</p>
                )}
              </div>
            </>
          )}
        </>
      )}
    </Shell>
  );
}
