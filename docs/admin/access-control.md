# Access Control

Cascadia PLM uses a layered access control model combining role-based access control (RBAC) with program-based isolation. This guide covers how roles, permissions, programs, and design access work together.

## Access Control Layers

Access decisions pass through three layers:

```
Request
  |
  v
[1. Authentication] -- Is the user logged in with a valid session?
  |
  v
[2. RBAC]           -- Does the user's role grant the required permission?
  |
  v
[3. Program Access] -- Is the user a member of the relevant program?
```

All three layers must pass for a request to succeed.

## Role-Based Access Control (RBAC)

### Role Definitions

Cascadia ships with five built-in roles. Each role is stored in the `roles` table with a `permissions` JSONB column containing the full permission matrix.

| Role          | Description                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Administrator | Top-level administrator. Bypasses all program-based access checks, manages programs, users, roles, and system settings.                          |
| Power User    | Can create, read, update, and delete all item types. Can manage workflows and lifecycles. Reaches the System section, but not the admin console. |
| Approver      | Can read and update items, plus approve items and change orders. Cannot create or delete items.                                                  |
| User          | Can create and update draft items. Read access to released items. Cannot delete items or approve change orders.                                  |
| View Only     | Read-only access to all resources. Cannot create, edit, or delete anything.                                                                      |

### Permission Structure

Permissions are defined as resource-action pairs. Each role specifies which actions it allows on which resource types.

**Actions**:

| Action    | Meaning                                  |
| --------- | ---------------------------------------- |
| `create`  | Create new instances of the resource     |
| `read`    | View existing instances                  |
| `update`  | Modify existing instances                |
| `delete`  | Remove instances                         |
| `approve` | Approve items (lifecycle transitions)    |
| `manage`  | Full control (implies all other actions) |

**Resource types**:

| Resource            | What it controls                                   |
| ------------------- | -------------------------------------------------- |
| `parts`             | Part items                                         |
| `documents`         | Document items                                     |
| `change_orders`     | Engineering Change Orders                          |
| `designs`           | Design containers                                  |
| `requirements`      | Requirement items                                  |
| `tasks`             | Task items                                         |
| `work_instructions` | Work instruction items                             |
| `work_orders`       | Work order items                                   |
| `issues`            | Issue items                                        |
| `workflows`         | Workflow definitions and instances                 |
| `users`             | User accounts                                      |
| `roles`             | Role definitions                                   |
| `programs`          | Program management                                 |
| `reports`           | Report generation                                  |
| `system`            | The System section of the navigation and its pages |

### Permission Matrix

The complete permission matrix for each role:

| Resource          | Administrator | Power User | Approver | User | View Only |
| ----------------- | ------------- | ---------- | -------- | ---- | --------- |
| parts             | CRUDA         | CRUD       | RUA      | CRU  | R         |
| documents         | CRUDA         | CRUD       | RUA      | CRU  | R         |
| change_orders     | CRUDA         | CRUD       | RUA      | CR   | R         |
| designs           | CRUD          | CRUD       | RU       | CRU  | R         |
| requirements      | CRUDA         | CRUD       | RUA      | CRU  | R         |
| tasks             | CRUD          | CRUD       | RU       | CRU  | R         |
| work_instructions | CRUD          | CRUD       | RUA      | CRU  | R         |
| work_orders       | CRUD          | CRUD       | RUA      | CRU  | R         |
| issues            | CRUDA         | CRUD       | RUA      | CRU  | R         |
| workflows         | CRUDM         | RM         | R        | R    | R         |
| users             | CRUDM         | R          | R        | R    | R         |
| roles             | CRUDM         | R          | R        | R    | R         |
| programs          | CRUDM         | R          | R        | R    | R         |
| reports           | CRUD          | CRUD       | R        | R    | R         |
| system            | RM            | R          | —        | —    | —         |

Legend: C=create, R=read, U=update, D=delete, A=approve, M=manage

`system` is the gate on the **System section** of the navigation — Lifecycles,
Users and Administration. `read` admits a user to the section at all; `manage`
additionally admits them to the admin console, which is every route under
`/admin`. Only Administrator and Power User carry it, which is why the three
roles below them see no System section and are redirected away from those URLs.
It was granted as `['read']` to every role until 2026-08-19, which made it no
gate at all: the sidebar offered those pages to a View Only account and they
403'd on arrival.

Note the pages behind it are _not_ gated by narrowing `users:read`,
`roles:read` or `workflows:read`. Those stay readable by every role on purpose
— approver and assignee pickers, program team management and item state
resolution all read them from ordinary pages, so tightening them would have
broken non-System features.

`programs:manage` is special: it is the **cross-program-authority grant**.
`AccessControlService.hasCrossProgramAccess()` keys the program-membership
bypass on it, so any role carrying it — built-in or custom — sees and manages
every program. Grant it only to roles that should function as top-level
administrators.

> **History**: earlier versions shipped a sixth role, `Global Admin`, from an
> abandoned multi-tenant design; the bypass was keyed to that literal role
> name. It has been merged into Administrator and the bypass re-keyed onto
> `programs:manage`. Deployments seeded with the old role need no migration —
> its stored permissions include `programs:manage`, so the permission check
> matches the same users the name check did.

### Optional Package Permissions

[Optional packages](../development/adding-packages.md) reuse the existing
resource types rather than introducing their own — a package changes what an
instance _has_, not how permissions are modeled. Entitlement is checked
independently of RBAC: a user with the right permission on an unlicensed
instance still gets a 403 with code `PACKAGE_NOT_LICENSED`.

Endpoints added by the [Advanced Auditing](../features/advanced-auditing.md)
package:

| Endpoint                                      | Permission           | Notes                                          |
| --------------------------------------------- | -------------------- | ---------------------------------------------- |
| `GET /api/v1/packages`                        | Authenticated        | Entitlement listing; no specific permission    |
| `GET /api/v1/signatures/capability`           | Authenticated        | Reports the caller's own signing options       |
| `GET /api/v1/signatures/chain/:scope`         | `change_orders.read` | Signature manifest for a workflow instance     |
| `POST /api/v1/signatures/chain/:scope/verify` | `system.read`        | Chain integrity verification — an audit action |

Signing itself is gated by the approval permission (`change_orders.update`) plus
the signer's own credential. RBAC decides _who may approve_; the signature
decides _who actually did_, and the two are recorded separately.

### How Permission Checks Work

The `PermissionService` (singleton at `packages/core/src/lib/auth/permission-service.ts`) handles all permission checks:

1. **Query user roles**: Look up all roles assigned to the user via the `user_roles` join table
2. **Check each role**: For each role, examine its `permissions` JSONB to see if the requested resource-action pair is present
3. **Union logic**: If **any** role grants the permission, access is allowed
4. **`manage` action**: If a role grants `manage` on a resource, it implicitly grants all other actions on that resource

Permission checks are cached in memory for 5 minutes per user-resource-action combination. The cache is cleared when a user's roles are reassigned.

### API Route Permission Enforcement

API routes declare their permission requirements in the `apiHandler()` options:

```typescript
// Require specific permission
GET: apiHandler({ permission: ['parts', 'read'] }, async ({ params }) => { ... })

// Require authentication only (no specific permission)
GET: apiHandler({}, async ({ params }) => { ... })

// Public endpoint (no auth required)
GET: apiHandler({ public: true }, async ({ params }) => { ... })
```

Some admin endpoints use `requireRole(request, 'Administrator')` instead, which checks for an exact role name rather than a resource-action permission.

A declared tuple has to be one some role in `ROLE_DEFINITIONS` grants. `npm run permissions:check` (CI's Lint job) fails on one that none does — such a route answers 403 to everyone, the Administrator included, which is indistinguishable from correct refusal and so shows up in no monitoring. `npm run permissions:check -- --audience` prints every declared tuple with the roles it admits, which is the reviewable form of the opposite question: whether a route is charging a _wider_ audience than intended.

### Database Storage Format

Permissions are stored in the `roles.permissions` JSONB column as a map of resource to action arrays:

```json
{
  "parts": ["create", "read", "update", "delete"],
  "documents": ["create", "read", "update"],
  "change_orders": ["read"],
  "system": ["read"]
}
```

## Program-Based Access Control

Programs are the primary permission boundary in Cascadia. Users can only see data belonging to programs they are members of.

### Program Membership

The `program_members` table tracks which users belong to which programs:

| Column               | Type        | Description                                                              |
| -------------------- | ----------- | ------------------------------------------------------------------------ |
| `program_id`         | UUID        | The program                                                              |
| `user_id`            | UUID        | The user                                                                 |
| `role`               | VARCHAR(50) | Program-level role: `admin`, `lead`, `engineer`, `viewer`                |
| `can_create_eco`     | BOOLEAN     | Can create ECOs in this program (default: true)                          |
| `can_approve_eco`    | BOOLEAN     | Can approve ECOs in this program (default: false)                        |
| `can_manage_designs` | BOOLEAN     | Can create, update, and archive designs in this program (default: false) |
| `joined_at`          | TIMESTAMPTZ | When the user was added                                                  |
| `invited_by`         | UUID        | Who invited this user                                                    |

A user-program pair is unique (enforced by a database constraint).

### Managing Membership

The program's team is managed on the program page's **Team** tab, backed by
`/api/v1/programs/:id/members`:

| Action              | Who may do it                                                                       |
| ------------------- | ----------------------------------------------------------------------------------- |
| List members        | Any member of the program; `programs:manage` or `programs:update`                   |
| Add a member        | Program `admin` or `lead` (a lead cannot grant the `admin` role); `programs:manage` |
| Update role / flags | Program `admin`; `programs:manage`                                                  |
| Remove a member     | Program `admin`; `programs:manage`                                                  |

Member payloads are strictly validated: the role must be one of the four
program roles, and unknown keys are rejected (the row-identity columns —
`userId`, `programId`, `joinedAt`, `invitedBy` — are never writable through
the API). A program can never lose its last `admin`, whether by removing or
by demoting them. Changing a member's role re-baselines the three permission
flags to the new role's defaults; flags passed explicitly in the same request
win over those defaults.

### Program-Level Roles

Within a program, users have one of four roles that control fine-grained permissions:

| Program Role | `can_create_eco` | `can_approve_eco` | `can_manage_designs` |
| ------------ | ---------------- | ----------------- | -------------------- |
| `admin`      | true             | true              | true                 |
| `lead`       | true             | true              | false                |
| `engineer`   | true             | false             | false                |
| `viewer`     | false            | false             | false                |

These defaults are assigned automatically when a user is added to a program. The boolean flags can be individually overridden for fine-grained control.

The flags are enforced at the API layer:

- `can_create_eco` — gates creating a ChangeOrder item in a design that
  belongs to the program (`POST /api/v1/items`)
- `can_approve_eco` — gates submitting approval votes on a change order in
  the program (`POST /api/v1/change-orders/:id/approvals`), in addition to
  whatever the workflow's approval requirements say
- `can_manage_designs` — gates creating, updating, and archiving designs in
  the program

Cross-program authority (`programs:manage`) bypasses all three, like every other program-level check.

### Program Isolation

The `AccessControlService` (`packages/core/src/lib/auth/AccessControlService.ts`) enforces program isolation:

- `canAccessProgram(userId, programId)` -- Checks if the user is a member of the program
- `getAccessiblePrograms(userId)` -- Returns only programs the user belongs to
- `getAccessibleProgramIds(userId)` -- Returns program IDs for query filtering (returns `null` for cross-program authority, meaning "all programs")

When listing items, designs, or other program-scoped data, the system filters results to only include data from the user's accessible programs.

Program detail reads (`GET /api/v1/programs/:id` and its `/graph` and
`/members` sub-resources) require membership, the cross-program bypass, or
the RBAC `programs:update` grant (write-implies-read, for custom roles that
may edit programs without holding the full bypass). The RBAC `programs:read`
permission alone is deliberately **not** sufficient — every built-in role
carries it, so treating it as a fallback would expose any program's metadata
(customer, contract number) to any authenticated user who guessed or
obtained an ID. The program _list_ remains membership-scoped for everyone
without cross-program authority.

### Cross-Program Bypass

Users whose roles carry `programs:manage` — the built-in Administrator role,
or any custom role granted it — bypass all program-based access checks:

- See all programs and their data
- Access all designs regardless of program membership
- The `AccessControlService.hasCrossProgramAccess()` check is performed first in every access check method

## Design-Level Access

Designs inherit access from their parent program, with special handling for global libraries:

### Access Rules

1. **Cross-program authority** (`programs:manage`): Can access all designs
2. **Global libraries** (designs with `programId = null` and `designType = 'Library'`): Accessible to all authenticated users
3. **Unassigned designs** (designs with `programId = null`): Accessible to all authenticated users (allows newly created designs to be visible before program assignment)
4. **Program-assigned designs**: Requires membership in the design's program

### Access Check Functions

Two convenience functions in `packages/core/src/lib/auth/access.ts` enforce design and branch access:

- `requireDesignAccess(userId, designId)` -- Throws `PermissionDeniedError` if the user cannot access the design
- `requireBranchAccess(userId, branchId)` -- Looks up the branch's design, then checks design access. Returns the branch object for convenience.

These functions are used by API routes handling design and branch operations.

## Runtime Permission Configuration

Permissions can be reconfigured at runtime without code changes using the item type configuration system.

### Runtime Permission Overrides

The `RuntimeItemTypeConfig` includes an optional `permissions` field:

```json
{
  "itemType": "Part",
  "config": {
    "permissions": {
      "create": ["Engineer", "Administrator"],
      "read": ["*"],
      "update": ["Engineer", "Administrator"],
      "delete": ["Administrator"]
    }
  }
}
```

These runtime permissions are stored in the `item_type_configs` table and merged with code-defined defaults at startup. Runtime values take precedence.

**API endpoint**: `POST /api/v1/admin/item-type-configs`

**Role required**: Administrator

See [System Settings](./system-settings.md) for complete documentation of the runtime configuration system.

### Reloading Configuration

After changing runtime permissions:

1. The API automatically calls `ItemTypeRegistry.reload()` on the instance that made the change
2. In multi-instance deployments, call `POST /api/v1/admin/reload-config` on each instance to pick up changes

## Troubleshooting

### User cannot access a program

1. Verify the user is a member of the program: check `program_members` for a matching `user_id` and `program_id`
2. Check that the user's account is active (`users.active = true`)
3. Verify the user has a role that grants `read` permission on the resource they are trying to access

### User gets 403 Forbidden on admin endpoints

Most admin endpoints require `system:manage` (some import endpoints check the `Administrator` role name via `requireRole(request, 'Administrator')`). Verify the user has the `Administrator` role assigned.

### Permission changes not taking effect

The `PermissionService` caches permission checks for 5 minutes. After changing a user's roles:

1. The cache is automatically cleared for that user when `UserService.assignRoles()` is called
2. If the user still sees stale permissions, they can log out and back in to force a cache reset
3. For system-wide cache issues, restart the application server

### Checking effective permissions

To see all permissions for a user (aggregated from all their roles), use the `PermissionService`:

```typescript
const permissions = await permissionService.getUserPermissions(userId)
// Returns: { parts: ['create', 'read', 'update'], documents: ['read'], ... }
```
