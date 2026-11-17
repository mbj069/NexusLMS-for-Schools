/**
 * Control-plane test suite (Phase 2).
 *
 * Run:  npm run test:control   (or: node scripts/test-control-plane.mjs)
 *
 * Sections:
 *   A. Guardrail — control DB must never be the tenant DB (written FIRST,
 *      per the approved addenda: proven before the runner ever touches a
 *      real Turso URL).
 *   B. Versioned migrations — apply, idempotency, checksum tamper, broken
 *      migration rollback, schema-shape checks (no legacy, no locale, no
 *      student data).
 *   C. Repositories — both D-4 billing models, secret-reference validation,
 *      entitlements, grants, jobs, audit, transaction isolation.
 *   D. Logging — structured JSON, correlation IDs, denylist redaction.
 *   E. Vocabulary — docs/capability-vocabulary.md agrees with the code list.
 *   F. Tenant executor untouched.
 *
 * Compiles the control TypeScript (CommonJS, so extensionless relative
 * imports resolve) into .tmp-controltest/ and tests against a throwaway
 * local SQLite file. The scratch dir is removed at the end, whatever the
 * outcome. Exit code 0 only when every check passes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const scratch = path.join(root, ".tmp-controltest");
const testDb = path.join(scratch, "control-test.db");
const migrationsDir = path.join(root, "db", "control", "migrations");

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, extra = "") {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runRunner(env) {
  return spawnSync("node", [path.join(root, "db", "control", "migrate.mjs")], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file), "utf8").digest("hex");
}

async function main() {
  // --- Setup: clean scratch, compile control TS -------------------------------
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  // Keep the harness process free of any Turso vars so every test is local.
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  delete process.env.CONTROL_TURSO_DATABASE_URL;
  delete process.env.CONTROL_TURSO_AUTH_TOKEN;
  delete process.env.DATABASE_URL;

  console.log("Compiling control TypeScript...");
  const tsc = spawnSync(
    path.join(root, "node_modules", ".bin", "tsc"),
    [
      "--module", "commonjs",
      "--target", "es2022",
      "--moduleResolution", "node",
      "--esModuleInterop",
      "--skipLibCheck",
      "--outDir", scratch,
      path.join(root, "src", "lib", "control-db.ts"),
      path.join(root, "src", "lib", "logging.ts"),
      path.join(root, "src", "lib", "control", "validators.ts"),
      path.join(root, "src", "lib", "control", "repositories.ts"),
    ],
    { cwd: root, encoding: "utf8" }
  );
  if (tsc.status !== 0) {
    console.log(tsc.stdout);
    console.log(tsc.stderr);
    throw new Error("tsc compile failed — cannot run control-plane tests");
  }

  // ========================================================================
  console.log("\nA. Guardrail (control DB must never be the tenant DB)");
  // A1: local equality refused.
  const a1 = runRunner({
    CONTROL_DATABASE_URL: `file:${testDb}`,
    DATABASE_URL: `file:${testDb}`,
  });
  check("A1 local control==tenant refused (exit 1, REFUSED)", a1.status === 1 && /REFUSED/.test(a1.stderr));
  // A2: Turso equality refused, before any network call.
  const a2 = runRunner({
    CONTROL_TURSO_DATABASE_URL: "libsql://x.turso.io",
    CONTROL_TURSO_AUTH_TOKEN: "fake",
    TURSO_DATABASE_URL: "libsql://x.turso.io",
    TURSO_AUTH_TOKEN: "fake",
  });
  check("A2 Turso control==tenant refused (exit 1, REFUSED)", a2.status === 1 && /REFUSED/.test(a2.stderr));
  // A3: different targets pass the guardrail (fake Turso URL then fails at
  // connect time — the point is it is NOT a guardrail refusal).
  const a3 = runRunner({
    CONTROL_TURSO_DATABASE_URL: "libsql://control-x.turso.io",
    CONTROL_TURSO_AUTH_TOKEN: "fake",
    TURSO_DATABASE_URL: "libsql://tenant-y.turso.io",
    TURSO_AUTH_TOKEN: "fake",
  });
  check("A3 different Turso targets pass the guardrail", !/REFUSED/.test(a3.stderr + a3.stdout));
  // A4: module-level guardrail — requiring control-db and querying with
  // equal URLs throws before any connection opens.
  fs.writeFileSync(
    path.join(scratch, "guardrail-child.cjs"),
    `const { controlAll } = require("./control-db.js");
controlAll("SELECT 1").then(() => { console.log("NO_REFUSAL"); process.exit(0); })
.catch((e) => { console.log("REFUSED:" + e.message); process.exit(e.message.includes("REFUSED") ? 2 : 3); });`
  );
  const a4 = spawnSync("node", [path.join(scratch, "guardrail-child.cjs")], {
    cwd: scratch,
    env: {
      ...process.env,
      CONTROL_DATABASE_URL: `file:${testDb}`,
      DATABASE_URL: `file:${testDb}`,
    },
    encoding: "utf8",
  });
  check("A4 control-db module refuses equal URLs on first use", a4.status === 2 && /REFUSED/.test(a4.stdout));

  // ========================================================================
  console.log("\nB. Versioned migrations");
  const b1 = runRunner({ CONTROL_DATABASE_URL: `file:${testDb}` });
  check("B1 runner applies 0001_initial (exit 0)", b1.status === 0 && /applied/.test(b1.stdout), b1.stderr);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(testDb);
  const migRows = db.prepare("SELECT version, checksum FROM control_migrations").all();
  check(
    "B2 control_migrations records version + checksum",
    migRows.length === 1 && migRows[0].version === "0001_initial" && migRows[0].checksum === sha256(path.join(migrationsDir, "0001_initial.sql"))
  );
  const b2 = runRunner({ CONTROL_DATABASE_URL: `file:${testDb}` });
  check("B3 re-run is a no-op (already applied)", b2.status === 0 && /already applied/.test(b2.stdout));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  const expectedTables = [
    "control_migrations", "migration_jobs", "organization_memberships", "organizations",
    "plan_entitlements", "plans", "platform_admins", "platform_audit_logs",
    "provisioning_jobs", "secret_references", "subscriptions",
    "support_access_grants", "tenant_databases", "tenant_usage_summaries",
  ];
  check("B4 all 14 control tables exist", expectedTables.every((t) => tables.includes(t)), `got: ${tables.join(",")}`);
  const allCols = [];
  for (const t of tables) {
    for (const c of db.prepare(`PRAGMA table_info(${t})`).all()) allCols.push(`${t}.${c.name}`);
  }
  check("B5 no legacy columns or tables (D-14)", !allCols.some((c) => /legacy/i.test(c)) && !tables.some((t) => /legacy|migration_mapping/i.test(t)));
  check("B6 no locale/language columns (D-12)", !allCols.some((c) => /\.(locale|language)$/i.test(c)));
  check(
    "B7 no student data in control schema (counts only)",
    !tables.some((t) => /student/i.test(t) && t !== "tenant_usage_summaries") &&
      !allCols.some((c) => /\.(studentId|student_id|studentName|studentEmail)$/i.test(c))
  );
  // B8: checksum tamper — apply from a copy, then change the file.
  const tamperDir = path.join(scratch, "migrations-tamper");
  fs.cpSync(migrationsDir, tamperDir, { recursive: true });
  const tamperDb = path.join(scratch, "tamper.db");
  const t1 = runRunner({ CONTROL_DATABASE_URL: `file:${tamperDb}`, CONTROL_MIGRATIONS_DIR: tamperDir });
  fs.appendFileSync(path.join(tamperDir, "0001_initial.sql"), "\n-- tampered after apply\n");
  const t2 = runRunner({ CONTROL_DATABASE_URL: `file:${tamperDb}`, CONTROL_MIGRATIONS_DIR: tamperDir });
  check("B8 checksum tamper refused after apply", t1.status === 0 && t2.status === 1 && /CHECKSUM MISMATCH/.test(t2.stderr));
  // B9: broken migration rolls back and records nothing.
  const brokenDir = path.join(scratch, "migrations-broken");
  fs.cpSync(migrationsDir, brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, "0002_broken.sql"), "CREATE TABLE broken (id TEXT PRIMARY KEY;\n");
  const brokenDb = path.join(scratch, "broken.db");
  const br = runRunner({ CONTROL_DATABASE_URL: `file:${brokenDb}`, CONTROL_MIGRATIONS_DIR: brokenDir });
  const brokenDbHandle = new DatabaseSync(brokenDb);
  const brokenMigs = brokenDbHandle.prepare("SELECT version FROM control_migrations").all().map((r) => r.version);
  const brokenTables = brokenDbHandle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='broken'").all();
  check(
    "B9 broken migration fails and rolls back (only 0001 recorded, no partial table)",
    br.status === 1 && brokenMigs.length === 1 && brokenMigs[0] === "0001_initial" && brokenTables.length === 0
  );
  brokenDbHandle.close();
  db.close();

  // --- Require compiled control modules against the test DB -----------------
  process.env.CONTROL_DATABASE_URL = `file:${testDb}`;
  delete process.env.DATABASE_URL;
  const require = createRequire(import.meta.url);
  const repos = require(path.join(scratch, "control", "repositories.js"));
  const validators = require(path.join(scratch, "control", "validators.js"));
  const logging = require(path.join(scratch, "logging.js"));
  const controlDb = require(path.join(scratch, "control-db.js"));

  // ========================================================================
  console.log("\nC. Repositories");
  const org = await repos.createOrganization({ name: "Demo Academy Group", slug: "demo-academy-group" });
  check("C1 create organization", !!org.id && org.status === "pending" && org.slug === "demo-academy-group");
  const bySlug = await repos.getOrganizationBySlug("demo-academy-group");
  check("C1 get organization by slug", bySlug?.id === org.id);
  let dupSlug = false;
  try { await repos.createOrganization({ name: "Copy", slug: "demo-academy-group" }); } catch { dupSlug = true; }
  check("C1 duplicate slug rejected", dupSlug);
  await repos.setOrganizationStatus(org.id, "active");
  check("C1 status update to active", (await repos.getOrganization(org.id))?.status === "active");

  // C2: PACKAGE model.
  const pkgPlan = await repos.createPlan({
    name: "Standard Package", billingModel: "PACKAGE", currency: "PKR",
    monthlyPriceCents: 299900, studentCap: 200,
  });
  const pkgOrg = await repos.createOrganization({ name: "Package School", slug: "package-school" });
  await repos.createSubscription({
    orgId: pkgOrg.id, planId: pkgPlan.id, billingModel: "PACKAGE", currency: "PKR",
    monthlyPriceCents: 299900, studentCap: 200,
  });
  const pkgActive = await repos.getActiveSubscription(pkgOrg.id);
  check(
    "C2 PACKAGE plan + subscription stored unambiguously",
    pkgActive?.billingModel === "PACKAGE" && pkgActive.monthlyPriceCents === 299900 &&
      pkgActive.perStudentRateCents === null && pkgActive.studentCap === 200 && pkgActive.currency === "PKR"
  );

  // C3: PER_STUDENT_MONTHLY model.
  const perPlan = await repos.createPlan({
    name: "Per-Student", billingModel: "PER_STUDENT_MONTHLY", currency: "PKR", perStudentRateCents: 5000,
  });
  const perOrg = await repos.createOrganization({ name: "Per-Student School", slug: "per-student-school" });
  await repos.createSubscription({
    orgId: perOrg.id, planId: perPlan.id, billingModel: "PER_STUDENT_MONTHLY", currency: "PKR", perStudentRateCents: 5000,
  });
  const perActive = await repos.getActiveSubscription(perOrg.id);
  check(
    "C3 PER_STUDENT_MONTHLY plan + subscription stored unambiguously",
    perActive?.billingModel === "PER_STUDENT_MONTHLY" && perActive.perStudentRateCents === 5000 &&
      perActive.monthlyPriceCents === null && perActive.studentCap === null
  );
  const usage = await repos.getUsageSummary(perOrg.id, "2026-11");
  check("C3 usage summaries not populated in Phase 2", usage === undefined);
  check("C3 the two models coexist without ambiguity", pkgActive?.billingModel !== perActive?.billingModel);

  // C4: billing validation.
  let badBilling = 0;
  try { await repos.createPlan({ name: "Bad1", billingModel: "PACKAGE", currency: "PKR", perStudentRateCents: 100 }); } catch { badBilling++; }
  try { await repos.createPlan({ name: "Bad2", billingModel: "PER_STUDENT_MONTHLY", currency: "PKR", monthlyPriceCents: 100 }); } catch { badBilling++; }
  try { await repos.createPlan({ name: "Bad3", billingModel: "PACKAGE", currency: "PKR" }); } catch { badBilling++; }
  check("C4 mixed/missing billing terms rejected (3/3)", badBilling === 3);

  // C5: entitlements + capability validator.
  await repos.setPlanEntitlement(pkgPlan.id, "attendance.write", true);
  await repos.setPlanEntitlement(pkgPlan.id, "grades.read", true);
  await repos.setPlanEntitlement(pkgPlan.id, "grades.read", false);
  const ents = await repos.listPlanEntitlements(pkgPlan.id);
  check(
    "C5 entitlements stored, toggled, listed",
    ents.length === 2 && ents.find((e) => e.capability === "grades.read")?.enabled === 0 &&
      ents.find((e) => e.capability === "attendance.write")?.enabled === 1
  );
  let badCap = false;
  try { await repos.setPlanEntitlement(pkgPlan.id, "attendance.delete", true); } catch { badCap = true; }
  check("C5 unknown capability rejected by repository validator", badCap);

  // C6: secret references.
  const secret = await repos.createSecretReference({
    orgId: pkgOrg.id, provider: "vercel-env", keyPath: "NEXUSLMS_TENANT_TOKEN", purpose: "tenant DB auth token",
  });
  check("C6 valid vercel-env reference stored", !!secret.id && secret.keyPath === "NEXUSLMS_TENANT_TOKEN");
  await repos.createSecretReference({
    orgId: pkgOrg.id, provider: "aws-secrets-manager",
    keyPath: "arn:aws:secretsmanager:ap-south-1:123456789012:secret:nexuslms/tenant-AbCdEf",
  });
  await repos.createSecretReference({
    orgId: pkgOrg.id, provider: "doppler", keyPath: "nexuslms/prod/TENANT_TOKEN",
  });
  const secrets = await repos.listSecretReferences(pkgOrg.id);
  check("C6 aws + doppler references stored", secrets.length === 3);
  const rawTokens = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsRRk",
    "libsql://nexuslms-x.turso.io?authToken=eyJhbGciOiJIUzI1NiJ9.abc123",
    "FakeTestToken_xK9mQ2vR7tY4wN8pL3sD6fH1jK0mN5qR2sT", // long mixed-case blob, clearly fake
    "a".repeat(50) + "B".repeat(20),
  ];
  let refused = 0;
  for (const tok of rawTokens) {
    try { await repos.createSecretReference({ orgId: pkgOrg.id, provider: "vercel-env", keyPath: tok }); } catch { refused++; }
    try { await repos.createSecretReference({ orgId: pkgOrg.id, provider: "aws-secrets-manager", keyPath: tok }); } catch { refused++; }
    try { await repos.createSecretReference({ orgId: pkgOrg.id, provider: "doppler", keyPath: tok }); } catch { refused++; }
  }
  check("C6 raw tokens refused for every provider (12/12)", refused === 12, `refused ${refused}/12`);
  let badProvider = false;
  try { await repos.createSecretReference({ orgId: pkgOrg.id, provider: "plaintext", keyPath: "FOO" }); } catch { badProvider = true; }
  check("C6 unknown provider refused", badProvider);
  let badEnvName = false;
  try { await repos.createSecretReference({ orgId: pkgOrg.id, provider: "vercel-env", keyPath: "lowercase_name" }); } catch { badEnvName = true; }
  check("C6 lowercase env var name refused for vercel-env", badEnvName);

  // C7: tenant databases.
  const tenantDb = await repos.createTenantDatabase({
    orgId: pkgOrg.id, databaseUrl: "libsql://nexuslms-pkg.turso.io", secretReferenceId: secret.id,
  });
  const tenantDbs = await repos.listTenantDatabases(pkgOrg.id);
  check("C7 tenant database row stored with secret reference", tenantDbs.length === 1 && tenantDbs[0].secretReferenceId === secret.id);
  await repos.setTenantDatabaseStatus(tenantDb.id, "active");
  check("C7 tenant database status update", (await repos.getTenantDatabase(tenantDb.id))?.status === "active");

  // C8: platform admins + membership placeholder.
  const admin = await repos.createPlatformAdmin({ email: "ops@nexus-tech.example" });
  const admins = await repos.listPlatformAdmins();
  check("C8 platform admin stored", admins.length === 1 && admins[0].email === "ops@nexus-tech.example");
  await repos.addMembership({ orgId: pkgOrg.id, userId: "user_placeholder_001" });
  const byOrg = await repos.listMembershipsByOrg(pkgOrg.id);
  const byUser = await repos.listMembershipsByUser("user_placeholder_001");
  check("C8 membership placeholder: plain userId, no FK, listed both ways", byOrg.length === 1 && byUser.length === 1);
  await repos.removeMembership(pkgOrg.id, "user_placeholder_001");
  check("C8 membership removed", (await repos.listMembershipsByOrg(pkgOrg.id)).length === 0);

  // C9: support grants.
  const grant = await repos.createSupportAccessGrant({
    orgId: pkgOrg.id, operatorId: admin.id, expiresAt: new Date(Date.now() + 3600e3).toISOString(),
  });
  check("C9 support grant created (auditedAt null placeholder)", !!grant.id && grant.auditedAt === null);
  check("C9 support grant listed", (await repos.listSupportAccessGrants(pkgOrg.id)).length === 1);
  await repos.revokeSupportAccessGrant(grant.id);
  check("C9 support grant revoked", (await repos.listSupportAccessGrants(pkgOrg.id)).length === 0);

  // C10: job scaffolds.
  const pjob = await repos.createProvisioningJob({ orgId: pkgOrg.id, kind: "create_tenant_db", payload: { provider: "turso" } });
  await repos.updateProvisioningJobStatus(pjob.id, "succeeded");
  check("C10 provisioning job status flow", (await repos.getProvisioningJob(pjob.id))?.status === "succeeded");
  const mjob = await repos.createMigrationJob({ tenantDatabaseId: tenantDb.id, version: "0002_next" });
  await repos.updateMigrationJobStatus(mjob.id, "failed", "simulated");
  check("C10 migration job status flow", (await repos.getMigrationJob(mjob.id))?.status === "failed");

  // C11: audit log.
  await repos.writePlatformAudit({
    actorId: admin.id, actorType: "platform_admin", action: "organization.created",
    entity: "organizations", entityId: pkgOrg.id, orgId: pkgOrg.id, details: { slug: pkgOrg.slug },
  });
  const audit = await repos.listPlatformAuditLogs(pkgOrg.id, 10);
  check("C11 platform audit written + listed by org", audit.length === 1 && audit[0].action === "organization.created");

  // C13: transaction isolation (control).
  let rolledBack = false;
  try {
    await controlDb.controlTransaction(async (tx) => {
      await tx.run(
        "INSERT INTO organizations (id, name, slug, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?)",
        "tx-rollback-org", "Rollback Org", "rollback-org", "pending", new Date().toISOString(), new Date().toISOString()
      );
      await sleep(300);
      throw new Error("boom");
    });
  } catch { rolledBack = true; }
  const plainDuringTx = (async () => {
    await sleep(50);
    return controlDb.controlRun(
      "INSERT INTO organizations (id, name, slug, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?)",
      "tx-survivor-org", "Survivor Org", "survivor-org", "pending", new Date().toISOString(), new Date().toISOString()
    );
  })();
  // Re-run the rollback scenario with the plain write concurrent, to prove
  // the plain write survives the rollback.
  const tx2 = controlDb.controlTransaction(async (tx) => {
    await tx.run(
      "INSERT INTO organizations (id, name, slug, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?)",
      "tx-rollback-org-2", "Rollback Org 2", "rollback-org-2", "pending", new Date().toISOString(), new Date().toISOString()
    );
    await sleep(300);
    throw new Error("boom");
  }).catch(() => {});
  await Promise.all([plainDuringTx, tx2]);
  const gone = await repos.getOrganization("tx-rollback-org");
  const gone2 = await repos.getOrganization("tx-rollback-org-2");
  const survivor = await repos.getOrganization("tx-survivor-org");
  check("C13 rolled-back transaction leaves nothing behind", rolledBack && !gone && !gone2);
  check("C13 plain write during a rolling-back transaction survives", !!survivor);

  // ========================================================================
  console.log("\nD. Logging");
  const lines = [];
  const sink = (line) => lines.push(line);
  logging.logInfo("control.test.event", { safe: "ok" }, { correlationId: "corr-123", orgId: org.id }, sink);
  const parsed = JSON.parse(lines[0]);
  check(
    "D1 structured JSON with correlationId + orgId",
    parsed.level === "info" && parsed.message === "control.test.event" &&
      parsed.correlationId === "corr-123" && parsed.orgId === org.id && typeof parsed.ts === "string"
  );
  logging.logInfo("control.test.autoCorr", { safe: "ok" }, {}, sink);
  const autoCorr = JSON.parse(lines[1]).correlationId;
  check("D2 correlationId generated when not supplied", typeof autoCorr === "string" && autoCorr.length >= 32);
  lines.length = 0;
  logging.logError(
    "control.test.redact",
    {
      password: "hunter2",
      authToken: "tok_abc123",
      apiKey: "key_xyz",
      student: { name: "Ayesha", grade: "8" },
      studentPayload: [{ name: "Bilal" }],
      nested: { secretKey: "shh", deep: { token: "tok2" } },
      safe: "still-here",
    },
    { correlationId: "corr-125" },
    sink
  );
  const redacted = lines[0];
  const redactedParsed = JSON.parse(redacted);
  const noRaw =
    !redacted.includes("hunter2") && !redacted.includes("tok_abc123") && !redacted.includes("key_xyz") &&
    !redacted.includes("Ayesha") && !redacted.includes("Bilal") && !redacted.includes("shh") && !redacted.includes("tok2");
  check(
    "D3 secret + student fields redacted at every depth, safe fields kept",
    noRaw && redactedParsed.safe === "still-here" &&
      redactedParsed.password === "[REDACTED]" && redactedParsed.student === "[REDACTED]" &&
      redactedParsed.nested.secretKey === "[REDACTED]" && redactedParsed.nested.deep.token === "[REDACTED]"
  );

  // ========================================================================
  console.log("\nE. Capability vocabulary");
  const vocabText = fs.readFileSync(path.join(root, "docs", "capability-vocabulary.md"), "utf8");
  const docCaps = [...vocabText.matchAll(/`([a-z]+\.(?:manage|read|write|access))`/g)].map((m) => m[1]);
  const docSet = [...new Set(docCaps)].sort();
  const codeSet = [...validators.CAPABILITIES].sort();
  check(
    "E1 docs/capability-vocabulary.md agrees with the code list",
    JSON.stringify(docSet) === JSON.stringify(codeSet),
    `doc: ${docSet.join(",")} | code: ${codeSet.join(",")}`
  );
  const schemaText = fs.readFileSync(path.join(migrationsDir, "0001_initial.sql"), "utf8");
  check("E2 schema comments reference the vocabulary doc", schemaText.includes("capability-vocabulary.md"));

  // ========================================================================
  console.log("\nF. Tenant executor untouched");
  const tenantDbSrc = fs.readFileSync(path.join(root, "src", "lib", "db.ts"), "utf8");
  const controlDbSrc = fs.readFileSync(path.join(root, "src", "lib", "control-db.ts"), "utf8");
  check("F1 tenant executor has no control-plane code", !/control/i.test(tenantDbSrc));
  check(
    "F2 control-db never imports the tenant executor",
    !/import\s+[\s\S]*?from\s+["']\.\/db["']/.test(controlDbSrc) && !/require\(["']\.\/db["']\)/.test(controlDbSrc)
  );

  // --- Summary + cleanup ----------------------------------------------------
  console.log(`\nControl-plane suite: ${pass} passed, ${fail} failed.`);
  if (fail > 0) console.log("Failures:", failures.join(", "));
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Harness error:", e);
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
});
