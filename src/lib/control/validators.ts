/**
 * Control-plane validators (Phase 2).
 *
 * Pure functions, no database access. Two jobs:
 *
 * 1. Capability vocabulary — the single code list of capability names.
 *    Must match docs/capability-vocabulary.md exactly; the Phase 2 test
 *    suite asserts the two agree (change them together).
 * 2. Secret references — per-provider key_path patterns (D-7), plus a
 *    token-shape guard that refuses anything that looks like a raw token.
 *    The control DB stores references, never raw tokens.
 */

/** The capability vocabulary. Mirror of docs/capability-vocabulary.md. */
export const CAPABILITIES = [
  "organization.manage",
  "school.manage",
  "users.manage",
  "attendance.read",
  "attendance.write",
  "grades.read",
  "grades.write",
  "assignments.manage",
  "announcements.manage",
  "support.access",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isValidCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

export function assertValidCapability(value: string): asserts value is Capability {
  if (!isValidCapability(value)) {
    throw new Error(
      `[control] unknown capability "${value}". Capabilities must come from docs/capability-vocabulary.md.`
    );
  }
}

// --- Billing shape (D-4) -----------------------------------------------------
export type BillingModel = "PACKAGE" | "PER_STUDENT_MONTHLY";

export interface BillingTerms {
  billingModel: BillingModel;
  currency: string;
  monthlyPriceCents?: number | null;
  perStudentRateCents?: number | null;
  studentCap?: number | null;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

export function assertBillingTerms(terms: BillingTerms): void {
  if (terms.billingModel !== "PACKAGE" && terms.billingModel !== "PER_STUDENT_MONTHLY") {
    throw new Error(`[control] billingModel must be PACKAGE or PER_STUDENT_MONTHLY, got "${terms.billingModel}".`);
  }
  if (typeof terms.currency !== "string" || terms.currency.trim().length === 0) {
    throw new Error("[control] currency is required (e.g. PKR, USD).");
  }
  if (terms.billingModel === "PACKAGE") {
    if (!isNonNegativeInt(terms.monthlyPriceCents)) {
      throw new Error("[control] a PACKAGE plan/subscription requires monthlyPriceCents (minor units, integer >= 0).");
    }
    if (terms.perStudentRateCents !== null && terms.perStudentRateCents !== undefined) {
      throw new Error("[control] a PACKAGE plan/subscription must not carry perStudentRateCents.");
    }
  } else {
    if (!isNonNegativeInt(terms.perStudentRateCents)) {
      throw new Error("[control] a PER_STUDENT_MONTHLY plan/subscription requires perStudentRateCents (minor units, integer >= 0).");
    }
    if (terms.monthlyPriceCents !== null && terms.monthlyPriceCents !== undefined) {
      throw new Error("[control] a PER_STUDENT_MONTHLY plan/subscription must not carry monthlyPriceCents.");
    }
  }
  if (
    terms.studentCap !== null &&
    terms.studentCap !== undefined &&
    (!Number.isInteger(terms.studentCap) || terms.studentCap <= 0)
  ) {
    throw new Error("[control] studentCap, when set, must be a positive integer.");
  }
}

// --- Secret references (D-7) -------------------------------------------------
export type SecretProvider = "vercel-env" | "aws-secrets-manager" | "doppler";

export const SECRET_PROVIDERS: readonly SecretProvider[] = [
  "vercel-env",
  "aws-secrets-manager",
  "doppler",
] as const;

const PATTERNS: Record<SecretProvider, RegExp> = {
  // An environment variable name: uppercase letters, digits, underscores.
  "vercel-env": /^[A-Z][A-Z0-9_]{0,63}$/,
  // An AWS Secrets Manager ARN, or a secret name/path. (A bare name must
  // still pass the token-shape guard below.)
  "aws-secrets-manager":
    /^(arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+|[A-Za-z0-9/_+=.@-]{1,256})$/,
  // A Doppler reference: project/config/secret-name.
  doppler: /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/,
};

/**
 * Token-shape guard (defence in depth, applied to every provider). A
 * key_path is a POINTER to a secret, so anything shaped like the secret
 * itself is refused: URLs, JWTs, very long values, and long separator-
 * free blobs (the shape of a pasted API token). This is the rule the
 * "raw token is refused" test asserts.
 *
 * The blob rule is provider-aware: vercel-env names are uppercase
 * [A-Z0-9_] by pattern, so a long uppercase blob there is plausibly a
 * real env var name and is left to the pattern. For the other providers,
 * a >40-char value made only of letters, digits, and underscores is
 * token-shaped — real secret names and paths use `-`, `/`, `.`, or `@`
 * as separators, and the ARN form is always available for AWS.
 */
export function looksLikeRawToken(keyPath: string, provider?: string): boolean {
  if (keyPath.length === 0) return true;
  if (keyPath.length > 128) return true;
  if (/\s/.test(keyPath)) return true;
  if (keyPath.includes("://")) return true;
  if (/^eyJ[A-Za-z0-9_-]+\./.test(keyPath)) return true; // JWT header
  if (!/[-_/.@]/.test(keyPath) && keyPath.length > 40) return true; // blob
  if (provider !== "vercel-env" && keyPath.length > 40 && /^[A-Za-z0-9_]+$/.test(keyPath)) return true;
  return false;
}

export function assertValidSecretReference(provider: string, keyPath: string): asserts provider is SecretProvider {
  if (!(SECRET_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `[control] secret provider must be one of ${SECRET_PROVIDERS.join(", ")}, got "${provider}".`
    );
  }
  if (looksLikeRawToken(keyPath, provider)) {
    throw new Error(
      "[control] key_path looks like a raw token, not a reference. The control DB stores references only " +
        "(an env var name, an ARN, or a secret path) — never the secret value itself."
    );
  }
  const pattern = PATTERNS[provider as SecretProvider];
  if (!pattern.test(keyPath)) {
    throw new Error(
      `[control] key_path "${keyPath}" does not match the ${provider} reference format. ` +
        "vercel-env: ENV_VAR_NAME; aws-secrets-manager: secret ARN or name; doppler: project/config/name."
    );
  }
}

// --- Slugs -------------------------------------------------------------------
export function assertValidSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    throw new Error(`[control] slug "${slug}" must be lowercase letters, digits, and hyphens.`);
  }
}
