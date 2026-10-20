import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

// Zero-dependency SQLite via Node 24's built-in node:sqlite.
// DATABASE_URL="file:./dev.db" (relative paths resolve from the project root).
function resolveDbPath(): string {
  const raw = process.env.DATABASE_URL ?? "file:./dev.db";
  const p = raw.startsWith("file:") ? raw.slice(5) : raw;
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

const dbPath = resolveDbPath();
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const sqlite = new DatabaseSync(dbPath);
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

/** Collision-resistant id (replaces Prisma's cuid()). */
export function uid(): string {
  return randomBytes(12).toString("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

type Params = (string | number | null)[];

export function all<T>(sql: string, ...params: Params): T[] {
  return sqlite.prepare(sql).all(...params) as T[];
}

export function get<T>(sql: string, ...params: Params): T | undefined {
  return sqlite.prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: Params): { changes: number } {
  const info = sqlite.prepare(sql).run(...params);
  return { changes: Number(info.changes) };
}

export function isUniqueViolation(e: unknown): boolean {
  return (
    !!e &&
    typeof e === "object" &&
    "code" in e &&
    (e as { code: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/** Run fn inside a transaction (BEGIN IMMEDIATE … COMMIT/ROLLBACK). */
export function transaction<T>(fn: () => T): T {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    sqlite.exec("COMMIT");
    return result;
  } catch (e) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw e;
  }
}
