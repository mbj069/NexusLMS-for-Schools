"use client";

import { Fragment, useEffect, useState } from "react";
import Shell from "@/components/Shell";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  phone: string | null;
}

interface Link {
  id: string;
  parent: { id: string; name: string };
  student: { id: string; name: string };
}

const ROLES = ["SCHOOL_ADMIN", "TEACHER", "STUDENT", "PARENT"];
const input = "rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600";
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

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "TEACHER", phone: "" });
  const [linkForm, setLinkForm] = useState({ parentId: "", studentId: "" });
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editVals, setEditVals] = useState({ name: "", email: "", phone: "", password: "" });

  async function load() {
    const [u, l] = await Promise.all([
      fetch("/api/school/users").then((r) => r.json()),
      fetch("/api/school/parent-links").then((r) => r.json()),
    ]);
    setUsers(u.users ?? []);
    setLinks(l.links ?? []);
  }

  useEffect(() => {
    load();
  }, []);

  async function addUser(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const { ok, data } = await api("POST", "/api/school/users", form);
    if (!ok) {
      setError(data.error || "Could not add user");
      return;
    }
    setForm({ name: "", email: "", password: "", role: "TEACHER", phone: "" });
    load();
  }

  async function addLink(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const { ok, data } = await api("POST", "/api/school/parent-links", linkForm);
    if (!ok) {
      setError(data.error || "Could not link parent");
      return;
    }
    setLinkForm({ parentId: "", studentId: "" });
    load();
  }

  function startEdit(u: User) {
    setEditingId(u.id);
    setEditVals({ name: u.name, email: u.email, phone: u.phone ?? "", password: "" });
    setError("");
  }

  async function saveEdit(id: string) {
    setError("");
    const body: Record<string, string> = {
      id,
      name: editVals.name,
      email: editVals.email,
      phone: editVals.phone,
    };
    if (editVals.password) body.password = editVals.password;
    const { ok, data } = await api("PUT", "/api/school/users", body);
    if (!ok) {
      setError(data.error || "Could not save");
      return;
    }
    setEditingId(null);
    load();
  }

  async function deleteUser(u: User) {
    const extra =
      u.role === "STUDENT"
        ? " Their enrollments, attendance and grades will be removed."
        : u.role === "PARENT"
          ? " Their links to children will be removed."
          : "";
    if (!confirm(`Delete ${u.name} (${u.email})?${extra}`)) return;
    setError("");
    const { ok, data } = await api("DELETE", `/api/school/users?id=${u.id}`);
    if (!ok) setError(data.error || "Could not delete user");
    else load();
  }

  async function unlink(l: Link) {
    if (!confirm(`Unlink ${l.parent.name} from ${l.student.name}?`)) return;
    setError("");
    const { ok, data } = await api("DELETE", `/api/school/parent-links?id=${l.id}`);
    if (!ok) setError(data.error || "Could not unlink");
    else load();
  }

  const shown = filter ? users.filter((u) => u.role === filter) : users;
  const parents = users.filter((u) => u.role === "PARENT");
  const students = users.filter((u) => u.role === "STUDENT");

  return (
    <Shell>
      <h1 className="mb-1 text-2xl font-bold">Users</h1>
      <p className="mb-6 text-sm text-slate-500">Teachers, students, parents, and fellow admins.</p>

      <div className="mb-6 rounded-xl border bg-white p-5">
        <h2 className="mb-3 font-semibold">Add user</h2>
        <form onSubmit={addUser} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Full name" className="rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-600" />
          <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="Email" className="rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-600" />
          <input required type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="Password (min 8 chars)" className="rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-600" />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
            className="rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-600">
            {ROLES.map((r) => <option key={r} value={r}>{r.replace("_", " ")}</option>)}
          </select>
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
            placeholder="Phone (optional)" className="rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-600" />
          <button className="rounded-lg bg-blue-700 px-5 py-2 text-sm font-medium text-white hover:bg-blue-800">
            Add user
          </button>
        </form>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>

      <div className="mb-6 rounded-xl border bg-white p-5">
        <h2 className="mb-3 font-semibold">Link parents to children</h2>
        <form onSubmit={addLink} className="flex flex-col gap-3 sm:flex-row">
          <select required value={linkForm.parentId} onChange={(e) => setLinkForm({ ...linkForm, parentId: e.target.value })}
            className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-600">
            <option value="">Select parent…</option>
            {parents.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.email})</option>)}
          </select>
          <select required value={linkForm.studentId} onChange={(e) => setLinkForm({ ...linkForm, studentId: e.target.value })}
            className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-600">
            <option value="">Select student…</option>
            {students.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.email})</option>)}
          </select>
          <button className="rounded-lg bg-blue-700 px-5 py-2 text-sm font-medium text-white hover:bg-blue-800">
            Link
          </button>
        </form>
        {links.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-slate-600">
            {links.map((l) => (
              <li key={l.id} className="flex items-center justify-between rounded-lg px-2 py-1 hover:bg-slate-50">
                <span>{l.parent.name} → {l.student.name}</span>
                <button onClick={() => unlink(l)} className={dangerBtn}>Unlink</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mb-3 flex gap-2">
        <button onClick={() => setFilter("")}
          className={`rounded-full px-3 py-1 text-xs ${!filter ? "bg-blue-700 text-white" : "bg-white border text-slate-600"}`}>
          All ({users.length})
        </button>
        {ROLES.map((r) => (
          <button key={r} onClick={() => setFilter(r)}
            className={`rounded-full px-3 py-1 text-xs ${filter === r ? "bg-blue-700 text-white" : "bg-white border text-slate-600"}`}>
            {r.replace("_", " ")} ({users.filter((u) => u.role === r).length})
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Phone</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <Fragment key={u.id}>
                <tr className="border-t">
                  <td className="px-4 py-2.5 font-medium">{u.name}</td>
                  <td className="px-4 py-2.5 text-slate-600">{u.email}</td>
                  <td className="px-4 py-2.5">
                    <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs text-blue-700">
                      {u.role.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{u.phone ?? "—"}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => (editingId === u.id ? setEditingId(null) : startEdit(u))} className={iconBtn}>
                      {editingId === u.id ? "Close" : "Edit"}
                    </button>
                    <button onClick={() => deleteUser(u)} className={dangerBtn}>Delete</button>
                  </td>
                </tr>
                {editingId === u.id && (
                  <tr className="border-t bg-slate-50">
                    <td colSpan={5} className="px-4 py-3">
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                        <input value={editVals.name} onChange={(e) => setEditVals({ ...editVals, name: e.target.value })}
                          placeholder="Full name" className={input} />
                        <input type="email" value={editVals.email} onChange={(e) => setEditVals({ ...editVals, email: e.target.value })}
                          placeholder="Email" className={input} />
                        <input value={editVals.phone} onChange={(e) => setEditVals({ ...editVals, phone: e.target.value })}
                          placeholder="Phone" className={input} />
                        <input type="password" value={editVals.password} onChange={(e) => setEditVals({ ...editVals, password: e.target.value })}
                          placeholder="New password (leave blank to keep)" className={input} />
                        <div className="flex gap-2">
                          <button onClick={() => saveEdit(u.id)}
                            className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800">
                            Save
                          </button>
                          <button onClick={() => setEditingId(null)} className="rounded-lg border px-4 py-2 text-sm text-slate-600 hover:bg-white">
                            Cancel
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">No users yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}
