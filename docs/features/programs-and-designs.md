# Programs and Designs

Cascadia PLM organizes engineering data into a clear hierarchy: **Organization > Program > Design > Items**. Programs are the top-level permission boundary, designs contain versioned engineering data (parts, documents, requirements), and items live within designs on branches tracked by commits.

This document covers how programs and designs work, how access is controlled, and how cross-design references link data across organizational boundaries.

---

## Organizational Hierarchy

```
Organization (implicit, single-tenant)
  |
  +-- Program (permission boundary, e.g. "F-35 Joint Strike Fighter")
  |     |
  |     +-- Design (version container, e.g. "F-35A EBOM")
  |     |     |
  |     |     +-- Branch: main (default)
  |     |     +-- Branch: eco/ECO-2024-001
  |     |     +-- Items (Parts, Documents, Requirements, etc.)
  |     |
  |     +-- Design (e.g. "F-35B EBOM")
  |     +-- Design Family (container grouping related designs)
  |
  +-- Program (e.g. "Widget Product Line")
  |
  +-- Standard Library (global, no program -- accessible to all users)
  +-- Unassigned Designs (no program -- accessible to all authenticated users)
```

**Key rules:**

- A user must be a **member** of a program to access its designs and items.
- Users with **cross-program authority** (the RBAC `programs:manage` permission — the built-in Administrator role) bypass all program membership checks.
- **Global Libraries** (designType = `Library`, no program) are readable by all authenticated users.
- **Unassigned designs** (designType = `Engineering`, no program) are accessible to all authenticated users until assigned to a program.

---

## Programs

Programs are the top-level organizational unit and the primary permission boundary in Cascadia. They typically correspond to contracts, product lines, or major engineering efforts.

### Data Model

| Field            | Type         | Description                                                              |
| ---------------- | ------------ | ------------------------------------------------------------------------ |
| `id`             | UUID         | Primary key                                                              |
| `name`           | varchar(200) | Display name                                                             |
| `code`           | varchar(50)  | Unique identifier (uppercase alphanumeric with hyphens, e.g. `PWR-CART`) |
| `description`    | text         | Optional description                                                     |
| `contractNumber` | varchar(100) | Customer contract number                                                 |
| `customer`       | varchar(200) | Customer name                                                            |
| `startDate`      | timestamp    | Program start date                                                       |
| `targetEndDate`  | timestamp    | Target completion date                                                   |
| `status`         | varchar(50)  | One of: `Active`, `On Hold`, `Completed`, `Cancelled`                    |
| `settings`       | jsonb        | Program-level settings (approval workflow, ECO number format)            |
| `attributes`     | jsonb        | Flexible custom attributes (GIN-indexed for fast queries)                |

Program codes are **system-wide unique**. The code format is enforced as `^[A-Z0-9-]+$` (uppercase letters, digits, hyphens only).

### Program CRUD

| Operation                | Endpoint                      | Permission                                                           |
| ------------------------ | ----------------------------- | -------------------------------------------------------------------- |
| List accessible programs | `GET /api/v1/programs`        | Authenticated (returns only user's programs; Administrator sees all) |
| Create program           | `POST /api/v1/programs`       | `programs:create` permission                                         |
| Get program              | `GET /api/v1/programs/:id`    | Program member, `programs:manage`, or `programs:update`              |
| Update program           | `PUT /api/v1/programs/:id`    | Program admin or `programs:update` permission                        |
| Delete program           | `DELETE /api/v1/programs/:id` | Program admin or `programs:delete` permission                        |

When a program is created, the creator is automatically added as an **admin** member with full permissions.

### Program Status Lifecycle

Programs support four statuses:

- **Active** (default) -- The program is actively accepting work.
- **On Hold** -- Work is paused; data is preserved.
- **Completed** -- The program has concluded.
- **Cancelled** -- The program was cancelled.

Status is a simple string field without a formal state machine. Any admin can set any status directly.

### Program Search

Programs support server-side search with:

- **Global search** across code, name, description, and customer fields (ILIKE).
- **Column-specific filters** with text matching (ILIKE) or multi-select (IN) for status.
- **Sorting** by any visible column with configurable direction.
- **Pagination** with limit/offset.
- **Access control** filtering -- non-admin users only see programs they belong to.

---

## Program Membership

Access to a program's data is controlled through the `program_members` table. Each membership record links a user to a program with a role and fine-grained permission flags.

### Roles

| Role       | Default Permissions                     | Intended Use                                         |
| ---------- | --------------------------------------- | ---------------------------------------------------- |
| `admin`    | Create ECO, Approve ECO, Manage Designs | Program managers and leads with full control         |
| `lead`     | Create ECO, Approve ECO                 | Engineering leads who review and approve changes     |
| `engineer` | Create ECO                              | Working engineers who create and modify items        |
| `viewer`   | None (read-only)                        | Stakeholders who need visibility without edit access |

### Permission Flags

Each membership has three boolean permission flags that override role defaults when needed:

| Flag               | Description                                               |
| ------------------ | --------------------------------------------------------- |
| `canCreateEco`     | Can create Engineering Change Orders in this program      |
| `canApproveEco`    | Can approve ECOs for release                              |
| `canManageDesigns` | Can create, update, and delete designs within the program |

Default values are set based on role (see the table above), but can be overridden per-member for fine-grained control.

### Membership API

| Operation     | Endpoint                                      | Who Can Do It             |
| ------------- | --------------------------------------------- | ------------------------- |
| List members  | `GET /api/v1/programs/:id/members`            | Any program member        |
| Add member    | `POST /api/v1/programs/:id/members`           | Program `admin` or `lead` |
| Update member | `PUT /api/v1/programs/:id/members/:userId`    | Program `admin` only      |
| Remove member | `DELETE /api/v1/programs/:id/members/:userId` | Program `admin` only      |

**Safety rule:** The last admin cannot be removed from a program. Attempting to do so returns a validation error.

### How Permissions Cascade

Permissions flow downward through the hierarchy:

1. **Cross-program authority** (`programs:manage`, the Administrator role) -- Bypasses all program membership checks. Can access all programs, all designs, all items.
2. **Program membership** -- Required to access any design in a program. The membership role determines what actions are available.
3. **Design access** -- Checked via `requireDesignAccess()`. If a design has a `programId`, the user must be a member of that program (or hold cross-program authority).
4. **Design operations** -- Creating/updating/deleting designs within a program requires the `canManageDesigns` flag on the membership.
5. **ECO operations** -- Creating ECOs requires `canCreateEco`; approving requires `canApproveEco`; advancing one through its workflow requires reach to every design it links (see below).

#### A change order spans designs, so its reach rule has three tiers

A change order can list designs in more than one program, and the designs are
equal. How much of it you must reach depends on what you are doing to it -- the
rule is widest for reading and narrowest for acting:

| Doing this                                 | Requires                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reading** it                             | Reach to **any one** linked design. What you cannot reach is redacted, and `hasRestricted` says something was withheld -- never how much, or whose. |
| **Voting** on it                           | Membership with `canApproveEco` in **every** linked program. Approving half a change order is not a thing.                                          |
| **Advancing** it (submit, release, cancel) | Reach to **every** linked design.                                                                                                                   |

Advancing sits with voting rather than with reading because of what a final
transition does: a release merges every linked design's branch and assigns
permanent revision letters across all of them, and a cancel archives every
linked branch. Neither is undoable, and neither can be scoped down to the half
of the ECO you can see. The approval vote is not a fallback here -- a workflow
may legally declare a releasing transition requiring no votes at all -- so the
reach check is the gate. Submit is included because it locks the ECO's scope;
unlike the other two it is reversible, since rework back to an initial state
clears the lock again.

Designs outside any program (Library and Unassigned) are reachable by everyone,
so they never make an ECO unadvanceable. Cross-program authority bypasses all
three tiers. A partial-reach caller who needs to advance an ECO has two
remedies, both immediate: be added to the other program, or have someone with
cross-program authority do it.

```
programs:manage? ──yes──> Full access
       |
       no
       |
       v
Design has programId? ──no──> Accessible (Library or Unassigned)
       |
       yes
       |
       v
User is program member? ──no──> Access denied
       |
       yes
       |
       v
Check role + permission flags for specific operations
```

---

## Program Dashboard

The program history graph endpoint (`GET /api/v1/programs/:id/history/graph`) provides a visual commit history across all designs within a program. This powers the program-level history view, showing:

- Commits across all designs in the program, organized by design column.
- ECO branch activity, merge commits, and tag/baseline creation.
- Cross-design ECO links where a single ECO affects items in multiple designs.
- Commit consolidation to collapse rapid sequences of edits into summary nodes.

Program-level statistics (item counts, ECO counts, design counts) are computed on-demand by querying designs associated with the program.

---

## Designs

Designs are version containers that hold engineering items. Each design has its own branch history, starting with a `main` branch and an initial commit created automatically.

### Data Model

| Field                 | Type               | Description                                                 |
| --------------------- | ------------------ | ----------------------------------------------------------- |
| `id`                  | UUID               | Primary key                                                 |
| `programId`           | UUID (nullable)    | Owning program (null for libraries and unassigned designs)  |
| `name`                | varchar(200)       | Display name                                                |
| `code`                | varchar(50)        | System-wide unique identifier (e.g. `PWR-CART-EBOM`)        |
| `description`         | text               | Optional description                                        |
| `designType`          | varchar(50)        | One of: `Engineering`, `Library`, `Family`, `Manufacturing` |
| `parentDesignId`      | UUID (nullable)    | Parent family design (for family hierarchy)                 |
| `cloneSourceDesignId` | UUID (nullable)    | Source design when created via clone                        |
| `sourceDesignId`      | UUID (nullable)    | Source engineering design (for Manufacturing designs)       |
| `sourceTagId`         | UUID (nullable)    | Specific tag used as derivation point                       |
| `sourceCommitId`      | UUID (nullable)    | Specific commit used as derivation point                    |
| `plannedQuantity`     | integer (nullable) | Planning info                                               |
| `defaultBranchId`     | UUID (nullable)    | Points to the main branch                                   |
| `isArchived`          | boolean            | Soft delete flag                                            |
| `sysmlProjectId`      | UUID (nullable)    | External SysML tool sync                                    |
| `attributes`          | jsonb              | Custom attributes (GIN-indexed)                             |

### Design Types

| Type            | Description                                        | Has Branches? | Can Be Parent? |
| --------------- | -------------------------------------------------- | ------------- | -------------- |
| `Engineering`   | Standard engineering design containing EBOM        | Yes           | No             |
| `Library`       | Standard Library, globally accessible to all users | Yes           | No             |
| `Family`        | Container for grouping related designs (no items)  | No            | Yes            |
| `Manufacturing` | MBOM design derived from an Engineering design     | Yes           | No             |

### Design CRUD

| Operation      | Endpoint                     | Permission                                                         |
| -------------- | ---------------------------- | ------------------------------------------------------------------ |
| List designs   | `GET /api/v1/designs`        | Authenticated (filtered by program access)                         |
| Create design  | `POST /api/v1/designs`       | `canManageDesigns` in target program, or `designs:create` globally |
| Get design     | `GET /api/v1/designs/:id`    | Program member or cross-program authority                          |
| Update design  | `PUT /api/v1/designs/:id`    | `canManageDesigns` or `designs:update`                             |
| Archive design | `DELETE /api/v1/designs/:id` | `canManageDesigns` or `designs:delete` (soft delete)               |

**On creation**, Engineering, Library, and Manufacturing designs automatically get:

1. A `main` branch.
2. An initial commit on that branch.
3. `defaultBranchId` set to the main branch.

**Family designs** do not get branches or commits -- they are purely containers.

**The Standard Library** (`code: STD-LIB`) is a special Library design with no program association. It is accessible to all authenticated users and cannot be archived.

### Design Listing with Access Control

The `GET /api/v1/designs` endpoint returns designs filtered by the user's access:

- **Administrator** (cross-program authority): Sees all non-archived designs.
- **Regular user**: Sees designs from their programs, plus global libraries, plus unassigned designs.
- **Query parameters**: `programId`, `designType`, `includeArchived`, `includeHierarchy`.

When `includeHierarchy=true`, the response nests child designs under their Family parents, providing a tree structure.

---

## Design Families

Family designs are containers that group related Engineering designs. They follow parent-child hierarchy rules:

- Only `Family` type designs can be parents.
- Families cannot have parents themselves (no nested families).
- Parent and child must be in the same program (or both unassigned).
- Children cannot be `Family` type.

### Family API

| Operation              | Endpoint                                          | Description                          |
| ---------------------- | ------------------------------------------------- | ------------------------------------ |
| Get available families | `GET /api/v1/designs/families?programId=...`      | List families in a program           |
| Get family members     | `GET /api/v1/designs/:id/members`                 | List child designs of a family       |
| Add design to family   | `POST /api/v1/designs/:id/members`                | Set parentDesignId on a child design |
| Remove from family     | `DELETE /api/v1/designs/:id/members?designId=...` | Clear parentDesignId                 |

Family members are returned with enriched data: item count, release status (has any Released items), and latest tag name.

---

## Design Status and Protection

Each design has a **protection status** that determines how items can be modified.

### Protection Phases

| Phase            | Condition                         | Main Branch | Allowed Operations                                                               |
| ---------------- | --------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| **Pre-Release**  | No Released items in the design   | Unprotected | Edit items directly on main, create workspace branches                           |
| **Post-Release** | At least one Released item exists | Protected   | Must use ECO branches for changes; workspace and release branches also available |

The status endpoint:

```
GET /api/v1/designs/:id/status
```

Returns:

```json
{
  "protection": {
    "designId": "...",
    "phase": "post-release",
    "hasReleasedItems": true,
    "releasedItemCount": 42,
    "draftItemCount": 3,
    "totalItemCount": 45,
    "isMainBranchProtected": true
  },
  "branchOptions": {
    "phase": "post-release",
    "canEditMainDirectly": false,
    "availableBranchTypes": ["eco", "workspace", "release"]
  }
}
```

The UI displays this as a **DesignPhaseIndicator** badge:

- **Pre-Release** (unlocked icon, warning color) -- "Create and edit items directly on main branch."
- **Change Control** (locked icon, success color) -- "Main branch is protected. Use ECO branches to make changes."

### Branch Types

| Type        | Purpose                                            | When Available          |
| ----------- | -------------------------------------------------- | ----------------------- |
| `main`      | Default branch, created with the design            | Always (one per design) |
| `eco`       | Isolated workspace for an Engineering Change Order | Always                  |
| `workspace` | Private development branch (informal, no ECO)      | Both phases             |
| `release`   | Snapshot from a specific tag/baseline              | Post-release only       |

---

## Design Statistics

Design-level statistics are available through several endpoints:

### Item Counts

`GET /api/v1/designs/:id/items` returns items with total count. Supports filtering by type, state, and search. Also supports historical views via `tag` or `commit` query parameters for point-in-time queries.

### ECO Activity

`GET /api/v1/designs/:id/ecos` lists Engineering Change Orders affecting the design. For each ECO, the response includes:

- ECO item number, name, and state.
- Reason for change.
- Count of affected items.
- Owner information.
- Timestamps (created, submitted).

Supports filtering by ECO status (Draft, In Review, Approved, Released, etc.).

### Branch Listing

`GET /api/v1/designs/:id/branches` returns all branches for the design with optional `includeArchived` filter. Each branch includes its type, head/base commit IDs, and lock/archive status.

### Tags and Baselines

`GET /api/v1/designs/:id/tags` lists named baselines for the design. Each tag points to a specific commit and has a type:

| Tag Type      | Description                                   |
| ------------- | --------------------------------------------- |
| `baseline`    | General-purpose snapshot                      |
| `release`     | Formal release point                          |
| `milestone`   | Project milestone (e.g., PDR, CDR)            |
| `eco-release` | Automatically created when an ECO is released |

Creating tags requires program `admin` or `lead` role (or cross-program authority).

---

## Clone Design

Cloning creates a new design by duplicating items as **usage copies** following the SysML v2 definition/usage pattern. Clones maintain traceability back to the original definitions.

### How It Works

1. User submits a clone request with a new code, name, and optional target program.
2. A background job (`design.clone`) is queued via RabbitMQ.
3. The job:
   - Creates the target design with `cloneSourceDesignId` pointing to the source.
   - For each item on the source's main branch, creates a **usage** in the target design.
   - Each usage's `usageOf` field points to the canonical **definition** (not the source's usage).
   - Field values are copied inline from the source, including any modifications.
   - All cloned items start at revision `-` and state `Draft`.
   - BOM relationships are copied with remapped IDs.
   - Vault file references are shared (not duplicated on disk).

### Item Number Suffixing

When `suffixItemNumbers: true`, cloned item numbers are suffixed with the target design code:

- `P-1001` becomes `P-1001-TARGET-CODE`
- If the source item already has a suffix from a previous clone (e.g. `P-1001-SOURCE-CODE`), the old suffix is replaced with the new one rather than double-suffixing.

### Clone API

```
POST /api/v1/designs/:id/clone
```

Request body:

```json
{
  "code": "NEW-DESIGN",
  "name": "New Design Name",
  "description": "Optional description",
  "programId": "uuid (optional, defaults to source program)",
  "suffixItemNumbers": true
}
```

Returns `202 Accepted` with a job ID for tracking progress.

**Restrictions:**

- Only `Engineering` designs can be cloned (not Family or Library).
- Read access to the source design is required.
- Create permission (`canManageDesigns`) in the target program is required.

---

## Cross-Design References

Cross-design references are lightweight, read-only links to items in other designs. Unlike usage copies (which duplicate items), cross-design references display external items in the BOM tree without creating new item records.

### How They Differ from Usage Copies

| Aspect                 | Usage Copy          | Cross-Design Reference                 |
| ---------------------- | ------------------- | -------------------------------------- |
| Creates new items      | Yes                 | No                                     |
| Editable independently | Yes                 | No (read-only)                         |
| Appears in BOM tree    | Yes (as local item) | Yes (marked as external)               |
| Tracks branch changes  | Via branchItems     | Via changeType on the reference record |
| Traceability           | `usageOf` field     | `referencedItemId` + `sourceDesignId`  |

### Branch Tracking

Cross-design references follow the same branch-tracking pattern as `branchItems`:

| `branchId`  | `changeType` | Meaning                                           |
| ----------- | ------------ | ------------------------------------------------- |
| `NULL`      | `NULL`       | On main (baseline)                                |
| branch UUID | `added`      | Added on this branch                              |
| branch UUID | `deleted`    | Removed on this branch (masks baseline reference) |

When an ECO is released, branch-specific references are merged:

- `added` references are promoted to main (branchId and changeType set to null).
- `deleted` references cause both the marker and the baseline reference to be physically deleted.

### Cross-Design Reference API

| Operation             | Endpoint                                                           | Method |
| --------------------- | ------------------------------------------------------------------ | ------ |
| List references       | `GET /api/v1/designs/:id/cross-references?branch=...`              | GET    |
| Create reference      | `PUT /api/v1/designs/:id/cross-references`                         | PUT    |
| Remove reference      | `DELETE /api/v1/designs/:id/cross-references?refId=...&branch=...` | DELETE |
| Pull in as usage copy | `POST /api/v1/designs/:id/cross-references`                        | POST   |

**Creating a reference** validates that:

- The referenced item exists.
- The referenced item belongs to a different design.

**Pulling in a reference** converts a cross-design reference to a usage copy:

1. The cross-design reference is removed (branch-aware).
2. A usage copy is created from the referenced item.
3. BOM relationships are remapped to the new usage copy.
4. Supports batch chain mode (`itemIds` array) for pulling in an entire ancestor chain at once.

### In the Design Structure Tree

Cross-design references appear in the BOM tree as additional root nodes marked with:

- `isCrossDesignRef: true`
- `crossReferenceId` for the reference record ID
- `designCode` and `designName` of the source design
- Full subtree expansion (children from the source design are recursively loaded)

---

## Design Structure API

The design structure endpoint returns the full hierarchical BOM tree for a design.

```
GET /api/v1/designs/:id/structure
```

### Query Parameters

| Parameter        | Type    | Default     | Description                                    |
| ---------------- | ------- | ----------- | ---------------------------------------------- |
| `branch`         | UUID    | main branch | View structure from a specific branch          |
| `tag`            | UUID    | (none)      | Historical view at a specific tag              |
| `commit`         | UUID    | (none)      | Historical view at a specific commit           |
| `expandExternal` | boolean | `true`      | Recursively expand children from other designs |

### Response Structure

```json
{
  "roots": [
    {
      "itemId": "uuid",
      "itemNumber": "P-1001",
      "name": "Top Assembly",
      "revision": "B",
      "state": "Released",
      "itemType": "Part",
      "children": [
        {
          "itemId": "uuid",
          "itemNumber": "P-1002",
          "name": "Sub-Assembly",
          "quantity": 2,
          "findNumber": 1,
          "relationshipId": "uuid",
          "children": [...]
        },
        {
          "itemId": "uuid",
          "itemNumber": "LIB-BOLT-M6",
          "name": "M6 Bolt",
          "isExternal": true,
          "designCode": "STD-LIB",
          "designName": "Standard Library"
        }
      ]
    },
    {
      "itemId": "uuid",
      "isCrossDesignRef": true,
      "crossReferenceId": "uuid",
      "designCode": "OTHER-DESIGN",
      "designName": "Other Design",
      "children": [...]
    }
  ],
  "orphans": [
    {
      "id": "uuid",
      "itemNumber": "DOC-001",
      "itemType": "Document",
      "state": "Draft"
    }
  ]
}
```

### How Roots and Orphans Are Determined

- **Roots**: Part-type items with `inDesignStructure=true` that have no parent BOM relationship, plus cross-design reference items.
- **Orphans**: Non-Part items (Documents, Requirements) and Parts with `inDesignStructure=false`. Child parts that have a parent are NOT orphans.

### ECO Branch Resolution

When viewing the structure on an ECO branch:

1. Items from the main branch are loaded first.
2. ECO branch items override main items where they share the same `masterId`.
3. BOM relationships are resolved through the `masterId` mapping, so working copies on the branch correctly appear in the tree.

### External Item Expansion

With `expandExternal=true` (default), the structure endpoint:

1. Finds BOM children that point to items in other designs.
2. Recursively follows those items' BOM trees (up to depth 10).
3. Marks external items with `isExternal: true` and includes the source design's code and name.

---

## Related Documentation

- [Change Orders](../api/change-orders.md) -- ECO workflow details
- [Versioning](./versioning.md) -- Branch, commit, and version resolution internals
- [Service Patterns](../../docs/development/service-patterns.md) -- How ProgramService and DesignService follow common patterns
- [Permissions](../admin/access-control.md) -- Role-based access control details
