import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { createClient, type Client } from "@libsql/client";

// Database layer: node:sqlite for local dev, Turso (hosted SQLite) in production.
// Set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) to use Turso — e.g. on Vercel,
// where the local filesystem is ephemeral and a SQLite file would not persist.
// The SQL is identical for both; only the driver differs.

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
export const useTurso = !!TURSO_URL;

// Local-driver lock handling (Phase 1): a transaction runs on its own
// connection, so a plain query on the shared connection can hit SQLITE_BUSY
// while the transaction holds the write lock. node:sqlite is synchronous —
// a long PRAGMA busy_timeout would block the event loop, starving the very
// transaction that must commit to release the lock. So the engine waits only
// 100ms per attempt and the retry loop below yields (await sleep) between
// attempts, letting the lock-holder run. ~5s of retries total.
const BUSY_TIMEOUT_MS = 100;
const BUSY_RETRIES = 100;

async function withBusyRetry<T>(fn: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = String((e as { code?: unknown })?.code ?? "");
      const busy = /database is locked/i.test(msg) || /SQLITE_BUSY/.test(code);
      if (!busy || attempt >= BUSY_RETRIES) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

let localDb: DatabaseSync | null = null;
let remoteClient: Client | null = null;

function dbFilePath(): string {
  const raw = process.env.DATABASE_URL ?? "file:./dev.db";
  const p = raw.startsWith("file:") ? raw.slice(5) : raw;
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function getLocal(): DatabaseSync {
  if (!localDb) {
    const dbPath = dbFilePath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    localDb = new DatabaseSync(dbPath);
    localDb.exec("PRAGMA journal_mode = WAL;");
    localDb.exec("PRAGMA foreign_keys = ON;");
    // Small on-engine wait only (see withBusyRetry): node:sqlite is
    // synchronous, so a long busy_timeout would block the event loop and the
    // transaction holding the lock could never commit. The retry loop below
    // yields between attempts instead.
    localDb.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  }
  return localDb;
}

function getRemote(): Client {
  if (!remoteClient) {
    remoteClient = createClient({ url: TURSO_URL!, authToken: TURSO_TOKEN });
  }
  return remoteClient;
}

// --- Auto-migrations (Phase 2.6 hardening) ---------------------------------
// Why this exists: a sellable multi-tenant product cannot require manual DB
// surgery on every deploy. Fresh DBs get the full schema from db/schema.sql;
// existing DBs (local dev.db, live Turso) get the new columns/backfills here,
// on first use, before any query that needs them runs. Statements are
// idempotent: "duplicate column" errors are swallowed, anything else retries
// on the next query (the flag is only set on success).
const MIGRATION_SQL: string[] = [
  "ALTER TABLE users ADD COLUMN tokenVersion INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN isActive INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE users ADD COLUMN deletedAt TEXT",
  "ALTER TABLE audit_logs ADD COLUMN details TEXT",
  "ALTER TABLE submissions ADD COLUMN schoolId TEXT REFERENCES schools(id) ON DELETE CASCADE",
  "ALTER TABLE questions ADD COLUMN schoolId TEXT REFERENCES schools(id) ON DELETE CASCADE",
  "ALTER TABLE quiz_attempts ADD COLUMN schoolId TEXT REFERENCES schools(id) ON DELETE CASCADE",
  "ALTER TABLE grades ADD COLUMN deletedAt TEXT",
  // Backfill denormalised schoolId from the parent row (existing rows only).
  "UPDATE submissions SET schoolId = (SELECT schoolId FROM assignments WHERE assignments.id = submissions.assignmentId) WHERE schoolId IS NULL",
  "UPDATE questions SET schoolId = (SELECT schoolId FROM quizzes WHERE quizzes.id = questions.quizId) WHERE schoolId IS NULL",
  "UPDATE quiz_attempts SET schoolId = (SELECT schoolId FROM quizzes WHERE quizzes.id = quiz_attempts.quizId) WHERE schoolId IS NULL",
  "CREATE INDEX IF NOT EXISTS idx_sub_school ON submissions(schoolId)",
  "CREATE INDEX IF NOT EXISTS idx_questions_school ON questions(schoolId)",
  "CREATE INDEX IF NOT EXISTS idx_attempts_school ON quiz_attempts(schoolId)",
];

let migrationPromise: Promise<void> | null = null;

async function ensureMigrations(): Promise<void> {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    // Fresh, never-migrated DB (e.g. /setup on an empty Turso DB): there is
    // no users table yet, so there is nothing to migrate. Bail out without
    // marking migrations done — the next query, after schema creation,
    // will retry and the ALTERs will then be harmless duplicates.
    try {
      const exists = useTurso
        ? (await getRemote().execute({ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'", args: [] })).rows.length > 0
        : !!getLocal().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
      if (!exists) {
        migrationPromise = null;
        return;
      }
    } catch {
      migrationPromise = null;
      return;
    }
    for (const sql of MIGRATION_SQL) {
      try {
        if (useTurso) {
          await getRemote().execute({ sql, args: [] });
        } else {
          await withBusyRetry(() => getLocal().prepare(sql).run());
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = (e as { code?: unknown })?.code;
        // Column already there (fresh DB, or a previous instance migrated it).
        if (/duplicate column/i.test(msg) || /already exists/i.test(msg)) continue;
        if (typeof code === "string" && /DUPLICATE/i.test(code)) continue;
        // Anything else: log, drop the flag so the next query retries, rethrow
        // only as a soft failure — the caller query will surface the real error.
        migrationPromise = null;
        console.error("[db] migration failed, will retry on next query:", sql, msg);
        throw e;
      }
    }
  })();
  return migrationPromise;
}

/** Collision-resistant id. */
export function uid(): string {
  return randomBytes(12).toString("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

type Params = (string | number | null)[];

/**
 * A handle for running queries — either the shared default connection or one
 * transaction. Phase 1: this is the ONLY way to touch the database. There is
 * no module-level mutable executor any more (the old `let current` was
 * swapped by transaction(), so while one request's transaction awaited a
 * Turso round-trip, any concurrent request's queries ran inside that
 * transaction — foreign writes committed/rolled back together, silent data
 * loss on rollback). Callers inside a transaction use the `tx` handle they
 * are handed; everyone else uses the module-level all/get/run below.
 */
export interface Executor {
  all<T>(sql: string, ...params: Params): Promise<T[]>;
  get<T>(sql: string, ...params: Params): Promise<T | undefined>;
  run(sql: string, ...params: Params): Promise<{ changes: number }>;
}

const defaultExecutor: Executor = {
  async all<T>(sql: string, ...params: Params): Promise<T[]> {
    await ensureMigrations();
    if (useTurso) {
      const rs = await getRemote().execute({ sql, args: params });
      return rs.rows as unknown as T[];
    }
    return withBusyRetry(() => getLocal().prepare(sql).all(...params) as T[]);
  },
  async get<T>(sql: string, ...params: Params): Promise<T | undefined> {
    await ensureMigrations();
    if (useTurso) {
      const rs = await getRemote().execute({ sql, args: params });
      return rs.rows[0] as unknown as T | undefined;
    }
    return withBusyRetry(() => getLocal().prepare(sql).get(...params) as T | undefined);
  },
  async run(sql: string, ...params: Params): Promise<{ changes: number }> {
    await ensureMigrations();
    if (useTurso) {
      const rs = await getRemote().execute({ sql, args: params });
      return { changes: Number(rs.rowsAffected) };
    }
    const info = await withBusyRetry(() => getLocal().prepare(sql).run(...params));
    return { changes: Number(info.changes) };
  },
};

/** Plain (non-transactional) queries — always the shared default executor. */
export function all<T>(sql: string, ...params: Params): Promise<T[]> {
  return defaultExecutor.all<T>(sql, ...params);
}

export function get<T>(sql: string, ...params: Params): Promise<T | undefined> {
  return defaultExecutor.get<T>(sql, ...params);
}

export function run(sql: string, ...params: Params): Promise<{ changes: number }> {
  return defaultExecutor.run(sql, ...params);
}

export function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object" || !("code" in e)) return false;
  const code = String((e as { code: unknown }).code);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code.includes("SQLITE_CONSTRAINT_UNIQUE");
}

/**
 * Run fn inside a transaction (works on both drivers). fn receives the
 * transaction's own Executor — every query inside the transaction MUST use
 * that handle (tx.all/tx.get/tx.run). Queries made through the module-level
 * all/get/run while a transaction is open run OUTSIDE it, on the shared
 * connection: they can never be pulled into, or rolled back with, the
 * transaction. That is the whole point of Phase 1.
 */
export async function transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
  await ensureMigrations();
  if (useTurso) {
    const client = getRemote();
    const tx = await client.transaction();
    const txExecutor: Executor = {
      all: async <T>(sql: string, ...params: Params) =>
        (await tx.execute({ sql, args: params })).rows as unknown as T[],
      get: async <T>(sql: string, ...params: Params) =>
        (await tx.execute({ sql, args: params })).rows[0] as unknown as T | undefined,
      run: async (sql: string, ...params: Params) => {
        const rs = await tx.execute({ sql, args: params });
        return { changes: Number(rs.rowsAffected) };
      },
    };
    try {
      const result = await fn(txExecutor);
      await tx.commit();
      return result;
    } catch (e) {
      await tx.rollback();
      throw e;
    }
  }
  // Local: the transaction gets its OWN connection to the same file, so a
  // plain query on the shared connection can never join (or be rolled back
  // with) this transaction. A concurrent plain write waits on busy_timeout
  // instead of failing — see getLocal(). The old code ran BEGIN on the shared
  // connection, where any concurrent plain query silently became part of the
  // transaction for the same reason the Turso path leaked.
  const db = new DatabaseSync(dbFilePath());
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  const txExecutor: Executor = {
    all: async <T>(sql: string, ...params: Params) => db.prepare(sql).all(...params) as T[],
    get: async <T>(sql: string, ...params: Params) => db.prepare(sql).get(...params) as T | undefined,
    run: async (sql: string, ...params: Params) => {
      const info = db.prepare(sql).run(...params);
      return { changes: Number(info.changes) };
    },
  };
  // Another transaction may hold the write lock — retry (yielding) instead of
  // failing, so parallel transactions serialise instead of erroring.
  await withBusyRetry(() => db.exec("BEGIN IMMEDIATE"));
  try {
    const result = await fn(txExecutor);
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw e;
  } finally {
    db.close();
  }
}
