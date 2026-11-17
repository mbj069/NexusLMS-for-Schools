/**
 * Phase 1 concurrency test — proves the mutable-global transaction executor
 * is gone and transactions are actually isolated:
 *  A. Structural: no `let current` in src/lib/db.ts; transaction() hands the
 *     caller an explicit tx handle; all 3 call sites use tx.run.
 *  B. Executor-level (local driver, compiled db.ts): while a transaction is
 *     open, a plain query runs OUTSIDE it — it survives the transaction's
 *     rollback, and is visible after the transaction's commit. Under the old
 *     code the plain write joined the shared-connection transaction and was
 *     rolled back with it.
 *  C. HTTP-level: parallel class/session creates through the real API all
 *     succeed, nothing is lost, and exactly one session ends up current.
 * Usage: node scripts/test-concurrency.mjs
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const DB = path.join(root, "test-concurrency.db");
const HTTP_DB = path.join(root, "test-concurrency-http.db");
const PORT = 3106;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_SECRET = "test-only-secret-for-concurrency-harness";
const TMP_DIR = path.join(root, ".tmp-dbtest");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanupDb(p) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(p + suffix); } catch { /* absent */ }
  }
}

async function main() {
  // --- A. Structural ------------------------------------------------------
  const dbSrc = fs.readFileSync(path.join(root, "src/lib/db.ts"), "utf8");
  check("no mutable global executor (no `let current` declaration)", !/^\s*let\s+current\s*[:=]/m.test(dbSrc));
  check("transaction() takes an explicit tx handle", /export async function transaction<T>\(fn: \(tx: Executor\)/.test(dbSrc));
  check("module all/get/run use the default executor, not a mutable one", /return defaultExecutor\.all<T>/.test(dbSrc) && !/return current\./.test(dbSrc));
  for (const f of ["src/app/api/school/sessions/route.ts", "src/app/api/school/classes/route.ts"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    check(`${f}: call sites use tx.run via an explicit handle`, /transaction\(async \(tx\) =>/.test(src) && !/transaction\(async \(\) =>/.test(src), "");
  }

  // --- B. Executor-level interleaving --------------------------------------
  cleanupDb(DB);
  const envB = { ...process.env, DATABASE_URL: `file:${DB}`, AUTH_SECRET: TEST_SECRET };
  execSync("node db/migrate.mjs", { cwd: root, env: envB, stdio: "inherit" });
  execSync(`npx tsc src/lib/db.ts --outDir ${TMP_DIR} --module nodenext --target es2022 --moduleResolution nodenext --skipLibCheck`, { cwd: root, stdio: "inherit" });
  process.env.DATABASE_URL = `file:${DB}`;
  delete process.env.TURSO_DATABASE_URL;
  const db = await import(path.join(TMP_DIR, "db.js"));

  const schoolRows = async () => db.all("SELECT id FROM schools ORDER BY id");
  const hasSchool = async (id) => !!(await db.get("SELECT id FROM schools WHERE id = ?", id));
  const now = new Date().toISOString();

  // B1: plain write during an open transaction is visible after commit.
  const tx1 = db.transaction(async (tx) => {
    await tx.run("INSERT INTO schools (id, name, slug, createdAt) VALUES (?,?,?,?)", "tx1-a", "Tx1 A", "tx1-a", now);
    await sleep(400);
    await tx.run("INSERT INTO schools (id, name, slug, createdAt) VALUES (?,?,?,?)", "tx1-b", "Tx1 B", "tx1-b", now);
  });
  await sleep(100);
  await db.run("INSERT INTO schools (id, name, slug, createdAt) VALUES (?,?,?,?)", "plain-during-tx1", "Plain During Tx1", "plain-during-tx1", now);
  await tx1;
  check("plain write during open tx is visible after commit", await hasSchool("plain-during-tx1"));
  check("transaction's own writes committed", (await hasSchool("tx1-a")) && (await hasSchool("tx1-b")));

  // B2: THE decisive test — plain write during a transaction that ROLLS BACK
  // must survive. Under the old shared-connection code it was rolled back too.
  let tx2Failed = false;
  const tx2 = db.transaction(async (tx) => {
    await tx.run("INSERT INTO schools (id, name, slug, createdAt) VALUES (?,?,?,?)", "doomed", "Doomed", "doomed", now);
    await sleep(400);
    throw new Error("boom");
  }).catch(() => { tx2Failed = true; });
  await sleep(100);
  await db.run("INSERT INTO schools (id, name, slug, createdAt) VALUES (?,?,?,?)", "survivor", "Survivor", "survivor", now);
  await tx2;
  check("rolling-back transaction reports its error", tx2Failed);
  check("rolled-back transaction's write is gone", !(await hasSchool("doomed")));
  check("plain write during rolled-back tx SURVIVES (no leak)", await hasSchool("survivor"));

  // B3: parallel transactions serialise cleanly — all commit, none lost.
  const before = (await schoolRows()).length;
  await Promise.all(Array.from({ length: 5 }, (_, i) =>
    db.transaction(async (tx) => {
      await tx.run("INSERT INTO schools (id, name, slug, createdAt) VALUES (?,?,?,?)", `par-${i}`, `Parallel ${i}`, `par-${i}`, now);
      await sleep(50);
    })
  ));
  const after = (await schoolRows()).length;
  check("5 parallel transactions all commit", after === before + 5, `before=${before} after=${after}`);

  // --- C. HTTP-level parallel stress ---------------------------------------
  cleanupDb(HTTP_DB);
  const env = { ...process.env, DATABASE_URL: `file:${HTTP_DB}`, AUTH_SECRET: TEST_SECRET };
  execSync("node db/migrate.mjs", { cwd: root, env, stdio: "inherit" });
  execSync("node db/seed.mjs", { cwd: root, env, stdio: "inherit" });

  const proc = spawn("npx", ["next", "dev", "-p", String(PORT)], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`${BASE}/login`); if (r.status === 200) { ready = true; break; } } catch { /* not up */ }
      await sleep(1000);
    }
    check("dev server becomes ready", ready);
    if (!ready) throw new Error("dev server did not become ready");

    const loginRaw = await fetch(`${BASE}/api/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@demo.edu", password: "demo1234" }),
    });
    const admin = loginRaw.headers.get("set-cookie")?.split(";")[0] ?? "";
    check("admin login for stress test", loginRaw.status === 200, `status=${loginRaw.status}`);

    const req = async (method, url, body) => {
      const res = await fetch(`${BASE}${url}`, {
        method,
        headers: { ...(body ? { "Content-Type": "application/json" } : {}), Cookie: admin },
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch { /* ignore */ }
      return { status: res.status, json };
    };

    const sessions0 = await req("GET", "/api/school/sessions");
    const sessionId = sessions0.json?.sessions?.[0]?.id;
    check("seed has a session to attach classes to", !!sessionId);

    // 10 parallel class creates (transactional: class + sections together).
    const classResults = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      req("POST", "/api/school/classes", { name: `Stress Class ${i}`, sessionId, sections: ["A", "B"] })
    ));
    check("10 parallel class creates all succeed", classResults.every((r) => r.status === 201), classResults.map((r) => r.status).join(","));
    const classesAfter = (await req("GET", "/api/school/classes")).json?.classes ?? [];
    const newClasses = classesAfter.filter((c) => c.name.startsWith("Stress Class"));
    check("all 10 parallel classes present with 2 sections each", newClasses.length === 10 && newClasses.every((c) => c.sections.length === 2), `found=${newClasses.length}`);

    // 10 parallel session creates with isCurrent=true — only one may win.
    const sessionResults = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      req("POST", "/api/school/sessions", { name: `Stress Session ${i}`, startDate: "2026-01-01", endDate: "2026-12-31", isCurrent: true })
    ));
    check("10 parallel session creates all succeed", sessionResults.every((r) => r.status === 201), sessionResults.map((r) => r.status).join(","));
    const sessionsAfter = (await req("GET", "/api/school/sessions")).json?.sessions ?? [];
    const currentCount = sessionsAfter.filter((s) => s.isCurrent).length;
    const newSessions = sessionsAfter.filter((s) => s.name.startsWith("Stress Session"));
    check("exactly one session is current after parallel isCurrent creates", currentCount === 1, `current=${currentCount}`);
    check("all 10 parallel sessions present", newSessions.length === 10, `found=${newSessions.length}`);

    // Parallel reads during writes stay 200.
    const reads = await Promise.all(Array.from({ length: 10 }, () => req("GET", "/api/school/classes")));
    check("parallel reads during writes all return 200", reads.every((r) => r.status === 200));
  } finally {
    try { process.kill(-proc.pid, "SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch { /* dead */ } }
    await sleep(2000);
    try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch { /* dead */ } }
  }

  console.log(failures === 0 ? "\nALL PHASE 1 CONCURRENCY CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  return failures;
}

function cleanupAll() {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  cleanupDb(DB);
  cleanupDb(HTTP_DB);
}

// process.exit() inside main() would skip cleanup, so exit here instead —
// cleanup runs first (the .finally), then the exit code is set.
main()
  .catch((e) => { console.error("HARNESS ERROR", e); return 2; })
  .finally(cleanupAll)
  .then((f) => process.exit(f === 0 ? 0 : 1));
