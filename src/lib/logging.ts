/**
 * Structured logging foundation (Phase 2).
 *
 * Every log line is one JSON object on a single line, so logs can be
 * collected, searched, and correlated without parsing prose.
 *
 * Context is EXPLICIT, never ambient: callers pass a { correlationId,
 * orgId } object. There is no AsyncLocalStorage / request-context magic
 * in Phase 2 (that is Phase 4 or 11 work, per the approved addenda).
 * If no correlationId is supplied, one is generated per call.
 *
 * Redaction is a denylist, applied recursively to every field value:
 * any key whose name contains one of the denied fragments (case-
 * insensitive) is replaced with "[REDACTED]" — including nested objects
 * and arrays. The denylist covers secrets, tokens, passwords, and
 * student payloads: they must NEVER reach a log line.
 *
 * Usage:
 *   logInfo("control.migration.applied", { version }, { correlationId });
 *   logError("control.repository.failed", { error: err.message }, { orgId });
 *   const sink = (line: string) => lines.push(line); // tests
 *   logInfo("x", {}, undefined, sink);
 */
import { randomUUID } from "node:crypto";

export type LogLevel = "info" | "warn" | "error";

export interface LogContext {
  correlationId?: string;
  orgId?: string;
}

type Sink = (line: string) => void;

const defaultSink: Sink = (line) => console.log(line);

/** Key-name fragments that are never logged, matched case-insensitively. */
export const REDACTED_KEY_FRAGMENTS = [
  "password",
  "passwd",
  "token",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "privatekey",
  "clientsecret",
  "accesskey",
  "ssn",
  // Student payloads are never logged (Architecture §: no student data
  // in the control plane, and no student payload in any log line).
  "student",
] as const;

function isDeniedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACTED_KEY_FRAGMENTS.some((frag) => lower.includes(frag));
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isDeniedKey(k) ? "[REDACTED]" : sanitize(v);
    }
    return out;
  }
  return value;
}

export function newCorrelationId(): string {
  return randomUUID();
}

export function log(
  level: LogLevel,
  message: string,
  fields: Record<string, unknown> = {},
  context: LogContext = {},
  sink: Sink = defaultSink
): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    message,
    correlationId: context.correlationId ?? newCorrelationId(),
    ...(context.orgId ? { orgId: context.orgId } : {}),
    ...(sanitize(fields) as Record<string, unknown>),
  };
  sink(JSON.stringify(entry));
}

export function logInfo(
  message: string,
  fields: Record<string, unknown> = {},
  context: LogContext = {},
  sink?: Sink
): void {
  log("info", message, fields, context, sink);
}

export function logWarn(
  message: string,
  fields: Record<string, unknown> = {},
  context: LogContext = {},
  sink?: Sink
): void {
  log("warn", message, fields, context, sink);
}

export function logError(
  message: string,
  fields: Record<string, unknown> = {},
  context: LogContext = {},
  sink?: Sink
): void {
  log("error", message, fields, context, sink);
}
