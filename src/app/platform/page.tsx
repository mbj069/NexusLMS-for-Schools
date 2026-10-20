"use client";

import { useEffect, useState } from "react";
import Shell from "@/components/Shell";

interface School {
  id: string;
  name: string;
  slug: string;
  phone: string | null;
  createdAt: string;
  _count: { users: number; sessions: number };
}

export default function PlatformPage() {
  const [schools, setSchools] = useState<School[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/platform/schools");
    if (res.ok) {
      const data = await res.json();
      setSchools(data.schools);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/platform/schools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Could not create school");
        return;
      }
      setName("");
      setPhone("");
      load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Schools</h1>
          <p className="text-sm text-slate-500">
            Every school is an isolated workspace on the NexusLMS platform.
          </p>
        </div>
      </div>

      <div className="mb-8 rounded-xl border bg-white p-5">
        <h2 className="mb-3 font-semibold">Onboard a new school</h2>
        <form onSubmit={create} className="flex flex-col gap-3 sm:flex-row">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="School name, e.g. City Grammar School"
            className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-600"
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone (optional)"
            className="rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-600 sm:w-48"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-blue-700 px-5 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create workspace"}
          </button>
        </form>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <p className="mt-2 text-xs text-slate-500">
          Next: sign in as that school's admin (created via the demo seed or the
          Users page) to finish setup — sessions, classes, teachers, students.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading schools…</p>
      ) : schools.length === 0 ? (
        <div className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">
          No schools yet. Create the first workspace above.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {schools.map((s) => (
            <div key={s.id} className="rounded-xl border bg-white p-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 font-bold text-blue-700">
                  {s.name.charAt(0)}
                </div>
                <div>
                  <div className="font-semibold">{s.name}</div>
                  <div className="text-xs text-slate-500">/{s.slug}</div>
                </div>
              </div>
              <div className="mt-4 flex gap-4 text-sm text-slate-600">
                <span>
                  <strong>{s._count.users}</strong> users
                </span>
                <span>
                  <strong>{s._count.sessions}</strong> sessions
                </span>
              </div>
              {s.phone && <div className="mt-1 text-xs text-slate-500">{s.phone}</div>}
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}
