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

let localDb: DatabaseSync | null = null;
let remoteClient: Client | null = null;

function getLocal(): DatabaseSync {
  if (!localDb) {
    const raw = process.env.DATABASE_URL ?? "file:./dev.db";
    const p = raw.startsWith("file:") ? raw.slice(5) : raw;
    const dbPath = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    localDb = new DatabaseSync(dbPath);
    localDb.exec("PRAGMA journal_mode = WAL;");
    localDb.exec("PRAGMA foreign_keys = ON;");
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
          getLocal().prepare(sql).run();
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

interface Executor {
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
    return getLocal().prepare(sql).all(...params) as T[];
  },
  async get<T>(sql: string, ...params: Params): Promise<T | undefined> {
    await ensureMigrations();
    if (useTurso) {
      const rs = await getRemote().execute({ sql, args: params });
      return rs.rows[0] as unknown as T | undefined;
    }
    return getLocal().prepare(sql).get(...params) as T | undefined;
  },
  async run(sql: string, ...params: Params): Promise<{ changes: number }> {
    await ensureMigrations();
    if (useTurso) {
      const rs = await getRemote().execute({ sql, args: params });
      return { changes: Number(rs.rowsAffected) };
    }
    const info = getLocal().prepare(sql).run(...params);
    return { changes: Number(info.changes) };
  },
};

let current: Executor = defaultExecutor;

export function all<T>(sql: string, ...params: Params): Promise<T[]> {
  return current.all<T>(sql, ...params);
}

export function get<T>(sql: string, ...params: Params): Promise<T | undefined> {
  return current.get<T>(sql, ...params);
}

export function run(sql: string, ...params: Params): Promise<{ changes: number }> {
  return current.run(sql, ...params);
}

export function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object" || !("code" in e)) return false;
  const code = String((e as { code: unknown }).code);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code.includes("SQLITE_CONSTRAINT_UNIQUE");
}

/** Run fn inside a transaction (works on both drivers). */
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  await ensureMigrations();
  if (useTurso) {
    const client = getRemote();
    const tx = await client.transaction();
    const prev = current;
    current = {
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
      const result = await fn();
      await tx.commit();
      return result;
    } catch (e) {
      await tx.rollback();
      throw e;
    } finally {
      current = prev;
    }
  }
  const db = getLocal();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw e;
  }
}
