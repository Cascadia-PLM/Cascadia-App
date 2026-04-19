# Change Management: ECO-as-Branch

Cascadia's change management system is modeled after Git's branching model. Every Engineering Change Order (ECO) creates an isolated branch where engineers make changes to items without affecting the released baseline on `main`. When the ECO is approved, the branch is merged back, revision letters are assigned, and items transition to their released states. This document covers the full system from schema to service layer.

---

## Table of Contents

1. [Overview](#overview)
2. [Change Order Types](#change-order-types)
3. [ECO Workflow](#eco-workflow)
4. [Change Actions](#change-actions)
5. [Creating an ECO](#creating-an-eco)
6. [Adding Affected Items](#adding-affected-items)
7. [Making Changes](#making-changes)
8. [Impact Analysis](#impact-analysis)
9. [Approval and Release](#approval-and-release)
10. [Conflict Detection](#conflict-detection)
11. [ECO Cancellation](#eco-cancellation)
12. [API Reference](#api-reference)
13. [Key Files](#key-files)

---

## Overview

Traditional PLM systems treat change management as a metadata workflow: you fill out a form, someone clicks "Approve," and item states update in place. Cascadia takes a fundamentally different approach inspired by version control.

**ECO-as-Branch** means:

- Each ECO gets one or more isolated branches (one per affected design).
- Engineers edit working copies of items on the branch, not the released originals.
- The released baseline on `main` is never touched until the ECO merges.
- Revision letters (A, B, C...) are assigned only at merge time, preventing collisions between parallel ECOs.
- After merge, the branch is archived for audit.

This gives you concurrent engineering by default. Two ECOs can modify different items in the same design simultaneously. Conflict detection catches the case where two ECOs touch the same item and the same field.

### Core Data Tables

| Table                         | Purpose                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `change_orders`               | ECO-specific fields (change type, priority, reason, timestamps)      |
| `change_order_affected_items` | Items included in the ECO with their change action                   |
| `change_order_designs`        | Links an ECO to each design it affects, with branch and merge status |
| `change_order_impacted_items` | Items discovered by impact analysis (not directly changed)           |
| `change_order_risks`          | Risks identified during impact assessment                            |
| `change_order_impact_reports` | Stored impact analysis reports                                       |
| `branches`                    | ECO branches (`branchType = 'eco'`) forked from main                 |
| `branch_items`                | Per-branch item overrides (working copies, change tracking)          |

Schema definitions: `src/lib/db/schema/items.ts` (lines 118-275).

---

## Change Order Types

Cascadia supports four change order types, defined in `src/lib/items/types/change-order.ts`:

| Type        | Name                       | Purpose                                                                                                |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ECO`       | Engineering Change Order   | Standard change to released items. Creates branch, requires approval, merges with revision assignment. |
| `ECN`       | Engineering Change Notice  | Notification of a change. Lighter process, same underlying mechanics.                                  |
| `MCO`       | Manufacturing Change Order | Manufacturing-specific change. Same branch workflow, different approval routing.                       |
| `Deviation` | Deviation                  | Temporary departure from released configuration. May not assign new revisions.                         |

All four types use the same `ChangeOrderService`, `ChangeOrderMergeService`, and branch infrastructure. The difference is in workflow routing: `ChangeOrderService.autoStartWorkflow()` looks up the workflow definition configured for each `changeType` in the ChangeOrder's `RuntimeItemTypeConfig`.

```typescript
// src/lib/items/services/ChangeOrderService.ts
static async autoStartWorkflow(
  changeOrderId: string,
  changeType: 'ECO' | 'ECN' | 'Deviation' | 'MCO',
  userId: string,
) {
  const config = ItemTypeRegistry.getRuntimeConfig('ChangeOrder')
  const workflowId = config.workflowsByChangeType[changeType]
  return this.startWorkflow(changeOrderId, workflowId, userId)
}
```

Each type can map to a different workflow definition (or share one). Administrators configure this in Admin > Item Types > ChangeOrder.

---

## ECO Workflow

The default ECO workflow has three states:

```
                Submit for Review          Approve
  +-------+    =================>    +-----------+    =============>    +----------+
  | Draft |                          | In Review |                     | Approved |
  +-------+    <=================    +-----------+                     +----------+
                  (reject back)                                         (isFinal)
```

### State Definitions

| State      | `isFinal` | Description                                                                                                  |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `Draft`    | No        | ECO is being prepared. Affected items can be added/removed. Items can be checked out and edited.             |
| `InReview` | No        | ECO is under review. Scope is locked (no new affected items). Editing continues on existing working copies.  |
| `Approved` | Yes       | ECO is approved. Triggers `close()` which merges branches to main, assigns revisions, and archives branches. |

### Scope Locking

When an ECO leaves the Draft state (transitions to InReview), the workflow instance's `scopeLocked` flag is set to `true`. This prevents:

- Adding new affected items (`ChangeOrderService.addAffectedItem()` checks `scopeLocked`)
- Checking out new items to the ECO (`ChangeOrderService.checkoutToEco()` checks `scopeLocked`)
- Adding new design associations

Existing working copies can still be edited while scope is locked. This separation ensures reviewers evaluate a fixed scope while engineers can continue refining the details.

### Flexible Workflow

Cascadia also ships a "Dynamic Change Order" workflow (`workflowType: 'flexible'`) with just two states: Start and Complete. Users can add custom review steps per-instance at runtime, tailoring the process to each change order's complexity.

### Workflow Transition Endpoint

All ECO state changes go through a single canonical endpoint:

```
POST /api/change-orders/:id/workflow/transition
Body: { toStateId: "Approved", comments: "LGTM" }
```

When the target state has `isFinal: true`, the endpoint:

1. Executes the workflow transition (validates guards, records history, fires lifecycle effects)
2. Calls `ChangeOrderService.close()` which triggers `ChangeOrderMergeService.merge()`
3. Returns the merge result including revisions assigned

There are no separate `/submit`, `/approve`, `/reject` endpoints. Everything flows through the transition endpoint.

---

## Change Actions

Change actions describe what the ECO intends to do to each affected item. They are defined in `src/lib/items/types/change-order.ts` and their state mappings live in lifecycle definitions (`src/lib/types/lifecycle.ts`).

### `release`

**Purpose**: First release of a new item (Draft -> Released).

- Validates: Item must be in `Draft` state.
- At merge: Sets state to `Released`, assigns initial revision letter (typically `A`).
- Use case: Releasing new parts created during initial design.

### `revise`

**Purpose**: Create a new revision of an already-released item.

- Validates: Item must be in `Released` state.
- At add-time: Creates a working copy on the ECO branch with a placeholder revision (`-{branchId8}`). The original stays on main unchanged.
- At merge: Marks old revision as `Superseded` (`isCurrent = false`), assigns next revision letter (A -> B, B -> C), sets working copy to `Released` and `isCurrent = true`.
- Use case: Changing the weight of a released part, updating a drawing.

The placeholder revision format (e.g., `-abc12345`) allows multiple ECOs to have working copies of the same item simultaneously without violating the unique constraint on `(item_number, revision)`.

### `obsolete`

**Purpose**: End-of-life an item (Released -> Obsolete).

- Validates: Item must be in `Released` state. If item is used in released assemblies, a replacement item ID is required.
- At merge: Sets state to `Obsolete`. Does not assign a new revision.
- Validation performs a recursive where-used query to check for active usage.

### `add`

**Purpose**: Add a new item to a BOM or design.

- No state validation (membership action).
- At merge: No state change. The item is created/tracked as part of the branch.
- Use case: Adding a new component to an existing assembly.

### `remove`

**Purpose**: Remove an item from a BOM or design.

- No state validation (membership action).
- At merge: No state change. Handled via relationship deletion.
- Use case: Removing an obsolete component from an assembly.

### `promote`

**Purpose**: Transition an item across lifecycle phase boundaries (e.g., Prototype -> Production).

- Validates: Item must be in the `fromState` configured in the promote mapping.
- At add-time: Calculates target revision based on the phase's revision scheme, including reset logic.
- At merge: Sets state to the target phase's state, optionally resets or increments revision per the phase configuration.
- Use case: Promoting a prototype part to production readiness.

### Lifecycle Configuration Example

```typescript
// From src/lib/types/lifecycle.ts
const partLifecycle: ChangeActionMappings = {
  release: {
    fromState: 'Draft',
    toState: 'Released',
    assignsRevision: true,
  },
  revise: {
    fromState: 'Released',
    newVersionState: 'Released',
    oldVersionState: 'Superseded',
    assignsRevision: true,
  },
  obsolete: {
    fromState: 'Released',
    toState: 'Obsolete',
    assignsRevision: false,
  },
}
```

---

## Creating an ECO

ECO creation is a two-phase process: first create the ChangeOrder item, then add affected items (which triggers branch creation).

### Step 1: Create the ChangeOrder Item

A ChangeOrder is an item type like Part or Document. It is created via `ItemService.create()` with `itemType: 'ChangeOrder'` and has additional fields in the `change_orders` extension table:

| Field               | Type                                   | Purpose                                   |
| ------------------- | -------------------------------------- | ----------------------------------------- |
| `changeType`        | `ECO` / `ECN` / `Deviation` / `MCO`    | Determines workflow routing               |
| `priority`          | `low` / `medium` / `high` / `critical` | Priority level                            |
| `reasonForChange`   | text                                   | Why the change is needed                  |
| `impactDescription` | text                                   | Expected impact                           |
| `isBaseline`        | boolean                                | Whether to create a design tag on release |
| `baselineName`      | string                                 | Name for the baseline tag                 |

### Step 2: Auto-Start Workflow

After creation, `ChangeOrderService.autoStartWorkflow()` is called. It looks up the workflow definition for the given `changeType` from the ChangeOrder's runtime configuration and starts a workflow instance. The ECO starts in `Draft` state.

### Step 3: Branch Creation (Lazy)

Branches are **not** created when the ECO is created. They are created lazily when the first affected item is added that belongs to a design. This is handled by `ChangeOrderService.ensureDesignAssociation()`:

1. Checks if a `change_order_designs` record exists for this ECO + design pair.
2. If not, calls `BranchService.getOrCreateEcoBranch(designId, changeOrderId, userId)`.
3. `getOrCreateEcoBranch` creates a branch named `eco/{ECO-number}` forked from main's HEAD.
4. Creates an initial "ChangeOrder created" commit on the branch.
5. Inserts the `change_order_designs` record linking the ECO to the design with the new branch ID.

If the ECO affects items across multiple designs, a separate branch is created for each design.

```
After ECO creation + first affected item:

Design "Motor Assembly"
  main:         [...C5 (Released items)]
                 /
  eco/ECO-001: C5  (forked from main HEAD)
                └── "ChangeOrder ECO-001 created" commit
```

---

## Adding Affected Items

Adding an affected item is the core operation that connects an ECO to the items it will change. This is handled by `ChangeOrderService.addAffectedItem()`.

### Flow

1. **Scope lock check**: If the workflow instance has `scopeLocked = true`, the operation is rejected.

2. **Lifecycle validation**: `LifecycleService.canApplyAction()` validates the change action is valid for the item's current state (e.g., cannot `release` an already-Released item).

3. **Design association**: If the item belongs to a design, `ensureDesignAssociation()` creates the ECO branch (or reuses an existing one).

4. **Cross-design association**: `associateRelatedDesigns()` finds all other designs that contain usage copies of the same definition item and creates `change_order_designs` records for them. This ensures cross-design impact is visible.

5. **Working copy creation** (for `revise` action on Released items):
   - Creates a new `items` row with `state = 'Draft'`, `revision = -{branchId8}` (placeholder).
   - Copies type-specific data (parts, documents, requirements tables).
   - Creates a `branch_items` record with `changeType = 'modified'`, `baseItemId = sourceItem.id`.
   - Creates a commit recording the revision start.

6. **Target revision calculation** (for `promote` action):
   - Looks up the lifecycle's promote mapping.
   - Determines if the phase boundary resets revision numbering.
   - Calculates the target revision from the appropriate scheme.

7. **Record creation**: Inserts into `change_order_affected_items` with:
   - `changeOrderId`, `affectedItemId`, `affectedItemMasterId`
   - `changeAction` (release, revise, obsolete, add, remove, promote)
   - `currentState`, `currentRevision` (snapshot of item state at add-time)
   - `targetState`, `targetRevision` (calculated targets)
   - `workingCopyId` (if a working copy was created for revise)

### Batch Operations

`addAffectedItemsBatch()` wraps multiple additions in a single transaction with deduplication. Items already present in the ECO are skipped (idempotent).

---

## Making Changes

Once items are on an ECO branch, engineers edit them through the checkout/save/checkin cycle.

### Checkout

`CheckoutService.checkout(itemMasterId, branchId, userId)`:

1. Validates the branch is not `main`, not locked, not archived.
2. If a `branch_items` record exists and is already checked out by the same user, returns it (idempotent).
3. If checked out by another user, throws an error (exclusive lock).
4. If no `branch_items` record exists, creates one pointing to the current released version.
5. Sets `checkedOutBy = userId` and `checkedOutAt = now`.

### Save Changes

`CheckoutService.saveChanges(branchId, itemId, changes, commitMessage, userId)`:

1. Validates the user has the item checked out on this branch.
2. Creates a new `items` row with the merged changes (new `id`, same `masterId`, `revision = 'DRAFT'`).
3. Computes field-level differences via `computeFieldChanges()`.
4. Updates `branch_items.currentItemId` to the new item row.
5. Sets `branch_items.changeType` to `'modified'` (or keeps `'added'` for new items).
6. Creates a commit with `itemFieldChanges` for full audit trail.

Each save is a commit. The branch accumulates a linear commit history, just like Git.

### Check In

`CheckoutService.checkin(itemMasterId, branchId, userId)`:

- Clears `checkedOutBy` and `checkedOutAt` on the `branch_items` record.
- The working copy remains on the branch; only the lock is released.

### Cancel Checkout

`CheckoutService.cancelCheckout(itemMasterId, branchId, userId)`:

- If no changes were made (`changeType = null`), removes the `branch_items` record entirely.
- If changes exist, just clears the checkout lock.

### Creating New Items on a Branch

`CheckoutService.createOnBranch()`:

- Generates a new `masterId` and creates the item with `revision = 'DRAFT'`, `state = 'Draft'`.
- Creates a `branch_items` record with `changeType = 'added'` and `baseItemId = null`.
- Creates a commit recording the addition.

### Deleting Items on a Branch

`CheckoutService.deleteOnBranch()`:

- If the item was added on this branch (`changeType = 'added'`), removes the `branch_items` record.
- Otherwise, sets `branch_items.changeType = 'deleted'`.
- Creates a commit recording the deletion.

---

## Impact Analysis

Impact analysis discovers the ripple effects of changing items within and across designs. It is performed by `ImpactAssessmentService.analyzeImpact()` in `src/lib/items/services/ImpactAssessmentService.ts`.

### Where-Used Traversal

For each affected item, a recursive CTE query walks the BOM relationships upward:

```sql
WITH RECURSIVE where_used AS (
  -- Base: direct parents via BOM relationships
  SELECT r.source_id, i.*, 1 as depth, ARRAY[...] as path
  FROM item_relationships r JOIN items i ON ...
  WHERE r.target_id = :itemId AND r.relationship_type = 'BOM' AND i.is_current = true

  UNION ALL

  -- Recursive: parents of parents
  SELECT r.source_id, i.*, wu.depth + 1, wu.path || r.source_id
  FROM item_relationships r JOIN items i ON ... JOIN where_used wu ON ...
  WHERE wu.depth < :maxDepth AND NOT r.source_id = ANY(wu.path)
)
SELECT wu.*, d.code, d.name FROM where_used wu LEFT JOIN designs d ON ...
```

Key properties:

- **Max depth**: Configurable, defaults to 15 levels.
- **Cycle prevention**: The `path` array prevents infinite loops in circular BOMs.
- **Design context**: Joins to the `designs` table to include `designCode` and `designName` for cross-design visibility.

### Cross-Design Impact

`buildCrossDesignImpacts()` identifies when affected items have usage copies in external designs. It follows the definition-usage chain:

1. If the affected item is a usage copy (`usageOf` is set), the definition is the `usageOf` target.
2. If the affected item is a definition (no `usageOf`), look for all items with `usageOf = item.id`.
3. Group impacted items by their design, excluding the ECO's own designs.

The result includes relationship types: `bom_where_used`, `definition_instance`, `definition_source`, `usage_cousin`, `cross_design_ref`.

### Deduplication

The where-used results are deduplicated by `masterId:depth`. When the same logical part appears at the same BOM depth from multiple affected items, it is consolidated into one row with an `affectedByCount` and a list of `sourceAffectedItems`.

### Risk Identification

`identifyRisks()` evaluates the impact data and generates risk records:

| Condition                  | Risk Category  | Severity |
| -------------------------- | -------------- | -------- |
| Where-used count > 50      | `production`   | `high`   |
| BOM depth > 7              | `production`   | `medium` |
| Released items affected    | `quality`      | varies   |
| Cross-design impacts found | `cross-design` | varies   |

Critical risks with `requiresAcknowledgement = true` must be explicitly acknowledged before the ECO can be approved (`ChangeOrderService.approve()` checks for unacknowledged critical risks).

### Stored Results

Impact analysis results are persisted in three tables:

- `change_order_impacted_items`: Each discovered item with type, severity, depth, and path.
- `change_order_risks`: Identified risks with category, severity, mitigation, and acknowledgement status.
- `change_order_impact_reports`: The full report as JSONB with generation timing.

The `change_orders` table is updated with `impactAssessmentStatus = 'completed'` and the calculated `riskLevel`.

---

## Approval and Release

When an ECO transitions to its final state (e.g., Approved), the transition endpoint triggers the release process.

### Pre-Approval Checks

`ChangeOrderService.approve()` performs these checks before allowing the transition:

1. **Critical risk acknowledgement**: All risks with `severity = 'critical'` and `requiresAcknowledgement = true` must have `acknowledgedBy` set.

2. **Blocking conflict check**: `ConflictDetectionService.detectConflictsForEco()` is called. If any conflicts have `severity = 'error'` (field-level conflicts or branch_not_found), approval is blocked with a `ValidationError` listing the conflicting items.

### Release Flow

After the workflow transition succeeds, `ChangeOrderService.close()` calls `ChangeOrderMergeService.merge()`:

#### Branch Merge Path (designs with branches)

For each `change_order_designs` record with a branch:

1. **Auto-checkin**: All checked-out items on the branch are automatically checked in.

2. **Validate merge**: `validateMerge()` checks for checkout locks, concurrent modifications, and no-changes conditions.

3. **Merge branch to main** via `mergeBranchToMain()`, running in a serializable transaction:

   For each changed `branch_items` record:
   - **`added` items**: Creates a new released item version with the initial revision letter (e.g., `A`). Updates or creates the main branch's `branch_items` record. Marks the draft item as `isCurrent = false`.

   - **`modified` items** (with working copy): If the working copy has a placeholder revision (starts with `-`), calculates the next revision from main's current version (not the base, since another ECO may have released a newer revision between branch creation and now). Updates the working copy to `Released` state with the final revision. Marks the old version on main as `Superseded`.

   - **`modified` items** (legacy, no working copy): Creates a new item version with the next revision letter. This is the fallback path for backward compatibility.

   - **`deleted` items**: Marks the item as `isCurrent = false` on main and sets state to `Obsolete`.

4. **Create merge commit**: Records the merge on main with:
   - `mergeParentId` pointing to the ECO branch HEAD (two-parent merge, like Git)
   - `revisionsAssigned`: JSONB map of `{ itemNumber: newRevision }`
   - `changeOrderItemId` linking to the ECO

5. **Update design tracking**: Sets `change_order_designs.mergeStatus = 'merged'`, records `mergedAt` and `mergeCommitId`.

6. **Update BOM relationships**: Remaps item relationship source/target IDs from draft items to their released counterparts.

7. **Copy vault files**: `FileService.copyFilesToNewVersion()` links file attachments from the draft version to the released version.

#### Affected Items Path (no branches)

If no branches were merged (either no branches exist or all were skipped), the system falls back to processing affected items directly:

- For each affected item, applies the change action (`release`, `revise`, `obsolete`, `promote`) using `ItemService.update()` with `bypassBranchProtection: true`.
- Creates release commits on the main branch.
- Archives any associated ECO branches.

#### Baseline Tags

If the ECO has `isBaseline = true` and a `baselineName`, a design tag is created on each affected design using `DesignService.createTag()` with `tagType: 'eco-release'`.

#### Post-Merge

- ECO branches are archived (`BranchService.archiveBranch()`).
- `change_orders.closedAt` is set.

### Revision Assignment Rules

Revisions are assigned only during the merge, never during branch work:

| Action     | Revision Behavior                                                      |
| ---------- | ---------------------------------------------------------------------- |
| `release`  | Assigns initial revision (e.g., `A` for alpha scheme, `1` for numeric) |
| `revise`   | Assigns next revision (A -> B, B -> C, Z -> AA)                        |
| `obsolete` | No revision change                                                     |
| `promote`  | May reset revision (when crossing phase boundaries) or increment       |

The revision scheme is configurable per lifecycle and per phase:

- `alpha`: A, B, C, ..., Z, AA, AB (traditional PLM)
- `numeric`: 1, 2, 3
- `prefixed-numeric`: X1, X2, X3 (prototype revisions)
- `none`: No revision tracking

---

## Conflict Detection

`ConflictDetectionService` in `src/lib/services/ConflictDetectionService.ts` detects conflicts before an ECO can be approved.

### Conflict Types

| Type                      | Severity  | Description                                                                                              |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `checkout`                | `error`   | Item still checked out on the branch. Must be checked in before merge.                                   |
| `concurrent_modification` | `warning` | Main changed this item after the branch was created, but different fields were modified. Suggest rebase. |
| `field_conflict`          | `error`   | Same field modified differently on both the branch and main (or another ECO). Blocks approval.           |
| `cross_eco`               | `warning` | Another active ECO is modifying the same item. Coordinate with that ECO's owner.                         |
| `no_changes`              | `info`    | No changes to merge. Branch is skipped during merge.                                                     |
| `branch_not_found`        | `error`   | Invalid branch reference.                                                                                |

### Three-Way Field Comparison

For `concurrent_modification` and `field_conflict` detection, the service performs a three-way comparison:

```
Base (when branch was created)  <-->  Ours (working copy on branch)
          |                                      |
          v                                      v
     Main (current released)  <-->  Field-level diff
```

1. **Base**: The item version recorded in `branch_items.baseItemId` (snapshot at branch creation).
2. **Ours**: The item at `branch_items.currentItemId` (the working copy).
3. **Theirs**: The current item on main's `branch_items.currentItemId`.

For each field (excluding metadata fields like `id`, `masterId`, `revision`, timestamps, etc.):

- If **we** changed a field and **they** did not: no conflict.
- If **they** changed a field and **we** did not: no conflict (auto-mergeable).
- If **both** changed the same field to **different** values: `field_conflict` (blocking).
- If **both** changed the same field to the **same** value: no conflict.

### Cross-ECO Conflict Detection

`detectCrossEcoConflicts()` finds other active ECOs (workflow not completed) that affect the same items:

1. Gets all `branch_items` with `changeType != null` on this ECO's branches.
2. Queries `change_order_affected_items` for other ECOs targeting the same `affectedItemMasterId`.
3. If both ECOs have working copies, performs three-way field comparison.
4. Field conflicts across ECOs are `severity: 'error'`. Simple co-modification is `severity: 'warning'`.

### Resolution

**Rebase** (`ConflictDetectionService.rebaseItem()`): Creates a new working copy that starts from main's current version and applies our non-conflicting changes. For conflicting fields, accepts resolution values passed by the user.

**Pull from main** (`ConflictDetectionService.pullChangesFromMain()`): Simpler operation where main's values always win. Creates a new working copy based on main's current item and updates `branch_items.baseItemId` to main's current.

Both operations use `REPEATABLE READ` transaction isolation to prevent phantom reads during conflict resolution.

---

## ECO Cancellation

ECO cancellation is handled through the workflow system. When an ECO transitions to a terminal/rejected state (or is abandoned), the associated branches are archived.

### What Happens on Cancellation

1. **Workflow transition**: The ECO transitions to a final state like `Rejected` via the transition endpoint.

2. **Branch archival**: `BranchService.archiveBranch()` sets `isArchived = true` and `archivedAt` on each associated branch. Archived branches:
   - Cannot accept new commits
   - Do not appear in branch selectors
   - Remain in the database for audit trail

3. **Working copies**: Items created on the ECO branch (with `isCurrent = false` and placeholder revisions) remain in the database but are orphaned -- they are never merged to main and never become `isCurrent`. They serve as historical evidence of what was attempted.

4. **No revision consumption**: Because revisions are only assigned at merge time, cancelling an ECO wastes no revision letters.

5. **Checkout locks released**: The `autoCheckinBranchItems()` step during close releases any remaining checkout locks.

---

## API Reference

### Core Endpoints

| Method | Path                                       | Purpose                               |
| ------ | ------------------------------------------ | ------------------------------------- |
| `GET`  | `/api/change-orders/:id`                   | Get change order details              |
| `GET`  | `/api/change-orders/editable`              | List ECOs that can still accept items |
| `GET`  | `/api/change-orders/:id/affected-items`    | List affected items                   |
| `POST` | `/api/change-orders/:id/affected-items`    | Add affected item                     |
| `GET`  | `/api/change-orders/:id/designs`           | List associated designs and branches  |
| `GET`  | `/api/change-orders/:id/conflicts`         | Detect conflicts                      |
| `POST` | `/api/change-orders/:id/resolve-conflicts` | Resolve conflicts (rebase/pull)       |
| `GET`  | `/api/change-orders/:id/impact-assessment` | Run/get impact analysis               |
| `GET`  | `/api/change-orders/:id/risks`             | Get identified risks                  |
| `GET`  | `/api/change-orders/:id/release`           | Preview merge (dry run)               |
| `GET`  | `/api/change-orders/:id/summary`           | Get ECO summary                       |

### Workflow Endpoints

| Method | Path                                                  | Purpose                                      |
| ------ | ----------------------------------------------------- | -------------------------------------------- |
| `GET`  | `/api/change-orders/:id/workflow`                     | Get workflow instance                        |
| `GET`  | `/api/change-orders/:id/workflow/transition`          | Get available transitions                    |
| `POST` | `/api/change-orders/:id/workflow/transition`          | Execute transition (submit, approve, reject) |
| `GET`  | `/api/change-orders/:id/workflow/history`             | Get transition history                       |
| `GET`  | `/api/change-orders/:id/workflow/validate-transition` | Validate a transition before executing       |
| `GET`  | `/api/change-orders/:id/workflow/structure`           | Get effective workflow structure             |

### Branch and History Endpoints

| Method | Path                                                 | Purpose                             |
| ------ | ---------------------------------------------------- | ----------------------------------- |
| `GET`  | `/api/change-orders/:id/branch-history`              | Get commit history for ECO branches |
| `GET`  | `/api/change-orders/:id/branch-history/graph`        | Get visual graph data               |
| `GET`  | `/api/change-orders/:id/designs/:designId/structure` | Get design structure on ECO branch  |
| `GET`  | `/api/change-orders/:id/checkout`                    | Get checkout status                 |
| `POST` | `/api/change-orders/:id/checkout`                    | Checkout item to ECO branch         |
| `GET`  | `/api/change-orders/:id/bom-changes`                 | Get BOM changes on ECO branch       |
| `GET`  | `/api/change-orders/:id/items/:itemId/ancestors`     | Get ancestor chain for an item      |

---

## Key Files

| File                                                      | Purpose                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/lib/items/services/ChangeOrderService.ts`            | Core ECO operations: add affected items, working copy creation, submit, approve, reject, close |
| `src/lib/services/ChangeOrderMergeService.ts`             | Branch merge and release: merge to main, revision assignment, BOM remapping                    |
| `src/lib/services/CheckoutService.ts`                     | Item checkout, save changes, checkin, create/delete on branch                                  |
| `src/lib/services/ConflictDetectionService.ts`            | Three-way conflict detection, cross-ECO conflicts, rebase                                      |
| `src/lib/items/services/ImpactAssessmentService.ts`       | Where-used traversal, cross-design impact, risk identification                                 |
| `src/lib/services/BranchService.ts`                       | Branch CRUD, ECO branch creation, lock, archive                                                |
| `src/lib/services/CommitService.ts`                       | Commit creation, merge commits, field change tracking                                          |
| `src/lib/services/VersionResolver.ts`                     | Resolve items per-branch context                                                               |
| `src/lib/services/LifecycleService.ts`                    | Change action validation, state transitions, revision schemes                                  |
| `src/lib/services/RevisionService.ts`                     | Revision letter calculation (A->B, Z->AA, numeric, prefixed)                                   |
| `src/lib/items/types/change-order.ts`                     | Type definitions: ChangeAction, ChangeOrderType, schemas                                       |
| `src/lib/types/lifecycle.ts`                              | Lifecycle types: ChangeActionMappings, RevisionScheme, phase config                            |
| `src/lib/db/schema/items.ts`                              | Schema: change_orders, change_order_affected_items, change_order_designs                       |
| `src/lib/db/schema/versioning.ts`                         | Schema: branches, branch_items, commits                                                        |
| `src/routes/api/change-orders/$id/workflow/transition.ts` | Canonical transition endpoint                                                                  |
