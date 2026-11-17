/**
 * Control-plane database layer (Phase 2).
 *
 * A SEPARATE database from the tenant (school) database, with its own
 * connection, its own executor, and its own transaction handling. This
 * module deliberately shares NO state with src/lib/db.ts (the Phase 1
 * tenant executor): importing this file never touches the tenant DB, and
 * vice versa. The two databases are distinguished by environment:
 *
 *   Control: CONTROL_TURSO_DATABASE_URL / CONTROL_TURSO_AUTH_TOKEN
 *            (staging Turso) or CONTROL_DATABASE_URL (local file,
 *            default file:./control-dev.db)
 *   Tenant:  TURSO_DATABASE_URL / TURSO_AUTH_TOKEN or DATABASE_URL
 *            (default file:./dev.db)
 *
 * Guardrail: resolving the control target to the same database as the
 * tenant target is refused at module load (and again in the migration
 * runner, which is the first thing that touches a real Turso URL).
 *
 * Transactions follow the Phase 1 contract: transaction(fn) hands fn an
 * explicit tx Executor; queries inside MUST use that handle. Module-level
 * all/get/run always use the shared default executor and can never leak
 * into a transaction.
 */
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { createClient, type Client } from "@libsql/client";

const CONTROL_TURSO_URL = process.env.CONTROL_TURSO_DATABASE_URL;
const CONTROL_TURSO_TOKEN = process.env.CONTROL_TURSO_AUTH_TOKEN;
export const useControlTurso = !!CONTROL_TURSO_URL;

const TENANT_TURSO_URL = process.env.TURSO_DATABASE_URL;

function resolveFile(raw: string | undefined, fallback: string): string {
  const v = raw ?? fallback;
  const p = v.startsWith("file:") ? v.slice(5) : v;
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function controlFilePath(): string {
  return resolveFile(process.env.CONTROL_DATABASE_URL, "file:./control-dev.db");
}

function tenantFilePath(): string {
  return resolveFile(process.env.DATABASE_URL, "file:./dev.db");
}

// --- Guardrail (enforced at first use, before any connection opens) --------
function assertSeparateTargets(): void {
  if (CONTROL_TURSO_URL && TENANT_TURSO_URL && CONTROL_TURSO_URL === TENANT_TURSO_URL) {
    throw new Error(
      "[control-db] REFUSED: CONTROL_TURSO_DATABASE_URL is the tenant TURSO_DATABASE_URL. " +
        "The control plane must never share a database with tenant data."
    );
  }
  if (!CONTROL_TURSO_URL && !TENANT_TURSO_URL && controlFilePath() === tenantFilePath()) {
    throw new Error(
      "[control-db] REFUSED: CONTROL_DATABASE_URL resolves to the tenant database file. " +
        "The control plane must never share a database with tenant data."
    );
  }
}

// Local-driver lock handling: same lesson as the tenant executor (Phase 1).
// node:sqlite is synchronous, so a long busy_timeout would block the event
// loop and starve the transaction holding the lock. Small engine wait +
// a yielding retry loop instead.
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

function getLocal(): DatabaseSync {
  assertSeparateTargets();
  if (!localDb) {
    const dbPath = controlFilePath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    localDb = new DatabaseSync(dbPath);
    localDb.exec("PRAGMA journal_mode = WAL;");
    localDb.exec("PRAGMA foreign_keys = ON;");
    localDb.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  }
  return localDb;
}

function getRemote(): Client {
  assertSeparateTargets();
  if (!remoteClient) {
    remoteClient = createClient({ url: CONTROL_TURSO_URL!, authToken: CONTROL_TURSO_TOKEN });
  }
  return remoteClient;
}

/** Collision-resistant id (same shape as the tenant layer's uid()). */
export function controlUid(): string {
  return randomBytes(12).toString("hex");
}

export function controlNowIso(): string {
  return new Date().toISOString();
}

type Params = (string | number | null)[];

/**
 * A handle for running control-plane queries — either the shared default
 * connection or one transaction. Inside a transaction, use the `tx` handle
 * you are handed; outside, use the module-level all/get/run below.
 */
export interface ControlExecutor {
  all<T>(sql: string, ...params: Params): Promise<T[]>;
  get<T>(sql: string, ...params: Params): Promise<T | undefined>;
  run(sql: string, ...params: Params): Promise<{ changes: number }>;
}

const defaultExecutor: ControlExecutor = {
  async all<T>(sql: string, ...params: Params): Promise<T[]> {
    if (useControlTurso) {
      const rs = await getRemote().execute({ sql, args: params });
      return rs.rows as unknown as T[];
    }
    return withBusyRetry(() => getLocal().prepare(sql).all(...params) as T[]);
  },
  async get<T>(sql: string, ...params: Params): Promise<T | undefined> {
    if (useControlTurso) {
      const rs = await getRemote().execute({ sql, args: params });
      return rs.rows[0] as unknown as T | undefined;
    }
    return withBusyRetry(() => getLocal().prepare(sql).get(...params) as T | undefined);
  },
  async run(sql: string, ...params: Params): Promise<{ changes: number }> {
    if (useControlTurso) {
      const rs = await getRemote().execute({ sql, args: params });
      return { changes: Number(rs.rowsAffected) };
    }
    const info = await withBusyRetry(() => getLocal().prepare(sql).run(...params));
    return { changes: Number(info.changes) };
  },
};

/** Plain (non-transactional) control-plane queries. */
export function controlAll<T>(sql: string, ...params: Params): Promise<T[]> {
  return defaultExecutor.all<T>(sql, ...params);
}

export function controlGet<T>(sql: string, ...params: Params): Promise<T | undefined> {
  return defaultExecutor.get<T>(sql, ...params);
}

export function controlRun(sql: string, ...params: Params): Promise<{ changes: number }> {
  return defaultExecutor.run(sql, ...params);
}

export function isControlUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object" || !("code" in e)) return false;
  const code = String((e as { code: unknown }).code);
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code.includes("SQLITE_CONSTRAINT_UNIQUE");
}

/**
 * Run fn inside a control-plane transaction. fn receives the transaction's
 * own Executor — every query inside MUST use that handle. Queries made
 * through the module-level controlAll/controlGet/controlRun while a
 * transaction is open run OUTSIDE it, on the shared connection.
 */
export async function controlTransaction<T>(fn: (tx: ControlExecutor) => Promise<T>): Promise<T> {
  if (useControlTurso) {
    const client = getRemote();
    const tx = await client.transaction();
    const txExecutor: ControlExecutor = {
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
  // with) this transaction.
  const db = new DatabaseSync(controlFilePath());
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  const txExecutor: ControlExecutor = {
    all: async <T>(sql: string, ...params: Params) => db.prepare(sql).all(...params) as T[],
    get: async <T>(sql: string, ...params: Params) => db.prepare(sql).get(...params) as T | undefined,
    run: async (sql: string, ...params: Params) => {
      const info = db.prepare(sql).run(...params);
      return { changes: Number(info.changes) };
    },
  };
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
