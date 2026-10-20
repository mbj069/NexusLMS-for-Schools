# NexusLMS

Multi-tenant learning management system for schools — one codebase, one
isolated workspace per school. Built by Nexus-Tech Solutions.

## What's in v1 (foundation)

- **Platform admin** (`/platform`): provision school workspaces, see user/session counts per school
- **School admin** (`/dashboard`): academic sessions, classes + sections, subjects,
  subject → section → teacher assignments, user management (admin/teacher/student/parent),
  student enrollments, parent ↔ child linking
- **Role dashboards**: teachers see their assigned subjects, students see their
  classes, parents see their linked children
- **Auth**: JWT in httpOnly cookies, bcrypt passwords, server-enforced RBAC
- **Multi-tenancy**: every domain table carries `schoolId`; all school routes are
  hard-scoped to the caller's school (super-admins pass `schoolId` explicitly)
- **Database**: SQLite via Node's built-in `node:sqlite` — zero native dependencies,
  `npm install` works anywhere. Schema is standard SQL, portable to Postgres later.

Coming next (phases 2–4): timetable, attendance, lessons, assignments, quizzes,
gradebook + report cards, announcements, parent portal details.

## Run it

```bash
npm install
npm run db:migrate   # create tables in dev.db
npm run db:seed       # demo school + one login per role
npm run dev           # http://localhost:3000
```

`npm run db:reset` wipes and re-seeds the demo data.

## Demo logins (password for all: `demo1234`)

| Email | Role | Lands on |
|---|---|---|
| `superadmin@nexusms.app` | Platform admin | `/platform` — manage schools |
| `admin@demo.edu` | School admin | `/dashboard` — full setup |
| `teacher@demo.edu` | Teacher | `/dashboard` — my subjects |
| `student@demo.edu` | Student | `/dashboard` — my classes |
| `parent@demo.edu` | Parent | `/dashboard` — my children |

The seed creates **Demo Academy** — clearly-labeled demo data, not a real school.

## Deploying

1. Set `AUTH_SECRET` to a long random string (env var).
2. Point `DATABASE_URL` at your SQLite file, e.g. `file:/data/prod.db`.
3. Run `npm run db:migrate` once against it, `npm run build`, `npm start`.
4. (Later) move to Postgres: change the DDL types in `db/schema.sql` as needed —
   all queries are plain SQL through `src/lib/db.ts`.

## Project layout

- `db/schema.sql` — full v1 data model (schools → sessions → classes → sections → subjects …)
- `db/migrate.mjs`, `db/seed.mjs` — schema apply + demo seed
- `src/lib/db.ts` — SQLite wrapper, `uid()`, `transaction()`, tenant-safe helpers
- `src/lib/auth.ts` — JWT sessions, password hashing, role hierarchy
- `src/lib/tenant.ts` — `requireAuth` / `requireSchoolScope` — **every** API route uses these
- `src/proxy.ts` — auth gate + role redirects (Next.js 16 proxy convention)
- `src/app/api/**` — REST API, always school-scoped
- `src/app/(platform|dashboard|login)` — UI
