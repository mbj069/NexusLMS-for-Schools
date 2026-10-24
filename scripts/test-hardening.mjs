/**
 * Hardening test harness (Phase 2.6) — runs the app on a throwaway local DB
 * and proves the trust-critical behaviours over real HTTP, not by reading code:
 *  - cross-tenant isolation (school A cannot read/write school B data)
 *  - token revocation on disable, and login failure after soft-delete
 *  - /setup cannot be used publicly to seed a non-demo deployment, and
 *    never returns a demo password
 *  - cross-origin mutation blocking (CSRF guard in proxy)
 *  - login rate limiting
 *  - attendance changes leave an old -> new audit trail (via school export)
 *
 * Usage: node scripts/test-hardening.mjs
 * It resets test-hardening.db, starts `next dev` on port 3101, runs, kills it.
 * Exit code 0 = all checks passed.
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const DB = path.join(root, "test-hardening.db");
const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_SECRET = "test-only-secret-for-hardening-harness";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
}

function cookieFrom(res) {
  const set = res.headers.get("set-cookie") || "";
  return set.split(";")[0];
}

async function req(method, url, cookie, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* export / non-json */ }
  return { status: res.status, json, text: json ? JSON.stringify(json) : "" };
}

async function login(email, password) {
  const res = await req("POST", "/api/auth/login", null, { email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${res.text}`);
  // fetch() in node does not expose set-cookie via headers.get in all cases;
  // re-request with a raw fetch to capture it.
  const raw = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return raw.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function waitReady(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/login`);
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  // --- fresh DB ------------------------------------------------------------
  if (fs.existsSync(DB)) fs.unlinkSync(DB);
  const env = { ...process.env, DATABASE_URL: `file:${DB}`, AUTH_SECRET: TEST_SECRET };
  execSync("node db/migrate.mjs", { cwd: root, env, stdio: "inherit" });
  execSync("node db/seed.mjs", { cwd: root, env, stdio: "inherit" });

  // Insert a second school + admin directly (the platform API provisions a
  // school but has no admin-creation endpoint yet — that is a known gap
  // documented in the README, not a test shortcut for tenant isolation).
  {
    const bcrypt = (await import("bcryptjs")).default;
    const { DatabaseSync } = await import("node:sqlite");
    const { randomBytes } = await import("node:crypto");
    const db = new DatabaseSync(DB);
    db.exec("PRAGMA foreign_keys = ON;");
    const schoolB = randomBytes(12).toString("hex");
    const adminB = randomBytes(12).toString("hex");
    const hash = bcrypt.hashSync("TestPass123", 12);
    db.prepare("INSERT INTO schools (id, name, slug, createdAt) VALUES (?,?,?,?)").run(schoolB, "Second Test School", "second-test", new Date().toISOString());
    db.prepare("INSERT INTO users (id, schoolId, name, email, passwordHash, role, createdAt) VALUES (?,?,?,?,?,?,?)").run(adminB, schoolB, "B Admin", "adminb@test.edu", hash, "SCHOOL_ADMIN", new Date().toISOString());
    db.close();
    globalThis.__schoolB = schoolB;
  }

  // Detached process group so cleanup kills the whole Next tree (npx ->
  // next-server), not just the npx wrapper — a leftover server holding
  // the port is what stalled a previous harness re-run.
  const proc = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  try {
    if (!(await waitReady(proc))) throw new Error("dev server did not become ready");

    // Demo seed logins are the seed's own accounts (school A = Demo Academy).
    const superCookie = await login("superadmin@nexusms.app", "demo1234");
    const adminA = await login("admin@demo.edu", "demo1234");
    const teacherA = await login("teacher@demo.edu", "demo1234");
    const adminB = await login("adminb@test.edu", "TestPass123");

    // --- cross-tenant: users ------------------------------------------------
    const usersB = await req("GET", "/api/school/users", adminB);
    check("school B admin sees only its own users", usersB.status === 200 && !usersB.text.includes("demo.edu"), `status=${usersB.status} body=${usersB.text.slice(0, 200)}`);
    const usersAWithBParam = await req("GET", "/api/school/users?schoolId=" + globalThis.__schoolB, adminA);
    check("school A admin cannot switch scope via ?schoolId=", usersAWithBParam.status === 200 && !usersAWithBParam.text.includes("adminb@test.edu"), `body=${usersAWithBParam.text.slice(0, 200)}`);

    // --- cross-tenant: create school B structure, then attack it from A ----
    const sessB = await req("POST", "/api/school/sessions", adminB, { name: "2026-27", startDate: "2026-04-01", endDate: "2027-03-31", isCurrent: true });
    check("school B can create its own session", sessB.status === 201, `status=${sessB.status} ${sessB.text.slice(0, 200)}`);
    const sessionBId = sessB.json?.session?.id ?? sessB.json?.id;
    const classB = await req("POST", "/api/school/classes", adminB, { name: "Grade 9", sessionId: sessionBId, sections: ["A"] });
    check("school B can create its own class+section", classB.status === 201, `status=${classB.status} ${classB.text.slice(0, 200)}`);
    // Fetch section B id via classes list
    const classesB = await req("GET", "/api/school/classes", adminB);
    const sectionBId = classesB.json?.classes?.[0]?.sections?.[0]?.id;
    check("school B section id resolvable", !!sectionBId, JSON.stringify(classesB.json).slice(0, 200));

    const attBFromA = await req("GET", `/api/school/attendance?sectionId=${sectionBId}&date=2026-10-24`, teacherA);
    check("teacher A reading school B attendance section => 404", attBFromA.status === 404, `status=${attBFromA.status}`);
    const attPostBFromA = await req("POST", "/api/school/attendance", teacherA, { sectionId: sectionBId, date: "2026-10-24", records: [{ studentId: "x", status: "PRESENT" }] });
    check("teacher A marking school B attendance => 404", attPostBFromA.status === 404, `status=${attPostBFromA.status}`);

    // --- revocation: disable -------------------------------------------------
    const newTeacher = await req("POST", "/api/school/users", adminA, { name: "Temp Teacher", email: "tempteacher@test.edu", password: "TestPass123", role: "TEACHER" });
    check("admin A can create a teacher", newTeacher.status === 201, `status=${newTeacher.status} ${newTeacher.text.slice(0, 200)}`);
    const tempId = newTeacher.json?.user?.id;
    const tempCookie = await login("tempteacher@test.edu", "TestPass123");
    const meBefore = await req("GET", "/api/auth/me", tempCookie);
    check("temp teacher session works before disable", meBefore.status === 200, `status=${meBefore.status}`);
    const disable = await req("PUT", "/api/school/users", adminA, { id: tempId, isActive: false });
    check("admin A can disable teacher", disable.status === 200, `status=${disable.status} ${disable.text.slice(0, 200)}`);
    const meAfter = await req("GET", "/api/auth/me", tempCookie);
    check("old token is dead immediately after disable", meAfter.status === 401, `status=${meAfter.status}`);
    const loginAfterDisable = await req("POST", "/api/auth/login", null, { email: "tempteacher@test.edu", password: "TestPass123" });
    check("disabled teacher cannot log in again", loginAfterDisable.status === 401, `status=${loginAfterDisable.status}`);

    // --- soft-delete -----------------------------------------------------------
    const delTeacher = await req("POST", "/api/school/users", adminA, { name: "Gone Teacher", email: "goneteacher@test.edu", password: "TestPass123", role: "TEACHER" });
    const goneId = delTeacher.json?.user?.id;
    const del = await req("DELETE", `/api/school/users?id=${goneId}`, adminA);
    check("soft-delete returns deleted flag", del.status === 200 && del.json?.deleted === true, `status=${del.status} ${del.text.slice(0, 200)}`);
    const usersAfterDel = await req("GET", "/api/school/users", adminA);
    check("soft-deleted teacher no longer listed", !usersAfterDel.text.includes("goneteacher@test.edu"), usersAfterDel.text.slice(0, 200));
    const loginAfterDel = await req("POST", "/api/auth/login", null, { email: "goneteacher@test.edu", password: "TestPass123" });
    check("soft-deleted teacher cannot log in", loginAfterDel.status === 401, `status=${loginAfterDel.status}`);

    // --- /setup lockdown -------------------------------------------------------
    const setup = await req("POST", "/api/setup", null, {});
    check("public /setup on non-demo deployment is blocked (403) and returns no password field", setup.status === 403 && !("password" in (setup.json ?? {})), `status=${setup.status} ${setup.text.slice(0, 200)}`);

    // --- CSRF guard --------------------------------------------------------------
    const csrf = await req("POST", "/api/school/users", adminA, { name: "Evil", email: "evil@test.edu", password: "TestPass123", role: "TEACHER" }, { Origin: "https://evil.example" });
    check("cross-origin mutation is blocked (403)", csrf.status === 403, `status=${csrf.status} ${csrf.text.slice(0, 200)}`);

    // --- rate limiting -------------------------------------------------------------
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const r = await req("POST", "/api/auth/login", null, { email: "nobody@test.edu", password: "wrong" });
      lastStatus = r.status;
    }
    check("repeated failed logins are rate-limited (429)", lastStatus === 429, `lastStatus=${lastStatus}`);

    // --- attendance audit trail ------------------------------------------------------
    const classesA = await req("GET", "/api/school/classes", adminA);
    const sectionAId = classesA.json?.classes?.[0]?.sections?.[0]?.id;
    const roster = await req("GET", `/api/school/attendance?sectionId=${sectionAId}&date=2026-10-24`, teacherA);
    const studentId = roster.json?.roster?.[0]?.studentId;
    check("school A roster resolvable for audit test", !!studentId, JSON.stringify(roster.json).slice(0, 200));
    if (studentId) {
      await req("POST", "/api/school/attendance", teacherA, { sectionId: sectionAId, date: "2026-10-24", records: [{ studentId, status: "PRESENT" }] });
      await req("POST", "/api/school/attendance", teacherA, { sectionId: sectionAId, date: "2026-10-24", records: [{ studentId, status: "ABSENT" }] });
      const expRes = await fetch(`${BASE}/api/school/export`, { headers: { Cookie: adminA } });
      const exp = await expRes.json();
      const auditHit = (exp.data?.audit_logs ?? []).some(
        (a) => a.action === "attendance.changed" && a.details && JSON.parse(a.details).oldStatus === "PRESENT" && JSON.parse(a.details).newStatus === "ABSENT"
      );
      check("attendance change leaves old->new audit row in export", auditHit, `audit rows=${(exp.data?.audit_logs ?? []).length}`);
    }

    console.log(failures === 0 ? "\nALL HARDENING CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  } finally {
    try { process.kill(-proc.pid, "SIGTERM"); } catch { try { proc.kill("SIGTERM"); } catch { /* already dead */ } }
    // Give Next a moment to exit, then force the whole group if needed.
    await new Promise((r) => setTimeout(r, 2000));
    try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch { /* already dead */ } }
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("HARNESS ERROR", e);
  process.exit(2);
});
