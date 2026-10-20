"use client";

import { useState } from "react";

export default function SetupPage() {
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  async function runSetup() {
    setBusy(true);
    setStatus(null);
    setResult(null);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: key ? { "x-setup-key": key } : {},
      });
      const data = await res.json();
      setResult(data);
      setStatus(
        data.error
          ? data.error
          : data.logins
            ? "Done — demo data is ready. You can sign in below."
            : data.message
      );
    } catch {
      setStatus("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow">
        <h1 className="text-2xl font-bold text-gray-900">NexusLMS setup</h1>
        <p className="mt-2 text-sm text-gray-600">
          Creates the database tables and loads the Demo Academy demo data
          (schools, users, classes, subjects). Run once on a fresh deployment.
        </p>
        <button
          onClick={runSetup}
          disabled={busy}
          className="mt-6 w-full rounded-lg bg-blue-600 py-2.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Working…" : "Set up demo database"}
        </button>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-gray-500">
            Already seeded? Reset with the setup key
          </summary>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Setup key"
            className="mt-2 w-full rounded-lg border px-3 py-2"
          />
        </details>
        {status && (
          <p className="mt-4 rounded-lg bg-gray-100 p-3 text-sm text-gray-800">
            {status}
          </p>
        )}
        {result?.logins && (
          <div className="mt-4 rounded-lg border p-3 text-sm">
            <p className="font-semibold">Demo logins (password: demo1234)</p>
            <ul className="mt-1 list-disc pl-5 text-gray-700">
              {result.logins.map((l: string) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <a
              href="/login"
              className="mt-3 inline-block rounded-lg bg-green-600 px-4 py-2 font-semibold text-white"
            >
              Go to sign in
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
