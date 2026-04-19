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

Cascadia ships with six built-in roles. Each role is stored in the `roles` table with a `permissions` JSONB column containing the full permission matrix.

| Role          | Description                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Global Admin  | System-wide administrator. Bypasses all program-based access checks. Full access to all resources across all programs.             |
| Administrator | Full access within assigned programs. Can manage users, roles, workflows, and all item types. Cannot create programs.              |
| Power User    | Can create, read, update, and delete all item types. Can manage workflows. Read-only access to users, roles, programs, and system. |
| Approver      | Can read and update items, plus approve items and change orders. Cannot create or delete items.                                    |
| User          | Can create and update draft items. Read access to released items. Cannot delete items or approve change orders.                    |
| View Only     | Read-only access to all resources. Cannot create, edit, or delete anything.                                                        |

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

| Resource            | What it controls                   |
| ------------------- | ---------------------------------- |
| `parts`             | Part items                         |
| `documents`         | Document items                     |
| `change_orders`     | Engineering Change Orders          |
| `designs`           | Design containers                  |
| `requirements`      | Requirement items                  |
| `tasks`             | Task items                         |
| `work_instructions` | Work instruction items             |
| `work_orders`       | Work order items                   |
| `issues`            | Issue items                        |
| `workflows`         | Workflow definitions and instances |
| `users`             | User accounts                      |
| `roles`             | Role definitions                   |
| `programs`          | Program management                 |
| `reports`           | Report generation                  |
| `system`            | System settings and administration |

### Permission Matrix

The complete permission matrix for each role:

| Resource          | Global Admin | Administrator | Power User | Approver | User | View Only |
| ----------------- | ------------ | ------------- | ---------- | -------- | ---- | --------- |
| parts             | CRUDAM       | CRUDA         | CRUD       | RUA      | CRU  | R         |
| documents         | CRUDAM       | CRUDA         | CRUD       | RUA      | CRU  | R         |
| change_orders     | CRUDAM       | CRUDA         | CRUD       | RUA      | CR   | R         |
| designs           | CRUDM        | CRUD          | CRUD       | RU       | CRU  | R         |
| requirements      | CRUDAM       | CRUDA         | CRUD       | RUA      | CRU  | R         |
| tasks             | CRUDM        | CRUD          | CRUD       | RU       | CRU  | R         |
| work_instructions | CRUDM        | CRUD          | CRUD       | RUA      | CRU  | R         |
| work_orders       | CRUDM        | CRUD          | CRUD       | RUA      | CRU  | R         |
| issues            | CRUDAM       | CRUDA         | CRUD       | RUA      | CRU  | R         |
| workflows         | CRUDM        | CRUDM         | RM         | R        | R    | R         |
| users             | CRUDM        | CRUDM         | R          | R        | R    | R         |
| roles             | CRUDM        | CRUDM         | R          | R        | R    | R         |
| programs          | CRUDM        | RU            | R          | R        | R    | R         |
| reports           | CRUDM        | CRUD          | CRUD       | R        | R    | R         |
| system            | RM           | RM            | R          | R        | R    | R         |

Legend: C=create, R=read, U=update, D=delete, A=approve, M=manage

### How Permission Checks Work

The `PermissionService` (singleton at `src/lib/auth/permission-service.ts`) handles all permission checks:

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

| Column                | Type        | Description                                               |
| --------------------- | ----------- | --------------------------------------------------------- |
| `program_id`          | UUID        | The program                                               |
| `user_id`             | UUID        | The user                                                  |
| `role`                | VARCHAR(50) | Program-level role: `admin`, `lead`, `engineer`, `viewer` |
| `can_create_eco`      | BOOLEAN     | Can create ECOs in this program (default: true)           |
| `can_approve_eco`     | BOOLEAN     | Can approve ECOs in this program (default: false)         |
| `can_manage_products` | BOOLEAN     | Can manage products in this program (default: false)      |
| `joined_at`           | TIMESTAMPTZ | When the user was added                                   |
| `invited_by`          | UUID        | Who invited this user                                     |

A user-program pair is unique (enforced by a database constraint).

### Program-Level Roles

Within a program, users have one of four roles that control fine-grained permissions:

| Program Role | `can_create_eco` | `can_approve_eco` | `can_manage_products` |
| ------------ | ---------------- | ----------------- | --------------------- |
| `admin`      | true             | true              | true                  |
| `lead`       | true             | true              | false                 |
| `engineer`   | true             | false             | false                 |
| `viewer`     | false            | false             | false                 |

These defaults are assigned automatically when a user is added to a program. The boolean flags can be individually overridden for fine-grained control.

### Program Isolation

The `AccessControlService` (`src/lib/auth/AccessControlService.ts`) enforces program isolation:

- `canAccessProgram(userId, programId)` -- Checks if the user is a member of the program
- `getAccessiblePrograms(userId)` -- Returns only programs the user belongs to
- `getAccessibleProgramIds(userId)` -- Returns program IDs for query filtering (returns `null` for Global Admin, meaning "all programs")

When listing items, designs, or other program-scoped data, the system filters results to only include data from the user's accessible programs.

### Global Admin Bypass

Users with the **Global Admin** role bypass all program-based access checks. They can:

- See all programs and their data
- Access all designs regardless of program membership
- The `AccessControlService.isGlobalAdmin()` check is performed first in every access check method

## Design-Level Access

Designs inherit access from their parent program, with special handling for global libraries:

### Access Rules

1. **Global Admin**: Can access all designs
2. **Global libraries** (designs with `programId = null` and `designType = 'Library'`): Accessible to all authenticated users
3. **Unassigned designs** (designs with `programId = null`): Accessible to all authenticated users (allows newly created designs to be visible before program assignment)
4. **Program-assigned designs**: Requires membership in the design's program

### Access Check Functions

Two convenience functions in `src/lib/auth/access.ts` enforce design and branch access:

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

**API endpoint**: `POST /api/admin/item-type-configs`

**Role required**: Administrator

See `docs/runtime-configuration.md` for complete documentation of the runtime configuration system.

### Reloading Configuration

After changing runtime permissions:

1. The API automatically calls `ItemTypeRegistry.reload()` on the instance that made the change
2. In multi-instance deployments, call `POST /api/admin/reload-config` on each instance to pick up changes

## Troubleshooting

### User cannot access a program

1. Verify the user is a member of the program: check `program_members` for a matching `user_id` and `program_id`
2. Check that the user's account is active (`users.active = true`)
3. Verify the user has a role that grants `read` permission on the resource they are trying to access

### User gets 403 Forbidden on admin endpoints

Most admin endpoints require the `Administrator` role specifically (checked via `requireRole(request, 'Administrator')`). Verify the user has either the `Administrator` or `Global Admin` role assigned.

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
