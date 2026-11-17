/**
 * Control-plane repositories (Phase 2).
 *
 * Plain data access over the control database (src/lib/control-db.ts).
 * No HTTP, no UI, no business workflows — those are later phases.
 * Every function logs its errors (structured, redacted) and re-throws;
 * callers pass an optional { correlationId } for log correlation.
 *
 * Validation lives in ./validators.ts and is enforced here at the
 * repository boundary: capability names, billing shapes, secret
 * references, and slugs are all rejected before they reach the DB.
 */
import {
  controlAll,
  controlGet,
  controlRun,
  controlUid,
  controlNowIso,
  type ControlExecutor,
} from "../control-db";
import { logError, type LogContext } from "../logging";
import {
  assertValidCapability,
  assertBillingTerms,
  assertValidSecretReference,
  assertValidSlug,
  type BillingTerms,
  type SecretProvider,
} from "./validators";

type Opts = LogContext;

function repoError(op: string, err: unknown, orgId?: string, opts?: Opts): never {
  logError(
    "control.repository.failed",
    { operation: op, error: err instanceof Error ? err.message : String(err) },
    { correlationId: opts?.correlationId, orgId }
  );
  throw err;
}

// --- Row types ---------------------------------------------------------------
export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface TenantDatabase {
  id: string;
  orgId: string;
  provider: string;
  databaseUrl: string;
  secretReferenceId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformAdmin {
  id: string;
  email: string;
  role: string;
  createdAt: string;
}

export interface Membership {
  id: string;
  orgId: string;
  userId: string;
  createdAt: string;
}

export interface Plan extends BillingTerms {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanEntitlement {
  id: string;
  planId: string;
  capability: string;
  enabled: number;
}

export interface Subscription extends BillingTerms {
  id: string;
  orgId: string;
  planId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantUsageSummary {
  id: string;
  orgId: string;
  period: string;
  activeStudentCount: number;
  createdAt: string;
}

export interface SecretReference {
  id: string;
  orgId: string | null;
  provider: string;
  keyPath: string;
  purpose: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProvisioningJob {
  id: string;
  orgId: string | null;
  tenantDatabaseId: string | null;
  kind: string;
  status: string;
  payload: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationJob {
  id: string;
  tenantDatabaseId: string | null;
  version: string;
  status: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportAccessGrant {
  id: string;
  orgId: string;
  operatorId: string;
  expiresAt: string;
  auditedAt: string | null;
  createdAt: string;
}

export interface PlatformAuditLog {
  id: string;
  actorId: string | null;
  actorType: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  orgId: string | null;
  details: string | null;
  createdAt: string;
}

// --- Organizations -----------------------------------------------------------
const ORG_STATUSES = [
  "pending",
  "provisioning",
  "active",
  "suspended",
  "migration_required",
  "offboarding",
  "deleted",
] as const;

export async function createOrganization(
  input: { name: string; slug: string; status?: string },
  opts?: Opts
): Promise<Organization> {
  assertValidSlug(input.slug);
  const status = input.status ?? "pending";
  if (!ORG_STATUSES.includes(status as (typeof ORG_STATUSES)[number])) {
    throw new Error(`[control] unknown organization status "${status}".`);
  }
  const now = controlNowIso();
  const id = controlUid();
  try {
    await controlRun(
      "INSERT INTO organizations (id, name, slug, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?)",
      id,
      input.name,
      input.slug,
      status,
      now,
      now
    );
    return { id, name: input.name, slug: input.slug, status, createdAt: now, updatedAt: now };
  } catch (e) {
    repoError("organizations.create", e, undefined, opts);
  }
}

export async function getOrganization(id: string, opts?: Opts): Promise<Organization | undefined> {
  try {
    return controlGet<Organization>("SELECT * FROM organizations WHERE id = ?", id);
  } catch (e) {
    repoError("organizations.get", e, undefined, opts);
  }
}

export async function getOrganizationBySlug(slug: string, opts?: Opts): Promise<Organization | undefined> {
  try {
    return controlGet<Organization>("SELECT * FROM organizations WHERE slug = ?", slug);
  } catch (e) {
    repoError("organizations.getBySlug", e, undefined, opts);
  }
}

export async function listOrganizations(opts?: Opts): Promise<Organization[]> {
  try {
    return controlAll<Organization>("SELECT * FROM organizations ORDER BY createdAt ASC");
  } catch (e) {
    repoError("organizations.list", e, undefined, opts);
  }
}

export async function setOrganizationStatus(id: string, status: string, opts?: Opts): Promise<void> {
  if (!ORG_STATUSES.includes(status as (typeof ORG_STATUSES)[number])) {
    throw new Error(`[control] unknown organization status "${status}".`);
  }
  try {
    await controlRun("UPDATE organizations SET status = ?, updatedAt = ? WHERE id = ?", status, controlNowIso(), id);
  } catch (e) {
    repoError("organizations.setStatus", e, id, opts);
  }
}

// --- Tenant databases --------------------------------------------------------
const TENANT_DB_STATUSES = ["provisioning", "active", "suspended", "decommissioned"] as const;

export async function createTenantDatabase(
  input: { orgId: string; provider?: string; databaseUrl: string; secretReferenceId?: string | null },
  opts?: Opts
): Promise<TenantDatabase> {
  const provider = input.provider ?? "turso";
  const now = controlNowIso();
  const id = controlUid();
  try {
    await controlRun(
      "INSERT INTO tenant_databases (id, orgId, provider, databaseUrl, secretReferenceId, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)",
      id,
      input.orgId,
      provider,
      input.databaseUrl,
      input.secretReferenceId ?? null,
      "provisioning",
      now,
      now
    );
    return {
      id,
      orgId: input.orgId,
      provider,
      databaseUrl: input.databaseUrl,
      secretReferenceId: input.secretReferenceId ?? null,
      status: "provisioning",
      createdAt: now,
      updatedAt: now,
    };
  } catch (e) {
    repoError("tenantDatabases.create", e, input.orgId, opts);
  }
}

export async function getTenantDatabase(id: string, opts?: Opts): Promise<TenantDatabase | undefined> {
  try {
    return controlGet<TenantDatabase>("SELECT * FROM tenant_databases WHERE id = ?", id);
  } catch (e) {
    repoError("tenantDatabases.get", e, undefined, opts);
  }
}

export async function listTenantDatabases(orgId: string, opts?: Opts): Promise<TenantDatabase[]> {
  try {
    return controlAll<TenantDatabase>("SELECT * FROM tenant_databases WHERE orgId = ? ORDER BY createdAt ASC", orgId);
  } catch (e) {
    repoError("tenantDatabases.list", e, orgId, opts);
  }
}

export async function setTenantDatabaseStatus(id: string, status: string, opts?: Opts): Promise<void> {
  if (!TENANT_DB_STATUSES.includes(status as (typeof TENANT_DB_STATUSES)[number])) {
    throw new Error(`[control] unknown tenant database status "${status}".`);
  }
  try {
    await controlRun("UPDATE tenant_databases SET status = ?, updatedAt = ? WHERE id = ?", status, controlNowIso(), id);
  } catch (e) {
    repoError("tenantDatabases.setStatus", e, undefined, opts);
  }
}

// --- Platform admins (minimal placeholder; Phase 3 owns the shape) -----------
export async function createPlatformAdmin(
  input: { email: string; role?: string },
  opts?: Opts
): Promise<PlatformAdmin> {
  const now = controlNowIso();
  const id = controlUid();
  const role = input.role ?? "PLATFORM_ADMIN";
  try {
    await controlRun(
      "INSERT INTO platform_admins (id, email, role, createdAt) VALUES (?,?,?,?)",
      id,
      input.email,
      role,
      now
    );
    return { id, email: input.email, role, createdAt: now };
  } catch (e) {
    repoError("platformAdmins.create", e, undefined, opts);
  }
}

export async function getPlatformAdminByEmail(email: string, opts?: Opts): Promise<PlatformAdmin | undefined> {
  try {
    return controlGet<PlatformAdmin>("SELECT * FROM platform_admins WHERE email = ?", email);
  } catch (e) {
    repoError("platformAdmins.getByEmail", e, undefined, opts);
  }
}

export async function listPlatformAdmins(opts?: Opts): Promise<PlatformAdmin[]> {
  try {
    return controlAll<PlatformAdmin>("SELECT * FROM platform_admins ORDER BY createdAt ASC");
  } catch (e) {
    repoError("platformAdmins.list", e, undefined, opts);
  }
}

// --- Organization memberships (placeholder; Phase 3 adds central users) ------
export async function addMembership(
  input: { orgId: string; userId: string },
  opts?: Opts
): Promise<Membership> {
  const now = controlNowIso();
  const id = controlUid();
  try {
    await controlRun(
      "INSERT INTO organization_memberships (id, orgId, userId, createdAt) VALUES (?,?,?,?)",
      id,
      input.orgId,
      input.userId,
      now
    );
    return { id, orgId: input.orgId, userId: input.userId, createdAt: now };
  } catch (e) {
    repoError("memberships.add", e, input.orgId, opts);
  }
}

export async function listMembershipsByOrg(orgId: string, opts?: Opts): Promise<Membership[]> {
  try {
    return controlAll<Membership>(
      "SELECT * FROM organization_memberships WHERE orgId = ? ORDER BY createdAt ASC",
      orgId
    );
  } catch (e) {
    repoError("memberships.listByOrg", e, orgId, opts);
  }
}

export async function listMembershipsByUser(userId: string, opts?: Opts): Promise<Membership[]> {
  try {
    return controlAll<Membership>(
      "SELECT * FROM organization_memberships WHERE userId = ? ORDER BY createdAt ASC",
      userId
    );
  } catch (e) {
    repoError("memberships.listByUser", e, undefined, opts);
  }
}

export async function removeMembership(orgId: string, userId: string, opts?: Opts): Promise<void> {
  try {
    await controlRun("DELETE FROM organization_memberships WHERE orgId = ? AND userId = ?", orgId, userId);
  } catch (e) {
    repoError("memberships.remove", e, orgId, opts);
  }
}

// --- Plans & entitlements (D-4: both billing models) -------------------------
export async function createPlan(
  input: { name: string } & BillingTerms,
  opts?: Opts
): Promise<Plan> {
  assertBillingTerms(input);
  const now = controlNowIso();
  const id = controlUid();
  try {
    await controlRun(
      "INSERT INTO plans (id, name, billingModel, currency, monthlyPriceCents, perStudentRateCents, studentCap, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
      id,
      input.name,
      input.billingModel,
      input.currency,
      input.monthlyPriceCents ?? null,
      input.perStudentRateCents ?? null,
      input.studentCap ?? null,
      now,
      now
    );
    return {
      id,
      name: input.name,
      billingModel: input.billingModel,
      currency: input.currency,
      monthlyPriceCents: input.monthlyPriceCents ?? null,
      perStudentRateCents: input.perStudentRateCents ?? null,
      studentCap: input.studentCap ?? null,
      createdAt: now,
      updatedAt: now,
    };
  } catch (e) {
    repoError("plans.create", e, undefined, opts);
  }
}

export async function getPlan(id: string, opts?: Opts): Promise<Plan | undefined> {
  try {
    return controlGet<Plan>("SELECT * FROM plans WHERE id = ?", id);
  } catch (e) {
    repoError("plans.get", e, undefined, opts);
  }
}

export async function listPlans(opts?: Opts): Promise<Plan[]> {
  try {
    return controlAll<Plan>("SELECT * FROM plans ORDER BY createdAt ASC");
  } catch (e) {
    repoError("plans.list", e, undefined, opts);
  }
}

export async function setPlanEntitlement(
  planId: string,
  capability: string,
  enabled: boolean,
  opts?: Opts
): Promise<PlanEntitlement> {
  assertValidCapability(capability);
  const id = controlUid();
  try {
    // Upsert by (planId, capability): delete the old row, insert the new one.
    await controlRun("DELETE FROM plan_entitlements WHERE planId = ? AND capability = ?", planId, capability);
    await controlRun(
      "INSERT INTO plan_entitlements (id, planId, capability, enabled) VALUES (?,?,?,?)",
      id,
      planId,
      capability,
      enabled ? 1 : 0
    );
    return { id, planId, capability, enabled: enabled ? 1 : 0 };
  } catch (e) {
    repoError("planEntitlements.set", e, undefined, opts);
  }
}

export async function listPlanEntitlements(planId: string, opts?: Opts): Promise<PlanEntitlement[]> {
  try {
    return controlAll<PlanEntitlement>(
      "SELECT * FROM plan_entitlements WHERE planId = ? ORDER BY capability ASC",
      planId
    );
  } catch (e) {
    repoError("planEntitlements.list", e, undefined, opts);
  }
}

// --- Subscriptions -----------------------------------------------------------
const SUBSCRIPTION_STATUSES = ["active", "past_due", "cancelled", "expired"] as const;

export async function createSubscription(
  input: { orgId: string; planId: string; status?: string } & BillingTerms,
  opts?: Opts
): Promise<Subscription> {
  assertBillingTerms(input);
  const status = input.status ?? "active";
  if (!SUBSCRIPTION_STATUSES.includes(status as (typeof SUBSCRIPTION_STATUSES)[number])) {
    throw new Error(`[control] unknown subscription status "${status}".`);
  }
  const now = controlNowIso();
  const id = controlUid();
  try {
    await controlRun(
      "INSERT INTO subscriptions (id, orgId, planId, billingModel, currency, monthlyPriceCents, perStudentRateCents, studentCap, status, startedAt, endedAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      input.orgId,
      input.planId,
      input.billingModel,
      input.currency,
      input.monthlyPriceCents ?? null,
      input.perStudentRateCents ?? null,
      input.studentCap ?? null,
      status,
      now,
      null,
      now,
      now
    );
    return {
      id,
      orgId: input.orgId,
      planId: input.planId,
      billingModel: input.billingModel,
      currency: input.currency,
      monthlyPriceCents: input.monthlyPriceCents ?? null,
      perStudentRateCents: input.perStudentRateCents ?? null,
      studentCap: input.studentCap ?? null,
      status,
      startedAt: now,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  } catch (e) {
    repoError("subscriptions.create", e, input.orgId, opts);
  }
}

export async function getActiveSubscription(orgId: string, opts?: Opts): Promise<Subscription | undefined> {
  try {
    return controlGet<Subscription>(
      "SELECT * FROM subscriptions WHERE orgId = ? AND status = 'active' ORDER BY createdAt DESC LIMIT 1",
      orgId
    );
  } catch (e) {
    repoError("subscriptions.getActive", e, orgId, opts);
  }
}

export async function listSubscriptions(orgId: string, opts?: Opts): Promise<Subscription[]> {
  try {
    return controlAll<Subscription>(
      "SELECT * FROM subscriptions WHERE orgId = ? ORDER BY createdAt ASC",
      orgId
    );
  } catch (e) {
    repoError("subscriptions.list", e, orgId, opts);
  }
}

// --- Tenant usage summaries (read-only in Phase 2; not populated) ------------
export async function getUsageSummary(
  orgId: string,
  period: string,
  opts?: Opts
): Promise<TenantUsageSummary | undefined> {
  try {
    return controlGet<TenantUsageSummary>(
      "SELECT * FROM tenant_usage_summaries WHERE orgId = ? AND period = ?",
      orgId,
      period
    );
  } catch (e) {
    repoError("usageSummaries.get", e, orgId, opts);
  }
}

export async function listUsageSummaries(orgId: string, opts?: Opts): Promise<TenantUsageSummary[]> {
  try {
    return controlAll<TenantUsageSummary>(
      "SELECT * FROM tenant_usage_summaries WHERE orgId = ? ORDER BY period ASC",
      orgId
    );
  } catch (e) {
    repoError("usageSummaries.list", e, orgId, opts);
  }
}

// --- Secret references (D-7: references only, never raw tokens) --------------
export async function createSecretReference(
  input: { orgId?: string | null; provider: string; keyPath: string; purpose?: string },
  opts?: Opts
): Promise<SecretReference> {
  assertValidSecretReference(input.provider, input.keyPath);
  const now = controlNowIso();
  const id = controlUid();
  try {
    await controlRun(
      "INSERT INTO secret_references (id, orgId, provider, keyPath, purpose, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)",
      id,
      input.orgId ?? null,
      input.provider,
      input.keyPath,
      input.purpose ?? null,
      now,
      now
    );
    return {
      id,
      orgId: input.orgId ?? null,
      provider: input.provider as SecretProvider,
      keyPath: input.keyPath,
      purpose: input.purpose ?? null,
      createdAt: now,
      updatedAt: now,
    };
  } catch (e) {
    repoError("secretReferences.create", e, input.orgId ?? undefined, opts);
  }
}

export async function getSecretReference(id: string, opts?: Opts): Promise<SecretReference | undefined> {
  try {
    return controlGet<SecretReference>("SELECT * FROM secret_references WHERE id = ?", id);
  } catch (e) {
    repoError("secretReferences.get", e, undefined, opts);
  }
}

export async function listSecretReferences(orgId: string | null, opts?: Opts): Promise<SecretReference[]> {
  try {
    if (orgId === null) {
      return controlAll<SecretReference>(
        "SELECT * FROM secret_references WHERE orgId IS NULL ORDER BY createdAt ASC"
      );
    }
    return controlAll<SecretReference>(
      "SELECT * FROM secret_references WHERE orgId = ? ORDER BY createdAt ASC",
      orgId
    );
  } catch (e) {
    repoError("secretReferences.list", e, orgId ?? undefined, opts);
  }
}

// --- Provisioning & migration jobs (scaffolds; workflows are Phase 5) --------
const JOB_STATUSES = ["pending", "running", "succeeded", "failed"] as const;

export async function createProvisioningJob(
  input: { orgId?: string | null; tenantDatabaseId?: string | null; kind: string; payload?: Record<string, unknown> },
  opts?: Opts
): Promise<ProvisioningJob> {
  const now = controlNowIso();
  const id = controlUid();
  const payload = input.payload ? JSON.stringify(input.payload) : null;
  try {
    await controlRun(
      "INSERT INTO provisioning_jobs (id, orgId, tenantDatabaseId, kind, status, payload, error, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
      id,
      input.orgId ?? null,
      input.tenantDatabaseId ?? null,
      input.kind,
      "pending",
      payload,
      null,
      now,
      now
    );
    return {
      id,
      orgId: input.orgId ?? null,
      tenantDatabaseId: input.tenantDatabaseId ?? null,
      kind: input.kind,
      status: "pending",
      payload,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
  } catch (e) {
    repoError("provisioningJobs.create", e, input.orgId ?? undefined, opts);
  }
}

export async function updateProvisioningJobStatus(
  id: string,
  status: string,
  error?: string,
  opts?: Opts
): Promise<void> {
  if (!JOB_STATUSES.includes(status as (typeof JOB_STATUSES)[number])) {
    throw new Error(`[control] unknown job status "${status}".`);
  }
  try {
    await controlRun(
      "UPDATE provisioning_jobs SET status = ?, error = ?, updatedAt = ? WHERE id = ?",
      status,
      error ?? null,
      controlNowIso(),
      id
    );
  } catch (e) {
    repoError("provisioningJobs.updateStatus", e, undefined, opts);
  }
}

export async function getProvisioningJob(id: string, opts?: Opts): Promise<ProvisioningJob | undefined> {
  try {
    return controlGet<ProvisioningJob>("SELECT * FROM provisioning_jobs WHERE id = ?", id);
  } catch (e) {
    repoError("provisioningJobs.get", e, undefined, opts);
  }
}

export async function createMigrationJob(
  input: { tenantDatabaseId?: string | null; version: string },
  opts?: Opts
): Promise<MigrationJob> {
  const now = controlNowIso();
  const id = controlUid();
  try {
    await controlRun(
      "INSERT INTO migration_jobs (id, tenantDatabaseId, version, status, error, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)",
      id,
      input.tenantDatabaseId ?? null,
      input.version,
      "pending",
      null,
      now,
      now
    );
    return {
      id,
      tenantDatabaseId: input.tenantDatabaseId ?? null,
      version: input.version,
      status: "pending",
      error: null,
      createdAt: now,
      updatedAt: now,
    };
  } catch (e) {
    repoError("migrationJobs.create", e, undefined, opts);
  }
}

export async function updateMigrationJobStatus(
  id: string,
  status: string,
  error?: string,
  opts?: Opts
): Promise<void> {
  if (!JOB_STATUSES.includes(status as (typeof JOB_STATUSES)[number])) {
    throw new Error(`[control] unknown job status "${status}".`);
  }
  try {
    await controlRun(
      "UPDATE migration_jobs SET status = ?, error = ?, updatedAt = ? WHERE id = ?",
      status,
      error ?? null,
      controlNowIso(),
      id
    );
  } catch (e) {
    repoError("migrationJobs.updateStatus", e, undefined, opts);
  }
}

export async function getMigrationJob(id: string, opts?: Opts): Promise<MigrationJob | undefined> {
  try {
    return controlGet<MigrationJob>("SELECT * FROM migration_jobs WHERE id = ?", id);
  } catch (e) {
    repoError("migrationJobs.get", e, undefined, opts);
  }
}

// --- Support access grants (placeholder; workflow is Phase 6/11) -------------
export async function createSupportAccessGrant(
  input: { orgId: string; operatorId: string; expiresAt: string },
  opts?: Opts
): Promise<SupportAccessGrant> {
  const now = controlNowIso();
  const id = controlUid();
  try {
    await controlRun(
      "INSERT INTO support_access_grants (id, orgId, operatorId, expiresAt, auditedAt, createdAt) VALUES (?,?,?,?,?,?)",
      id,
      input.orgId,
      input.operatorId,
      input.expiresAt,
      null,
      now
    );
    return {
      id,
      orgId: input.orgId,
      operatorId: input.operatorId,
      expiresAt: input.expiresAt,
      auditedAt: null,
      createdAt: now,
    };
  } catch (e) {
    repoError("supportAccessGrants.create", e, input.orgId, opts);
  }
}

export async function listSupportAccessGrants(orgId: string, opts?: Opts): Promise<SupportAccessGrant[]> {
  try {
    return controlAll<SupportAccessGrant>(
      "SELECT * FROM support_access_grants WHERE orgId = ? ORDER BY createdAt ASC",
      orgId
    );
  } catch (e) {
    repoError("supportAccessGrants.list", e, orgId, opts);
  }
}

export async function revokeSupportAccessGrant(id: string, opts?: Opts): Promise<void> {
  try {
    await controlRun("DELETE FROM support_access_grants WHERE id = ?", id);
  } catch (e) {
    repoError("supportAccessGrants.revoke", e, undefined, opts);
  }
}

// --- Platform audit log (owns the real audit trail) ---------------------------
export async function writePlatformAudit(
  input: {
    actorId?: string | null;
    actorType?: string | null;
    action: string;
    entity: string;
    entityId?: string | null;
    orgId?: string | null;
    details?: Record<string, unknown>;
  },
  opts?: Opts
): Promise<PlatformAuditLog> {
  const now = controlNowIso();
  const id = controlUid();
  const details = input.details ? JSON.stringify(input.details) : null;
  try {
    await controlRun(
      "INSERT INTO platform_audit_logs (id, actorId, actorType, action, entity, entityId, orgId, details, createdAt) VALUES (?,?,?,?,?,?,?,?,?)",
      id,
      input.actorId ?? null,
      input.actorType ?? null,
      input.action,
      input.entity,
      input.entityId ?? null,
      input.orgId ?? null,
      details,
      now
    );
    return {
      id,
      actorId: input.actorId ?? null,
      actorType: input.actorType ?? null,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId ?? null,
      orgId: input.orgId ?? null,
      details,
      createdAt: now,
    };
  } catch (e) {
    repoError("platformAudit.write", e, input.orgId ?? undefined, opts);
  }
}

export async function listPlatformAuditLogs(
  orgId: string | null,
  limit: number,
  opts?: Opts
): Promise<PlatformAuditLog[]> {
  try {
    if (orgId === null) {
      return controlAll<PlatformAuditLog>(
        "SELECT * FROM platform_audit_logs ORDER BY createdAt DESC LIMIT ?",
        limit
      );
    }
    return controlAll<PlatformAuditLog>(
      "SELECT * FROM platform_audit_logs WHERE orgId = ? ORDER BY createdAt DESC LIMIT ?",
      orgId,
      limit
    );
  } catch (e) {
    repoError("platformAudit.list", e, orgId ?? undefined, opts);
  }
}

// Re-exported for tests that want to run repository work inside a
// transaction with an explicit handle.
export type { ControlExecutor };
