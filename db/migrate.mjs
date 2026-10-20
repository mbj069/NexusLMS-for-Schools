// Applies db/schema.sql idempotently.
// Local:  node db/migrate.mjs            (uses DATABASE_URL, default file:./dev.db)
// Turso:   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node db/migrate.mjs
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = fs.readFileSync(path.join(here, "schema.sql"), "utf8");

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (TURSO_URL) {
  const { createClient } = await import("@libsql/client");
  const client = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
  await client.executeMultiple(sql);
  console.log(`Schema applied to Turso database ${TURSO_URL}`);
} else {
  const root = path.resolve(here, "..");
  const raw = process.env.DATABASE_URL ?? "file:./dev.db";
  const p = raw.startsWith("file:") ? raw.slice(5) : raw;
  const dbPath = path.isAbsolute(p) ? p : path.resolve(root, p);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(sql);
  db.exec("PRAGMA foreign_keys = ON;");
  db.close();
  console.log(`Schema applied to ${dbPath}`);
}
