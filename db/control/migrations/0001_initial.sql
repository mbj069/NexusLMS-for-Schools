-- NexusLMS control-plane schema — versioned migration 0001 (Phase 2).
--
-- This is the SINGLE source of truth for the control-plane schema. It is
-- applied by db/control/migrate.mjs, which records each migration's SHA-256
-- checksum in control_migrations and refuses to re-apply or silently change
-- an applied migration. Never edit this file after it has been applied to
-- any database; later changes go in a new migration file (0002_..., ...).
--
-- Control-plane rules (locked decisions D-1–D-14):
--   * The control DB holds ORGANISATIONS, TENANT DATABASES, IDENTITIES,
--     MEMBERSHIPS, PLANS / SUBSCRIPTIONS, USAGE SUMMARIES, SECRET
--     REFERENCES, JOBS, and AUDIT — never academic or student data, never
--     raw secrets, never locale/language fields, and (D-14) no legacy
--     mapping of any kind: there is no customer data to migrate, so there
--     are no legacy_school_id / legacy_mapping columns or flags anywhere.
--   * Money is stored in MINOR UNITS (paisa/cents as integers), never floats.
--   * Organisation is the tenant and the billing unit (D-2, D-4). Schools
--     live inside tenant databases; there is deliberately NO schools table
--     here, and nothing in this schema assumes one school per organisation
--     (D-3: campuses are optional children of schools, inside tenant DBs).
--   * Timestamps are ISO-8601 text (UTC). IDs are 24-hex strings (uid()).

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  -- Lifecycle states (Architecture §8): pending, provisioning, active,
  -- suspended, migration_required, offboarding, deleted. "deleted" covers
  -- decommissioned; deletion is a state change, never a row delete.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'provisioning', 'active', 'suspended', 'migration_required', 'offboarding', 'deleted')),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_databases (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  -- Provider of the tenant database (v1: 'turso'). The provisioning
  -- workflow that fills this table is Phase 5 (D-10).
  provider TEXT NOT NULL DEFAULT 'turso',
  -- The database address WITHOUT any credential, e.g.
  -- libsql://nexuslms-<org>.turso.io. The auth token is never stored here;
  -- it lives behind secret_reference_id (D-7).
  databaseUrl TEXT NOT NULL,
  secretReferenceId TEXT REFERENCES secret_references(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'active', 'suspended', 'decommissioned')),
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenant_databases_org ON tenant_databases(orgId);

CREATE TABLE IF NOT EXISTS platform_admins (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  -- Free-text role label for now. Phase 3 owns this table's shape: central
  -- identity will define platform roles properly then. Do not build role
  -- logic on this column in Phase 2.
  role TEXT NOT NULL DEFAULT 'PLATFORM_ADMIN',
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- PLACEHOLDER (D-1, Phase 3): a user may belong to multiple
  -- organisations, but central users do not exist yet, so userId is plain
  -- text with NO foreign key. Phase 3 resolves it to central_users.id.
  -- No roles or scopes here — membership roles and capabilities are
  -- Phase 3 / Phase 6 work.
  userId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE (orgId, userId)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON organization_memberships(userId);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Billing model (D-4). Both models are first-class; neither is the
  -- default assumption. A plan is ONE model or the other.
  billingModel TEXT NOT NULL CHECK (billingModel IN ('PACKAGE', 'PER_STUDENT_MONTHLY')),
  currency TEXT NOT NULL,
  -- PACKAGE only: flat monthly price, in minor units.
  monthlyPriceCents INTEGER,
  -- PER_STUDENT_MONTHLY only: price per active student per month, minor units.
  perStudentRateCents INTEGER,
  -- PACKAGE only: maximum students included; NULL means uncapped.
  studentCap INTEGER,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  CHECK (
    (billingModel = 'PACKAGE' AND monthlyPriceCents IS NOT NULL AND perStudentRateCents IS NULL)
    OR (billingModel = 'PER_STUDENT_MONTHLY' AND perStudentRateCents IS NOT NULL AND monthlyPriceCents IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS plan_entitlements (
  id TEXT PRIMARY KEY,
  planId TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  -- Capability name, as text (no capabilities table). Must be a value from
  -- docs/capability-vocabulary.md; the repository validator enforces it.
  -- See that document for the vocabulary and its scope notes.
  capability TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  UNIQUE (planId, capability)
);
CREATE INDEX IF NOT EXISTS idx_entitlements_plan ON plan_entitlements(planId);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  planId TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  -- Snapshot of the billing terms at subscription time (D-4): a later plan
  -- price change never rewrites an existing subscription's terms.
  billingModel TEXT NOT NULL CHECK (billingModel IN ('PACKAGE', 'PER_STUDENT_MONTHLY')),
  currency TEXT NOT NULL,
  monthlyPriceCents INTEGER,
  perStudentRateCents INTEGER,
  studentCap INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'past_due', 'cancelled', 'expired')),
  startedAt TEXT NOT NULL,
  endedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  CHECK (
    (billingModel = 'PACKAGE' AND monthlyPriceCents IS NOT NULL AND perStudentRateCents IS NULL)
    OR (billingModel = 'PER_STUDENT_MONTHLY' AND perStudentRateCents IS NOT NULL AND monthlyPriceCents IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON subscriptions(orgId);

CREATE TABLE IF NOT EXISTS tenant_usage_summaries (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Billing period, e.g. '2026-11'. Counts only — never student rows.
  period TEXT NOT NULL,
  -- Active-student count for the period; drives PER_STUDENT_MONTHLY
  -- billing (D-4). NOT populated in Phase 2; usage collection lands later.
  activeStudentCount INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  UNIQUE (orgId, period)
);
CREATE INDEX IF NOT EXISTS idx_usage_org ON tenant_usage_summaries(orgId);

CREATE TABLE IF NOT EXISTS secret_references (
  id TEXT PRIMARY KEY,
  -- NULL means platform-level (not tied to one organisation).
  orgId TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  -- Provider-agnostic reference (D-7). The control DB stores REFERENCES,
  -- never raw tokens: provider + key_path only. v1 provider is 'vercel-env'
  -- (Vercel encrypted environment variables). Switching provider later is
  -- a data migration, not a schema migration.
  provider TEXT NOT NULL
    CHECK (provider IN ('vercel-env', 'aws-secrets-manager', 'doppler')),
  -- Provider-specific pointer to the secret: an env var name for
  -- vercel-env, a secret ARN/name for aws-secrets-manager, a
  -- project/config/name path for doppler. Validated per provider by the
  -- repository validator; anything token-like is refused.
  keyPath TEXT NOT NULL,
  purpose TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_secrets_org ON secret_references(orgId);

CREATE TABLE IF NOT EXISTS provisioning_jobs (
  id TEXT PRIMARY KEY,
  orgId TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  tenantDatabaseId TEXT REFERENCES tenant_databases(id) ON DELETE SET NULL,
  -- SCAFFOLD (D-10): the provisioning workflow that uses this table is
  -- Phase 5. Phase 2 only creates the table.
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  -- JSON payload. Must NEVER contain secrets or tokens.
  payload TEXT,
  error TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provisioning_jobs_org ON provisioning_jobs(orgId);

CREATE TABLE IF NOT EXISTS migration_jobs (
  id TEXT PRIMARY KEY,
  tenantDatabaseId TEXT REFERENCES tenant_databases(id) ON DELETE SET NULL,
  -- SCAFFOLD (D-9/D-10): the versioned tenant-migration workflow is
  -- Phase 5. Phase 2 only creates the table.
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  error TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_migration_jobs_tenant ON migration_jobs(tenantDatabaseId);

CREATE TABLE IF NOT EXISTS support_access_grants (
  id TEXT PRIMARY KEY,
  orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- References platform_admins(id). Kept as plain text (no FK): the
  -- support workflow that defines operator identity is Phase 6/11 (D-8).
  operatorId TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  -- PLACEHOLDER, NOT the audit trail: this column records when (if ever)
  -- the grant itself was audited. Real audit events live in
  -- platform_audit_logs, which owns the audit trail.
  auditedAt TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grants_org ON support_access_grants(orgId);

CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id TEXT PRIMARY KEY,
  actorId TEXT,
  actorType TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entityId TEXT,
  orgId TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  -- JSON details (old -> new etc.). Must never contain secrets, tokens,
  -- passwords, or student payloads.
  details TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_org ON platform_audit_logs(orgId);
CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit_logs(createdAt);

-- Versioned-migration history, owned by the runner (db/control/migrate.mjs).
-- One row per applied migration: the file's version and SHA-256 checksum.
-- The runner refuses to run if a recorded checksum no longer matches its
-- file — an applied migration is immutable.
CREATE TABLE IF NOT EXISTS control_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  appliedAt TEXT NOT NULL
);
