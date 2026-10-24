# NexusLMS

Multi-tenant learning management system for schools — one codebase, one
shared production portal, one isolated workspace per school. Built by
Nexus-Tech Solutions to sell to many schools, not as a per-school build:
a school is provisioned onto the portal and given access to its own
workspace. There is no fork, no separate deployment, and no code change
per school.

## What is live (Phase 2.6 hardening included)

- **Platform admin** (`/platform`): provision school workspaces, see user/session counts per school
- **School admin** (`/dashboard`): academic sessions, classes + sections, subjects,
  subject → section → teacher assignments, user management (admin/teacher/student/parent),
  student enrollments, parent ↔ child linking
- **Timetable** (`/dashboard/timetable`): weekly grid editor for admins
  (adjustable periods/day, per-period times, subject → teacher slots),
  read-only views for teachers, students, and parents
- **Attendance** (`/dashboard/attendance`): daily marking (Present/Absent/Late/Leave),
  monthly summaries and percentages, per-student and per-child views
- **Full CRUD** (Phase 2.5): edit and delete for sessions, classes, sections,
  subjects, class-subjects, users, enrollments, and parent links, with
  guards (not self, not the last school admin, teacher with assignments
  must be reassigned first) and cascade warnings in the UI
- **Hardening** (Phase 2.6, before Phase 3 and before any real school onboards):
  token revocation, user disable and soft-delete, login rate limiting,
  CSRF Origin checks on API mutations, fail-closed `AUTH_SECRET`,
  demo/production separation, school-scoped submissions/quizzes/attempts,
  old → new audit trails for attendance and deletes, and a cross-tenant
  test suite (`scripts/test-hardening.mjs`) that proves school A cannot
  read or write school B data
- **Auth**: JWT in httpOnly cookies, bcrypt passwords, server-enforced RBAC,
  plus a database-checked session (see below)
- **Multi-tenancy**: every domain table carries `schoolId`; all school routes are
  hard-scoped to the caller's school (super-admins pass `schoolId` explicitly).
  Tenant isolation is enforced in code, in the schema (schoolId indexes and
  foreign keys where SQLite allows them), and in tests — not by convention alone
- **Database**: SQLite via Node's built-in `node:sqlite` locally, Turso
  (hosted SQLite) in production via `@libsql/client`. The SQL is identical
  for both; only the driver differs (`src/lib/db.ts`). Deployments never
  require manual database surgery: new columns and backfills are applied
  automatically on first use (see `MIGRATION_SQL` in `src/lib/db.ts`).
  Postgres (with composite foreign keys and row-level security) is the
  planned migration trigger — first paying school, or a defined
  school/write volume — not a someday rewrite. See "Production notes" below.

Coming next (Phase 3): lessons, assignments + submissions/grading, quizzes
+ questions/attempts, gradebook + report cards (tables already exist in
the schema), then announcements UI and a fuller parent portal.

## Run it locally

```bash
npm install
npm run db:migrate   # create tables in dev.db
npm run db:seed       # demo school + one login per role (LOCAL/DEMO ONLY)
npm run dev           # http://localhost:3000
```

`npm run db:reset` wipes and re-seeds the demo data.
`node scripts/test-hardening.mjs` runs the cross-tenant, revocation,
CSRF, rate-limit, setup-lockdown, and audit tests on a throwaway DB.

## Demo vs production — read this before deploying

There are two different deployments, and they must never share a database:

- **Demo deployment** (`DEMO_MODE=1`): an isolated, resettable database
  for trying the product. It may be seeded with demo accounts. It must
  never hold a real school, and demo data there is not real data.
- **Production deployment** (`DEMO_MODE` unset): the real portal schools
  are sold onto. It has **no demo accounts, no published logins, and no
  unauthenticated seeding**. Seeding it is refused by `db/seed.mjs`
  unless `ALLOW_PROD_SEED=1` is set explicitly, and `/api/setup` on
  production requires the setup key (`AUTH_SECRET`, owner-only) even on
  an empty database. The platform super-admin login is never published.

Demo trial logins for a demo deployment only (school roles; the
super-admin account is owner-only and is intentionally not listed here):

| Email | Role | Lands on |
|---|---|---|
| `admin@demo.edu` | School admin | `/dashboard` — full setup |
| `teacher@demo.edu` | Teacher | `/dashboard` — my subjects |
| `student@demo.edu` | Student | `/dashboard — my classes |
| `parent@demo.edu` | Parent | `/dashboard` — my children |

The seed creates **Demo Academy** — clearly-labeled demo data, not a real school.

## Deploying (production)

1. Set `AUTH_SECRET` to a long random string (env var). If it is missing
   in production, the app refuses to sign or verify sessions — it never
   falls back to a known dev secret.
2. Set `TURSO_DATABASE_URL` (+ `TURSO_AUTH_TOKEN`) to your Turso database.
   Do **not** point production at a local `file:` SQLite path on Vercel —
   the filesystem there is ephemeral and the data would not persist.
3. Do **not** set `DEMO_MODE=1` on production.
4. Run `npm run build`, deploy. Schema upgrades apply automatically on
   first use; no manual migration step is needed per deploy.
5. Provision the first school as platform admin, create its school admin,
   and hand that admin their login. Schools are onboarded this way —
   never by seeding demo accounts on production.

Local Turso testing: set the same two Turso vars locally and run
`npm run db:migrate` / `npm run db:seed` (the seed refuses in production
mode unless you explicitly allow it — see above).

## Security model (what a school is trusting us with)

- **Sessions are database-checked, not just signature-checked.** Every
  request re-reads the user row: disabled, soft-deleted, or token-version
  mismatch means no session, immediately. Changing a password, disabling
  a user, or soft-deleting them bumps `tokenVersion` and kills all
  previously issued tokens — a removed teacher does not keep access for
  the 7-day token lifetime. Role, school, name, and email in a session
  come from the database, not from the token, so role changes take
  effect on the next request. The proxy (`src/proxy.ts`) is a UX redirect
  only; authorization lives in `requireAuth` / `requireSchoolScope`.
- **Login rate limiting:** 10 failed attempts per email and 50 per IP
  per 15 minutes (in-memory per instance; a shared store replaces it
  when the product outgrows one instance).
- **CSRF:** session cookies are httpOnly + SameSite=Lax, and the proxy
  rejects state-changing API calls whose `Origin` does not match the
  app's own origin.
- **Audit:** `audit_logs` records who did what, with before/after
  detail for attendance changes and deletes (e.g. old vs new status,
  cascade counts). Passwords and tokens are never written to audit logs.
  School admins can export their whole workspace (without password
  hashes) from `/api/school/export`, and `db/restore.mjs` restores an
  export into an empty database (users get a fresh password supplied
  at restore time, which must then be changed).
- **Deletes:** users are soft-deleted (`deletedAt`, `isActive = 0`),
  so attendance, grades, and audit history that reference them stay
  valid and attributable. Other structure deletes are hard deletes
  with guards and audit rows, because their cascades are shown in the
  UI before confirmation. Grades carry `deletedAt` from day one, and
  Phase 3 must respect it and audit every grade change.
- **Files:** assignment uploads are not built yet. When they are, files
  go to object storage (S3/R2) with signed URLs — never into the
  database and never onto the app server (whose filesystem is ephemeral).

## Production notes / known limits (honest, not hidden)

- Same email in multiple schools → login picks the school-scoped account
  first (documented in the login route). School-scoped accounts are the
  norm; the platform account is the exception.
- Composite foreign keys (e.g. a class-subject row that must belong to
  the same school as its section *and* its subject) are enforced in
  application code and in tests today. SQLite cannot add such a
  constraint to an existing table without a rebuild, so full composite
  FKs + row-level security arrive with the Postgres migration, which is
  triggered by the first paying school or a defined scale threshold.
  Until then, the cross-tenant test suite is the guard — it must pass
  before every release.
- Login rate limiting is per-instance (see above); pagination on list
  endpoints is offset-based where it exists and is not yet universal —
  lists today are per-school/per-section and small, and cursor
  pagination is a Phase 3 follow-up when list sizes require it.
- Platform admin creation has no self-service signup yet: the owner
  provisions schools and their first admin. That is deliberate for a
  sold product (no open registration), and a proper onboarding flow
  (invite-based admin creation) is a pre-launch item, not a Phase 3
  feature.

## Project layout

- `db/schema.sql` — full data model (schools → sessions → classes → sections → subjects …)
- `db/migrate.mjs`, `db/seed.mjs`, `db/restore.mjs` — schema apply + demo seed + export restore
- `src/lib/db.ts` — dual SQLite/Turso wrapper, `uid()`, `transaction()`, auto-migrations
- `src/lib/auth.ts` — JWT sessions, password hashing, role hierarchy, revocation checks
- `src/lib/tenant.ts` — `requireAuth` / `requireSchoolScope` / `writeAudit` — **every** API route uses these
- `src/proxy.ts` — auth gate + role redirects + CSRF Origin guard (UX only, not authorization)
- `src/app/api/**` — REST API, always school-scoped
- `src/app/(platform|dashboard|login|setup)` — UI
- `scripts/test-hardening.mjs` — cross-tenant, revocation, CSRF, rate-limit, setup, and audit tests
