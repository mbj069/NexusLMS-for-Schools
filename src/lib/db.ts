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
    if (useTurso) {
      const rs = await getRemote().execute({ sql, args: params });
      return rs.rows as unknown as T[];
    }
    return getLocal().prepare(sql).all(...params) as T[];
  },
  async get<T>(sql: string, ...params: Params): Promise<T | undefined> {
    if (useTurso) {
      const rs = await getRemote().execute({ sql, args: params });
      return rs.rows[0] as unknown as T | undefined;
    }
    return getLocal().prepare(sql).get(...params) as T | undefined;
  },
  async run(sql: string, ...params: Params): Promise<{ changes: number }> {
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
