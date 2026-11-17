/**
 * Control-plane versioned migration runner (Phase 2).
 *
 * Applies db/control/migrations/*.sql in filename order to the CONTROL
 * database — a separate database from the tenant (school) database.
 *
 * Usage:
 *   node db/control/migrate.mjs
 *   CONTROL_DATABASE_URL=file:./control-dev.db node db/control/migrate.mjs
 *   CONTROL_TURSO_DATABASE_URL=... CONTROL_TURSO_AUTH_TOKEN=... node db/control/migrate.mjs
 *
 * Environment:
 *   CONTROL_TURSO_DATABASE_URL / CONTROL_TURSO_AUTH_TOKEN — staging Turso
 *     control DB (Phase 2 staging; production is Phase 12, owner approval).
 *   CONTROL_DATABASE_URL — local SQLite file (default file:./control-dev.db).
 *   CONTROL_MIGRATIONS_DIR — override the migrations directory (tests).
 *
 * Guarantees:
 *   - Versioned + checksummed: every applied migration is recorded in
 *     control_migrations with its SHA-256. Re-running is a no-op. If a
 *     recorded checksum no longer matches its file, the runner fails loudly
 *     instead of applying anything — an applied migration is immutable.
 *   - Each migration applies inside one transaction (commit or rollback).
 *   - GUARDRAIL (D-14 / Phase 2 addendum 6): the control database must
 *     never be the tenant database. The runner resolves both targets and
 *     REFUSES to start if they are equal — before opening any connection.
 *     This is checked first, so the first Turso URL the runner ever sees
 *     is already guarded.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

function resolveFileUrl(raw, fallback) {
  const v = raw ?? fallback;
  const p = v.startsWith("file:") ? v.slice(5) : v;
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

// --- Guardrail: control target must differ from the tenant target ---------
function controlTarget() {
  if (process.env.CONTROL_TURSO_DATABASE_URL) {
    return { kind: "turso", key: process.env.CONTROL_TURSO_DATABASE_URL };
  }
  return { kind: "local", key: resolveFileUrl(process.env.CONTROL_DATABASE_URL, "file:./control-dev.db") };
}

function tenantTarget() {
  if (process.env.TURSO_DATABASE_URL) {
    return { kind: "turso", key: process.env.TURSO_DATABASE_URL };
  }
  return { kind: "local", key: resolveFileUrl(process.env.DATABASE_URL, "file:./dev.db") };
}

const control = controlTarget();
const tenant = tenantTarget();
if (control.kind === tenant.kind && control.key === tenant.key) {
  console.error(
    "[control-migrate] REFUSED: the control database target is the tenant database target " +
      `(${control.kind === "turso" ? control.key : control.key}). ` +
      "The control plane must never share a database with tenant data. " +
      "Set CONTROL_DATABASE_URL / CONTROL_TURSO_DATABASE_URL to a different database."
  );
  process.exit(1);
}

// --- Driver -----------------------------------------------------------------
let run, all, close;
let beginTx, commitTx, rollbackTx;
if (control.kind === "turso") {
  const { createClient } = await import("@libsql/client");
  const client = createClient({
    url: process.env.CONTROL_TURSO_DATABASE_URL,
    authToken: process.env.CONTROL_TURSO_AUTH_TOKEN,
  });
  let tx = null;
  run = async (sql, ...params) => {
    const rs = tx ? await tx.execute({ sql, args: params }) : await client.execute({ sql, args: params });
    return { changes: Number(rs.rowsAffected) };
  };
  all = async (sql, ...params) => {
    const rs = tx ? await tx.execute({ sql, args: params }) : await client.execute({ sql, args: params });
    return rs.rows;
  };
  beginTx = async () => { tx = await client.transaction(); };
  commitTx = async () => { await tx.commit(); tx = null; };
  rollbackTx = async () => { try { await tx.rollback(); } catch { /* already rolled back */ } tx = null; };
  close = async () => client.close();
  console.log(`[control-migrate] target: Turso ${process.env.CONTROL_TURSO_DATABASE_URL}`);
} else {
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(path.dirname(control.key), { recursive: true });
  const db = new DatabaseSync(control.key);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  run = async (sql, ...params) => db.prepare(sql).run(...params);
  all = async (sql, ...params) => db.prepare(sql).all(...params);
  beginTx = async () => db.exec("BEGIN IMMEDIATE");
  commitTx = async () => db.exec("COMMIT");
  rollbackTx = async () => { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } };
  close = () => db.close();
  console.log(`[control-migrate] target: ${control.key}`);
}

// --- Migrations ---------------------------------------------------------------
const migrationsDir = process.env.CONTROL_MIGRATIONS_DIR
  ? path.resolve(process.env.CONTROL_MIGRATIONS_DIR)
  : path.join(root, "db", "control", "migrations");
if (!fs.existsSync(migrationsDir)) {
  console.error(`[control-migrate] migrations directory not found: ${migrationsDir}`);
  await close();
  process.exit(1);
}
const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
if (files.length === 0) {
  console.log("[control-migrate] no migrations found; nothing to do.");
  await close();
  process.exit(0);
}

function splitStatements(sql) {
  const withoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutComments
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.endsWith(";") ? s : `${s};`));
}

const checksum = (text) => createHash("sha256").update(text, "utf8").digest("hex");

await run(
  "CREATE TABLE IF NOT EXISTS control_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, appliedAt TEXT NOT NULL)"
);
const appliedRows = await all("SELECT version, checksum FROM control_migrations");
const applied = new Map(appliedRows.map((r) => [r.version, r.checksum]));

let appliedCount = 0;
for (const file of files) {
  const version = file.replace(/\.sql$/, "");
  const text = fs.readFileSync(path.join(migrationsDir, file), "utf8");
  const sum = checksum(text);
  if (applied.has(version)) {
    if (applied.get(version) !== sum) {
      console.error(
        `[control-migrate] CHECKSUM MISMATCH for applied migration ${version}: the file changed after it was applied. ` +
          "Applied migrations are immutable — add a new migration instead. Refusing to continue."
      );
      await close();
      process.exit(1);
    }
    console.log(`[control-migrate] ${version}: already applied, skipping.`);
    continue;
  }
  const statements = splitStatements(text);
  console.log(`[control-migrate] ${version}: applying ${statements.length} statements...`);
  try {
    await beginTx();
    for (const stmt of statements) await run(stmt);
    await run("INSERT INTO control_migrations (version, checksum, appliedAt) VALUES (?,?,?)", version, sum, new Date().toISOString());
    await commitTx();
    appliedCount++;
    console.log(`[control-migrate] ${version}: applied.`);
  } catch (e) {
    await rollbackTx();
    console.error(`[control-migrate] ${version}: FAILED, rolled back:`, e instanceof Error ? e.message : String(e));
    await close();
    process.exit(1);
  }
}

console.log(`[control-migrate] done. ${appliedCount} migration(s) applied, ${files.length - appliedCount} already applied.`);
await close();
process.exit(0);
