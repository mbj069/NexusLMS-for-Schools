// Applies db/schema.sql idempotently. Run: node db/migrate.mjs  (or: npm run db:migrate)
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const raw = process.env.DATABASE_URL ?? "file:./dev.db";
const p = raw.startsWith("file:") ? raw.slice(5) : raw;
const dbPath = path.isAbsolute(p) ? p : path.resolve(root, p);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const sql = fs.readFileSync(path.join(here, "schema.sql"), "utf8");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = OFF;");
db.exec(sql);
db.exec("PRAGMA foreign_keys = ON;");
db.close();
console.log(`Schema applied to ${dbPath}`);
