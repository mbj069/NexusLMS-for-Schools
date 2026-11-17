# NexusLMS capability vocabulary (Phase 2 stub)

The control plane's plan entitlements and (from Phase 3) membership roles
reference capabilities **by name**. This document is the vocabulary: the
single list of capability names Phase 3's membership roles will reference
and Phase 6 will enforce. Enforcement is **not** built in Phase 2 — this
is the vocabulary only, kept stable so nothing built on it has to be
renamed later.

The same list lives in code as `CAPABILITIES` in
`src/lib/control/validators.ts`, and the Phase 2 test suite asserts the
two agree exactly (no name in the code that is missing here, and no name
here that the validator does not know). **Change the code and this
document together.**

## Naming rules

- Lowercase, dot-separated: `<area>.<verb>`.
- `<area>` is the domain the capability governs (organization, school,
  users, attendance, grades, assignments, announcements, support).
- `<verb>` is `read`, `write`, or `manage`. `manage` covers the full
  lifecycle (create, edit, delete) of its area; `read`/`write` split
  viewing from changing, where that split matters.
- No capability is ever a person's name, a school's name, or a plan's
  name. Capabilities are product-wide, not per-tenant.

## Capabilities

| Capability | Scope | Meaning |
| --- | --- | --- |
| `organization.manage` | Organization | Manage the organization itself: its profile, its subscription, its tenant database lifecycle. Held by platform operators and organization owners. |
| `school.manage` | School (within an org) | Manage schools inside the organization: create/edit schools and campuses, assign staff. |
| `users.manage` | Organization / school | Manage users in the organization's schools: invite, edit, disable, remove users and enrollments. |
| `attendance.read` | School | View attendance records and summaries. |
| `attendance.write` | School | Mark and edit attendance. |
| `grades.read` | School | View gradebook grades and report cards. |
| `grades.write` | School | Enter and edit gradebook grades. |
| `assignments.manage` | School | Create, edit, and grade assignments and quizzes. |
| `announcements.manage` | School | Create and publish announcements (Phase 10). |
| `support.access` | Organization | The capability a platform support grant confers: audited, time-limited access to an organization's data, granted only through the support-access workflow (Phase 6). Never a standing capability. |

## Where the vocabulary is referenced

- `db/control/migrations/0001_initial.sql` — the `plan_entitlements`
  table's `capability` column stores one of these names as text (no
  `capabilities` table, no foreign keys; the repository validator is the
  enforcement point in Phase 2).
- `src/lib/control/validators.ts` — `CAPABILITIES` and
  `assertValidCapability`, used by the plan-entitlement repository.
- Phase 3 will reference these names when defining membership roles; Phase 6
  will enforce them at the route layer.
