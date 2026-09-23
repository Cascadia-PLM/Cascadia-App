# Change Management: ECO-as-Branch

Cascadia's change management system is modeled after Git's branching model. Every change order — ECO, ECN, MCO or Deviation by change type — creates an isolated branch where engineers make changes to items without affecting the released baseline on `main`. When the change order is approved, the branch is merged back, revision letters are assigned, and items transition to their released states. This document covers the full system from schema to service layer.

---

## Table of Contents

1. [Overview](#overview)
2. [Change Order Types](#change-order-types)
3. [Change-Order Lifecycle](#change-order-lifecycle)
4. [Change Actions](#change-actions)
5. [Creating a Change Order](#creating-a-change-order)
6. [Adding Affected Items](#adding-affected-items)
7. [Making Changes](#making-changes)
8. [Impact Analysis](#impact-analysis)
9. [Approval and Release](#approval-and-release)
10. [Conflict Detection](#conflict-detection)
11. [Change-Order Cancellation](#change-order-cancellation)
12. [API Reference](#api-reference)
13. [Key Files](#key-files)

---

## Overview

Traditional PLM systems treat change management as a metadata process: you fill out a form, someone clicks "Approve," and item states update in place. Cascadia takes a fundamentally different approach inspired by version control. (Coming from Aras or Windchill? There is no separate workflow object here — a change order runs an instance of a lifecycle definition; the [lifecycle engine guide](./workflow-engine.md#coming-from-aras-or-windchill) explains the unification.)

**ECO-as-Branch** means:

- Each change order gets one or more isolated branches (one per affected design).
- Engineers edit working copies of items on the branch, not the released originals.
- The released baseline on `main` is never touched until the change order merges.
- Revision letters (A, B, C...) are assigned only at merge time, preventing collisions between parallel change orders.
- After merge, the branch is archived for audit.

This gives you concurrent engineering by default. Two change orders can modify different items in the same design simultaneously. Conflict detection catches the case where two change orders touch the same item and the same field.

### Core Data Tables

| Table                         | Purpose                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `change_orders`               | change-order-specific fields (change type, priority, reason, timestamps)     |
| `change_order_affected_items` | Items included in the change order with their change action                  |
| `change_order_designs`        | Links a change order to each design it affects, with branch and merge status |
| `change_order_impacted_items` | Items discovered by impact analysis (not directly changed)                   |
| `change_order_risks`          | Risks identified during impact assessment                                    |
| `change_order_impact_reports` | Stored impact analysis reports                                               |
| `branches`                    | change-order branches (`branchType = 'eco'`) forked from main                |
| `branch_items`                | Per-branch item overrides (working copies, change tracking)                  |

Schema definitions: `cascadia-api/src/lib/db/schema/items.ts` (lines 118-275).

---

## Change Order Types

Cascadia supports four change order types, defined in `cascadia-commons/src/lib/items/types/change-order.ts`:

| Type        | Name                       | Purpose                                                                                                |
| ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ECO`       | Engineering Change Order   | Standard change to released items. Creates branch, requires approval, merges with revision assignment. |
| `ECN`       | Engineering Change Notice  | Notification of a change. Lighter process, same underlying mechanics.                                  |
| `MCO`       | Manufacturing Change Order | Manufacturing-specific change. Same branch mechanics, different approval routing.                      |
| `Deviation` | Deviation                  | Temporary departure from released configuration. May not assign new revisions.                         |

All four types use the same `ChangeOrderService`, `ChangeOrderMergeService`, and branch infrastructure. The difference is in lifecycle routing: `ChangeOrderService.autoStartWorkflow()` looks up the lifecycle definition configured for each `changeType` in the ChangeOrder's `RuntimeItemTypeConfig`.

```typescript
// cascadia-api/src/lib/items/services/ChangeOrderService.ts
static async autoStartWorkflow(
  changeOrderId: string,
  changeType: 'ECO' | 'ECN' | 'Deviation' | 'MCO',
  userId: string,
) {
  const config = ItemTypeRegistry.getRuntimeConfig('ChangeOrder')
  const workflowId = config.lifecyclesByChangeType[changeType]
  return this.startWorkflow(changeOrderId, workflowId, userId)
}
```

Each type can map to a different lifecycle definition (or share one). Administrators configure this in Admin > Item Types > ChangeOrder.

---

## Change-Order Lifecycle

The shipped `Change Order - Standard` lifecycle has four states:

```
                Submit for Review          Approve
  +-------+    =================>    +-----------+    =============>    +----------+
  | Draft |                          | In Review |                     | Approved |
  +-------+    <=================    +-----------+                     +----------+
       \          Return to Draft         /                             (isFinal,
        \                                /                            release)
         \===========================\  /
                    Cancel            \/
                              +-------------+
                              |  Cancelled  |
                              +-------------+
                            (isFinal, cancel)
```

### State Definitions

| State       | `isFinal` | `finalKind` | Description                                                                                                               |
| ----------- | --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Draft`     | No        | —           | The change order is being prepared. Affected items can be added/removed. Items can be checked out and edited.             |
| `InReview`  | No        | —           | The change order is under review. Scope is locked (no new affected items). Editing continues on existing working copies.  |
| `Approved`  | Yes       | `release`   | The change order is approved. Triggers `close()` which merges branches to main, assigns revisions, and archives branches. |
| `Cancelled` | Yes       | `cancel`    | The change order is abandoned. Branches are archived unmerged; no revisions are consumed.                                 |

`Return to Draft` is rework: it sends the change order back to the initial state and reopens its scope,
so the items the reviewer asked for can actually be added.

### Scope Locking

When a change order leaves the Draft state (transitions to InReview), the lifecycle instance's `scopeLocked` flag is set to `true`. This prevents:

- Adding new affected items (`ChangeOrderService.addAffectedItem()` checks `scopeLocked`)
- Removing affected items (`ChangeOrderService.removeAffectedItem()` checks `scopeLocked`)
- Checking out new items to the change order (`ChangeOrderService.checkoutItem()` checks `scopeLocked`)
- Adding new design associations
- Bringing a **new** item onto the change order's branch by any route — the plain checkout,
  create-on-branch and delete-on-branch paths (`POST /api/v1/items/:id/checkout`, batch
  checkout, the AI tools) check the owning change order's scope too. Without that, content
  could be added to a change order already in review and would release without ever appearing in
  the affected items list. Deleting counts: a delete of a master the branch does not track
  yet mints branch content for it, which is new scope like any other.

Existing working copies can still be edited while scope is locked. This separation ensures reviewers evaluate a fixed scope while engineers can continue refining the details — the lock freezes _what_ the change covers, not the work on it.

**Rework reopens scope.** A transition back into the lifecycle's initial state clears
`scopeLocked`. A lifecycle that can return a change order to Draft is asking for its scope to be
corrected there, so leaving the lock set made that transition a trap.

### Flexible Lifecycle

Cascadia also ships an "XCO - Flexible Change Order" lifecycle (`workflowType: 'flexible'`) with just two states: Start and Complete. Users can add custom review steps per-instance at runtime, tailoring the process to each change order's complexity.

### Transition Endpoint

All change-order state changes go through one canonical endpoint on the lifecycle instance:

```
POST /api/v1/change-orders/:id/workflow/transition
Body: { toStateId: "Approved", comments: "LGTM" }
```

When the target state has `isFinal: true`, the endpoint:

1. Executes the transition (validates guards, records history)
2. Calls `ChangeOrderService.close()` which triggers `ChangeOrderMergeService.merge()`
3. Returns the merge result including revisions assigned

There are no separate `/submit`, `/approve`, `/reject` endpoints. Everything flows through the transition endpoint.

**Advancing a change order requires reach to every design it links.** Reading a change
order needs reach to only one of them — the rest is redacted — but submitting,
releasing or cancelling one needs all of them, because a release merges every
linked branch and stamps permanent revisions across all of them and a cancel
archives every linked branch. The gate lives in
`ChangeOrderService.executeWorkflowTransition`, not the route, so the AI tools
and MCP paths are covered too; cross-program authority bypasses it. See
[programs-and-designs.md](./programs-and-designs.md#how-permissions-cascade)
for the full three-tier rule.

---

## Change Actions

Change actions describe what the change order intends to do to each affected item. They are defined in `cascadia-commons/src/lib/items/types/change-order.ts` and their state mappings live in lifecycle definitions (`cascadia-commons/src/lib/types/lifecycle.ts`).

### `release`

**Purpose**: First release of a new item (Draft -> Released).

- Validates: Item must be in `Draft` state.
- At merge: Sets state to `Released`, assigns initial revision letter (typically `A`).
- Use case: Releasing new parts created during initial design.

### `revise`

**Purpose**: Create a new revision of an already-released item.

- Validates: Item must be in `Released` state.
- At add-time: Creates a working copy on the change-order branch with a placeholder revision (`-{branchId8}`). The original stays on main unchanged.
- At merge: Marks old revision as `Superseded` (`isCurrent = false`), assigns next revision letter (A -> B, B -> C), sets working copy to `Released` and `isCurrent = true`.
- Use case: Changing the weight of a released part, updating a drawing.

The placeholder revision format (e.g., `-abc12345`) allows multiple change orders to have working copies of the same item simultaneously without violating the unique constraint on `(item_number, revision)`.

### `obsolete`

**Purpose**: End-of-life an item (Released -> Obsolete).

- Validates: Item must be in `Released` state. If item is used in released assemblies, a replacement item ID is required.
- At merge: Sets state to `Obsolete`. Does not assign a new revision.
- Validation performs a recursive where-used query to check for active usage.

### BOM membership is not a change action

`add` and `remove` used to sit alongside these as membership actions. They did
nothing at merge, so an item recorded under one was silently never released —
which is what happened to every item created on a workspace and converted to a
change order. They have been retired.

Membership is edited on the change order's branch, via
`POST /api/v1/change-orders/:id/bom-changes`, and released when the branch
merges: the merge replaces the released item's structure with the branch's, so a
line added or deleted there is exactly what ships. A brand-new item on a branch
is a `release`.

Affected-item rows written before the retirement keep their stored action; every
release loop skips an action it does not recognise, which leaves them as inert as
they always were rather than failing the release.

### `promote`

**Purpose**: Transition an item across lifecycle phase boundaries (e.g., Prototype -> Production).

- Validates: Item must be in the `fromState` configured in the promote mapping.
- At add-time: Calculates target revision based on the phase's revision scheme, including reset logic.
- At merge: Sets state to the target phase's state, optionally resets or increments revision per the phase configuration.
- Use case: Promoting a prototype part to production readiness.

### Lifecycle Configuration Example

```typescript
// From cascadia-commons/src/lib/types/lifecycle.ts
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

## Creating a Change Order

Change-order creation is a two-phase process: first create the ChangeOrder item — with its designs and its running lifecycle instance, as one step — then add affected items.

### Step 1: Create the ChangeOrder Item

A ChangeOrder is an item type like Part or Document. It is created through `ChangeOrderService.create()`, the one door, against one or more designs: creation links each design (creating its branch) and starts the lifecycle instance, and if any of that fails the change order is removed and the error raised. A change order never exists without its designs or its lifecycle instance. It has additional fields in the `change_orders` extension table:

| Field               | Type                                   | Purpose                                   |
| ------------------- | -------------------------------------- | ----------------------------------------- |
| `changeType`        | `ECO` / `ECN` / `Deviation` / `MCO`    | Determines lifecycle routing              |
| `priority`          | `low` / `medium` / `high` / `critical` | Priority level                            |
| `reasonForChange`   | text                                   | Why the change is needed                  |
| `impactDescription` | text                                   | Expected impact                           |
| `isBaseline`        | boolean                                | Whether to create a design tag on release |
| `baselineName`      | string                                 | Name for the baseline tag                 |

### Step 2: Lifecycle Instance Start (part of creation)

`ChangeOrderService.create()` calls `autoStartWorkflow()`, which looks up the lifecycle definition for the given `changeType` from the ChangeOrder's runtime configuration and starts a lifecycle instance; the change order's own `state` is stamped from that instance's initial state in the same transaction. A change type with no lifecycle configured is a creation error — reported as one — not a change order with no instance. The manual-start endpoint (`POST /api/v1/change-orders/:id/workflow`) exists to repair a change order that lost its instance, and accepts only a Driving definition.

### Step 3: Branch Creation (Lazy)

Branches are **not** created when the change order is created. They are created lazily when the first affected item is added that belongs to a design. This is handled by `ChangeOrderService.ensureDesignAssociation()`:

1. Checks if a `change_order_designs` record exists for this change order + design pair.
2. If not, calls `BranchService.getOrCreateChangeOrderBranch(designId, changeOrderId, userId)`.
3. `getOrCreateChangeOrderBranch` creates a branch named `eco/{ECO-number}` forked from main's HEAD.
4. Creates an initial "ChangeOrder created" commit on the branch.
5. Inserts the `change_order_designs` record linking the change order to the design with the new branch ID.

If the change order affects items across multiple designs, a separate branch is created for each design.

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

Adding an affected item is the core operation that connects a change order to the items it will change. This is handled by `ChangeOrderService.addAffectedItem()`.

### Flow

Target state and revision are **not** accepted from the caller: the route
(`POST /:id/affected-items`) validates the body against a Zod schema that has no
such fields, and `LifecycleService.resolveActionTarget()` resolves both from the
item's lifecycle. `GET`-equivalent preview of the same resolution is available at
`POST /:id/affected-items/preview`, which is what the intake dialogs render.

1. **Scope lock check**: If the lifecycle instance has `scopeLocked = true`, the operation is rejected.

2. **Lifecycle validation**: `LifecycleService.canApplyAction()` validates the change action is valid for the item's current state (e.g., cannot `release` an already-Released item).

3. **Design association**: If the item belongs to a design, `ensureDesignAssociation()` creates the change-order branch (or reuses an existing one).

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
   - `changeAction` (release, revise, obsolete, promote)
   - `currentState`, `currentRevision` (snapshot of item state at add-time)
   - `targetState`, `targetRevision` (server-resolved prediction; for `revise`
     the merge recomputes the revision against main's current version at release
     time, so this column is for display, never for release)
   - `initialRevisionOverride` (optional, administrator-approved source-system
     revision used only for an item's first formal `release`)
   - `workingCopyId` (if a working copy was created for revise)

### Imported Initial Revisions

When existing products enter Cascadia after they have already reached revisions
such as `R2` or `R3`, an administrator can set an initial revision override on
each eligible affected item. Items without an override continue to use the
lifecycle scheme's configured initial revision, so one Initial Release change
order may release a mixed imported baseline without creating fictitious ECOs.

This is a migration exception, not ordinary revision editing:

- it is available only for the `release` action while the item still carries a
  working/unreleased revision;
- the entire master lineage must contain no formal revision;
- the value must match the item's lifecycle revision scheme;
- the change-order scope must still be open and only an Administrator may set
  or clear it;
- release preview and merge consume the same persisted value and revalidate it
  at release time.

`targetRevision` remains a server-derived display prediction. The persisted
`initialRevisionOverride` is the approved release intent. Clearing it restores
the lifecycle default.

### Batch Operations

`addAffectedItemsBatch()` adds several items with deduplication — items already present in the change order are skipped (idempotent). An item may appear at most once per change order; adding the same item twice is rejected, since two rows for one item (say `revise` and `obsolete`) would each validate on their own and then be applied in unspecified order at merge.

> **Not atomic, by design.** Each addition commits independently — a mid-batch failure leaves
> the earlier ones in place. This is safe because the loop is idempotent: items already on the
> change order are skipped, so re-running the batch completes the remainder without duplicating rows.
> (An earlier wrapping `db.transaction` was decorative — the calls inside ran on the global
> `db` handle — and was removed rather than made real.)

---

## Making Changes

Once items are on an change-order branch, engineers edit them through the checkout/save/checkin cycle.

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
2. On the first save, creates a new `items` row with the merged changes (new
   `id`, same `masterId`, branch-scoped working revision `-{branchId8}`). Later
   saves edit that working copy in place — a row per save would collide on the
   items unique constraint. Lifecycle and identity fields (`state`, `revision`,
   `itemNumber`) are stripped from the change set rather than rejected.
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

- Generates a new `masterId` and creates the item with the branch-scoped
  working revision and the lifecycle's initial state.
- Creates a `branch_items` record with `changeType = 'added'` and `baseItemId = null`.
- Creates a commit recording the addition.
- Lists the item on the change order that owns the branch
  (`ChangeOrderService.registerBranchChange()`), as a `release` carrying the
  scheme's initial revision.

**A first release is recorded whatever state the new item is in.** The branch
merge gives every `'added'` row the release state and the initial revision
without consulting the `release` mapping's `fromState`, so the scope row has to
say the same thing. Inferring the action from the item's state instead recorded
nothing for any type whose release starts later than its initial state —
Requirement releases from `Approved` — and the change order then refused to
release, naming items it had never been given the chance to list.

### Deleting Items on a Branch

`CheckoutService.deleteOnBranch()`:

- Refuses when someone else holds the item's checkout, with the same
  named-holder `ResourceLockedError` a contended checkout returns. A delete is
  a write to the working copy, so it answers to the exclusive lock exactly as
  `cancelCheckout`, `saveChanges` and `checkin` do. There is no bypass flag:
  the holder cancels their own checkout, and the admin lock-force paths stay
  the deliberate override.
- Runs the scope gate above when the branch does not track the master yet,
  because minting branch content for it is new scope.
- If the item was added on this branch (`changeType = 'added'`), removes the
  `branch_items` record, and drops the item from the change order's scope
  (`ChangeOrderService.unregisterBranchChange()`) when no branch of that change
  order carries the master any more — the item existed only on the branch, so
  leaving the scope row would have the branchless merge path release a draft
  that no longer exists.
- Otherwise, sets `branch_items.changeType = 'deleted'` and records the master
  on the owning change order as an `obsolete` affected item
  (`ChangeOrderService.registerBranchChange()`), so deletions appear in the
  scope reviewers approve instead of turning up as unlisted branch content the
  release refuses. Recorded whether or not the item's lifecycle configures an
  obsolete action — the merge's branch path already handles the unmapped case
  by marking the item deleted and leaving its state alone.
- Creates a commit recording the deletion.

The whole sequence is one transaction, and the `branch_items` row it decides
from is re-read under `FOR UPDATE` inside it: the row can be claimed, minted
or removed between the first read and the write, and the insert on the
no-row path carries `ON CONFLICT DO NOTHING` against `branch_items_unique`
so a lost race resolves onto the winner's row rather than surfacing a
constraint violation.

---

## Impact Analysis

Impact analysis discovers the ripple effects of changing items within and across designs. It is performed by `ImpactAssessmentService.analyzeImpact()` in `cascadia-api/src/lib/items/services/ImpactAssessmentService.ts`.

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
- **Branch context**: The traversal walks the change order's own branches, not
  main. A `resolved_items` CTE overlays each branch's version of every master it
  changed on top of main's current versions and drops the masters it deleted, so
  a BOM line added on the branch is visible in its children's where-used and one
  deleted there is not. Without it, impact analysis answered about the structure
  the change order started from rather than the one it is proposing.

### Cross-Design Impact

`buildCrossDesignImpacts()` identifies when affected items have usage copies in external designs. It follows the definition-usage chain:

1. If the affected item is a usage copy (`usageOf` is set), the definition is the `usageOf` target.
2. If the affected item is a definition (no `usageOf`), look for all items with `usageOf = item.id`.
3. Group impacted items by their design, excluding the change order's own designs.

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

Critical risks with `requiresAcknowledgement = true` must be explicitly acknowledged before the change order can be released (`ChangeOrderService.executeWorkflowTransition()` refuses a releasing transition while one is unacknowledged).

### Stored Results

Impact analysis results are persisted in three tables:

- `change_order_impacted_items`: Each discovered item with type, severity, depth, and path.
- `change_order_risks`: Identified risks with category, severity, mitigation, and acknowledgement status.
- `change_order_impact_reports`: The full report as JSONB with generation timing.

The `change_orders` table is updated with `impactAssessmentStatus = 'completed'` and the calculated `riskLevel`.

---

## Approval and Release

When a change order transitions to its final state (e.g., Approved), the transition endpoint triggers the release process.

### Pre-Release Checks

`ChangeOrderService.assertReleaseGates()` runs from `executeWorkflowTransition` before a
transition into a `finalKind: 'release'` state takes its release claim — so a refusal leaves
nothing to clean up. That claim is a 15-minute lease, not a permanent lock; see
[`workflow-engine.md`](./workflow-engine.md#initial-and-final-states) for the takeover policy:

1. **Critical risk acknowledgement**: All risks with `severity = 'critical'` and `requiresAcknowledgement = true` must have `acknowledgedBy` set.

2. **Blocking conflict check**: `ConflictDetectionService.detectConflictsForChangeOrder()` is called. If any conflicts have `severity = 'error'` — field conflicts, concurrent modification, or branch_not_found — the release is blocked with a `ValidationError` listing the conflicting items. Held checkouts are warnings: step 1 of the merge checks every item in automatically.

Cancelling deliberately skips both: it merges nothing, and a change order being abandoned _because_ of
its conflicts must not be trapped by them.

The merge then applies its own checks — the driver allow-list, scope reconciliation, and
per-branch `validateMerge`, which compares extension-table fields and BOM structure as well as
the base item row.

Scope reconciliation (`assertScopeMatchesBranchContent`) refuses to release branch content the
change order does not list. `previewMerge()` reports the same finding as a `validationIssue`
with `canRelease: false`, so `GET /api/v1/change-orders/:id/release` — and the release preview
in the transition dialog — show it before anyone approves, rather than at the release itself.

### Release Flow

After the transition succeeds, `ChangeOrderService.close()` calls `ChangeOrderMergeService.merge()`:

#### Branch Merge Path (designs with branches)

Each design's release is **one serializable transaction**: item versions, BOM
structure, cross-design references, the merge commit, file promotion, branch
archival, and the change order's `mergeStatus` record of it. `mergeStatus` has to
commit with the release it describes, because the retry guard trusts it to know a
design is done — a release that landed its items but not its status would be
re-released, with fresh revisions, on the next attempt. Outbound side effects
(the work-instruction alert job, derived-MBOM notification) run after it commits:
a queue publish cannot be rolled back, and holding the transaction open across a
network call would extend the lock window for no benefit.

A multi-design release is not one transaction across designs. Each design commits
independently, and the `mergeStatus` guard makes a retry after a partial failure
skip the designs that already landed. The affected-item pass that follows records
its own completion the same way: it stamps `change_orders.implementedAt` inside
its final transaction, and `merge()` returns early when it is set, so a retry
after the lifecycle instance's own state write failed re-runs nothing — in particular not
the branchless `revise` arm, which would otherwise base a second letter on the
version the first pass created.

For each `change_order_designs` record with a branch:

1. **Auto-checkin**: All checked-out items on the branch are automatically checked in.

2. **Validate merge**: `validateMerge()` checks for checkout locks, concurrent modifications, and no-changes conditions.

3. **Merge branch to main** via `mergeBranchToMain()`, running in a serializable transaction:

   For each changed `branch_items` record:
   - **`added` items**: Creates a new released item version with the initial revision letter (e.g., `A`). Updates or creates the main branch's `branch_items` record. Marks the draft item as `isCurrent = false`.

   - **`modified` items** (with working copy): If the working copy has a placeholder revision (starts with `-`), calculates the next revision from main's current version (not the base, since another change order may have released a newer revision between branch creation and now). Updates the working copy to `Released` state with the final revision. Marks the old version on main as `Superseded`.

   - **`modified` items** (legacy, no working copy): Creates a new item version with the next revision letter. This is the fallback path for backward compatibility.

   - **`deleted` items**: Marks the item as `isCurrent = false` on main and sets state to `Obsolete`.

4. **Create merge commit**: Records the merge on main with:
   - `mergeParentId` pointing to the change-order branch HEAD (two-parent merge, like Git)
   - `revisionsAssigned`: JSONB map of `{ itemNumber: newRevision }`
   - `changeOrderItemId` linking to the change order

5. **Update design tracking**: Sets `change_order_designs.mergeStatus = 'merged'`, records `mergedAt` and `mergeCommitId`.

6. **Update BOM relationships**: Remaps item relationship source/target IDs from draft items to their released counterparts.

7. **Promote vault files**: `FileService.promoteFilesToMain()` makes the branch's
   file attachments visible on main.

#### Affected Items Path (no branches)

If no branches were merged (either no branches exist or all were skipped), the system falls back to processing affected items directly:

- For each affected item, applies the change action (`release`, `revise`, `obsolete`, `promote`) using `ItemService.update()` with `bypassBranchProtection: true`.
- Creates release commits on the main branch.
- Archives any associated change-order branches.

Like the branch merge, this pass is **one serializable transaction under
`withSerializableRetry`**, and for the same reason: every action is a
check-then-act — read the item's state and revision, decide from them, write
both back — so at a weaker isolation level two change orders listing the same
master each read the pre-release row and each act on it, minting one revision
letter twice. A change order cannot race itself (the instance's claim CAS
serializes repeat transitions of one instance); distinct change orders sharing
a master is the exposure. Because a retry re-runs the whole pass, the count of
revisions it assigned and the released-items map behind the release commits
live _inside_ the retry closure and are folded into the result only once it
resolves — an accumulator outside would report the aborted attempt's work
alongside the successful one's.

#### Affected Items Path (alongside a branch merge)

A branch merge releases branch **content** — it creates the new version for every item the
branch changed. That covers `revise` for items that actually have a working copy on a merged
branch, and nothing else. So after the branch merges, every affected item the merge did not
handle is applied here: `promote`, `release`, `obsolete`, and `revise` for an item that was
listed but never checked out. Each is validated with `canApplyAction` first, and items already
in their target state are skipped so a retry after a partial release stays idempotent.

The division is structural, not a list of actions: whatever the branch merge released is its,
and everything else belongs to this pass.

This pass is serializable and retried on the same terms as the two above, with the same
per-attempt accumulator. The set of masters the branch merge already handled is computed
before the transaction and deliberately stays there: it records what has already committed,
which no retry of this pass can change.

#### Scope reconciliation

Before any branch merges, the release checks that every item changed on the change order's branches
appears in its affected items list, and refuses otherwise. The merge releases branch content
while reviewers approve the affected items list, so without this the two could describe
different changes. It is one-directional — affected items with no branch content are normal,
since `obsolete`, `promote` and `release` change state without touching a branch.

#### Baseline Tags

If the change order has `isBaseline = true` and a `baselineName`, a design tag is created on each affected design using `DesignService.createTag()` with `tagType: 'eco-release'`.

#### Post-Merge

- change-order branches are archived (`BranchService.archiveBranch()`). Archived branches are
  ignored by conflict detection: they are finished work, and walking one compared
  its base against the very row the merge promoted onto main.
- `change_orders.implementedAt` is set inside the affected-item pass — the record
  that the release's work is done, which a retry reads.
- `change_orders.closedAt` is set, once; a retry keeps the first value.
- The lifecycle instance's final-state write follows, in one transaction with the history row
  and the `approvedAt` milestone (see the lifecycle engine guide). If it fails, the
  merge above stays committed and the same transition is retried to completion.

### Revision Assignment Rules

Revisions are assigned only during the merge, never during branch work:

| Action     | Revision Behavior                                                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release`  | Assigns the lifecycle's initial revision (for example `A` or `1`), unless an administrator approved an imported initial-revision override for the item's first formal release |
| `revise`   | Assigns next revision (A -> B, B -> C, Z -> AA)                                                                                                                               |
| `obsolete` | No revision change                                                                                                                                                            |
| `promote`  | May reset revision (when crossing phase boundaries) or increment                                                                                                              |

The revision scheme is configurable per lifecycle and per phase:

- `alpha`: A, B, C, ..., Z, AA, AB (traditional PLM)
- `numeric`: 1, 2, 3
- `prefixed-numeric`: X1, X2, X3 (prototype revisions)
- `none`: No revision tracking

---

## Conflict Detection

`ConflictDetectionService` in `cascadia-api/src/lib/services/ConflictDetectionService.ts` detects conflicts before a change order can be approved.

### Conflict Types

| Type                      | Severity  | Description                                                                                              |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `checkout`                | `error`   | Item still checked out on the branch. Must be checked in before merge.                                   |
| `concurrent_modification` | `warning` | Main changed this item after the branch was created, but different fields were modified. Suggest rebase. |
| `field_conflict`          | `error`   | Same field modified differently on both the branch and main (or another change order). Blocks approval.  |
| `cross_eco`               | `warning` | Another active change order is modifying the same item. Coordinate with that change order's owner.       |
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

### Cross-change-order Conflict Detection

`detectCrossChangeOrderConflicts()` finds other active change orders (lifecycle instance not completed) that affect the same items:

1. Gets all `branch_items` with `changeType != null` on this change order's branches.
2. Queries `change_order_affected_items` for other change orders targeting the same `affectedItemMasterId`.
3. If both change orders have working copies, performs three-way field comparison.
4. Field conflicts across change orders are `severity: 'error'`. Simple co-modification is `severity: 'warning'`.

### Resolution

**Rebase** (`ConflictDetectionService.rebaseItem()`): Creates a new working copy that starts from main's current version and applies our non-conflicting changes. For conflicting fields, accepts resolution values passed by the user.

**Pull from main** (`ConflictDetectionService.pullChangesFromMain()`): Simpler operation where main's values always win. Creates a new working copy based on main's current item and updates `branch_items.baseItemId` to main's current.

Both operations use `REPEATABLE READ` transaction isolation to prevent phantom reads during conflict resolution.

**From the release-conflicts dialog** (`POST /api/v1/change-orders/:id/resolve-conflicts`, `ChangeOrderService.resolveConflicts()`): the three choices map onto those operations rather than onto raw branch writes. **Keep ours** and **Keep theirs** are the rebase, with every conflicting field resolved to the branch's value or main's respectively and a per-field choice overriding the item-level one; changes made on one side only survive either way, and the item stays in scope and is released with main's changes underneath its own. **Skip item** removes the item from the change order — its scope row and its branch content — through `removeAffectedItem()`, so it is refused once the scope is locked like any other scope change; after submit, return the change order to its initial state first. Each item reports its own outcome (`207 Multi-Status` when some failed).

---

## Change-Order Cancellation

Change-order cancellation is a lifecycle transition like any other. When a change order transitions to a final state whose kind is `cancel` (or is abandoned), the associated branches are archived.

### What Happens on Cancellation

1. **Transition**: The change order transitions to a final state whose
   `finalKind` is `'cancel'` (`Cancelled` in the shipped lifecycle). The
   semantics come from `finalKind`, never from the state's name.

2. **Branch archival**: `BranchService.archiveBranch()` sets `isArchived = true` and `archivedAt` on each associated branch. Archived branches:
   - Cannot accept new commits
   - Do not appear in branch selectors
   - Remain in the database for audit trail

3. **Working copies**: Items created on the change-order branch (with `isCurrent = false` and placeholder revisions) remain in the database but are orphaned -- they are never merged to main and never become `isCurrent`. They serve as historical evidence of what was attempted.

4. **No revision consumption**: Because revisions are only assigned at merge time, cancelling a change order wastes no revision letters.

5. **Checkout locks released**: Cancelling releases every checkout lock still held on the change order's branches, in the transaction that archives them, and records each release as `item.checkout_cancelled`. A release does the same inside each design's merge transaction, recording `item.checked_in`.

---

## API Reference

### Core Endpoints

| Method | Path                                          | Purpose                                        |
| ------ | --------------------------------------------- | ---------------------------------------------- |
| `GET`  | `/api/v1/change-orders/:id`                   | Get change order details                       |
| `GET`  | `/api/v1/change-orders/editable`              | List change orders that can still accept items |
| `GET`  | `/api/v1/change-orders/:id/affected-items`    | List affected items                            |
| `POST` | `/api/v1/change-orders/:id/affected-items`    | Add affected item                              |
| `GET`  | `/api/v1/change-orders/:id/designs`           | List associated designs and branches           |
| `GET`  | `/api/v1/change-orders/:id/conflicts`         | Detect conflicts                               |
| `POST` | `/api/v1/change-orders/:id/resolve-conflicts` | Resolve conflicts (rebase/pull)                |
| `GET`  | `/api/v1/change-orders/:id/impact-assessment` | Run/get impact analysis                        |
| `GET`  | `/api/v1/change-orders/:id/risks`             | Get identified risks                           |
| `GET`  | `/api/v1/change-orders/:id/release`           | Preview merge (dry run)                        |
| `GET`  | `/api/v1/change-orders/:id/summary`           | Get change-order summary                       |

### Lifecycle Instance Endpoints

| Method | Path                                                     | Purpose                                                   |
| ------ | -------------------------------------------------------- | --------------------------------------------------------- |
| `GET`  | `/api/v1/change-orders/:id/workflow`                     | Get lifecycle instance                                    |
| `GET`  | `/api/v1/change-orders/:id/workflow/transition`          | Get available transitions                                 |
| `POST` | `/api/v1/change-orders/:id/workflow/transition`          | Execute a transition (release or cancel on a final state) |
| `GET`  | `/api/v1/change-orders/:id/workflow/history`             | Get transition history                                    |
| `POST` | `/api/v1/change-orders/:id/workflow/validate-transition` | Validate a transition before executing                    |
| `GET`  | `/api/v1/change-orders/:id/workflow/structure`           | Get effective instance structure                          |

### Branch and History Endpoints

| Method | Path                                                    | Purpose                                      |
| ------ | ------------------------------------------------------- | -------------------------------------------- |
| `GET`  | `/api/v1/change-orders/:id/branch-history`              | Get commit history for change-order branches |
| `GET`  | `/api/v1/change-orders/:id/branch-history/graph`        | Get visual graph data                        |
| `GET`  | `/api/v1/change-orders/:id/designs/:designId/structure` | Get design structure on change-order branch  |
| `GET`  | `/api/v1/change-orders/:id/checkout`                    | Get checkout status                          |
| `POST` | `/api/v1/change-orders/:id/checkout`                    | Checkout item to change-order branch         |
| `GET`  | `/api/v1/change-orders/:id/bom-changes`                 | Get BOM changes on change-order branch       |
| `GET`  | `/api/v1/change-orders/:id/items/:itemId/ancestors`     | Get ancestor chain for an item               |

---

## Key Files

| File                                                             | Purpose                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `cascadia-api/src/lib/items/services/ChangeOrderService.ts`      | Core change-order operations: creation, affected items, working copies, scope gates, transitions, close |
| `cascadia-api/src/lib/services/ChangeOrderMergeService.ts`       | Branch merge and release: merge to main, revision assignment, BOM remapping                             |
| `cascadia-api/src/lib/services/CheckoutService.ts`               | Item checkout, save changes, checkin, create/delete on branch                                           |
| `cascadia-api/src/lib/services/ConflictDetectionService.ts`      | Three-way conflict detection, cross-change-order conflicts, rebase                                      |
| `cascadia-api/src/lib/items/services/ImpactAssessmentService.ts` | Where-used traversal, cross-design impact, risk identification                                          |
| `cascadia-api/src/lib/services/BranchService.ts`                 | Branch CRUD, change-order branch creation, lock, archive                                                |
| `cascadia-api/src/lib/services/CommitService.ts`                 | Commit creation, merge commits, field change tracking                                                   |
| `cascadia-api/src/lib/services/VersionResolver.ts`               | Resolve items per-branch context                                                                        |
| `cascadia-api/src/lib/services/LifecycleService.ts`              | Change action validation, state transitions, revision schemes                                           |
| `cascadia-api/src/lib/services/RevisionService.ts`               | Revision letter calculation (A->B, Z->AA, numeric, prefixed)                                            |
| `cascadia-commons/src/lib/items/types/change-order.ts`           | Type definitions: ChangeAction, ChangeOrderType, schemas                                                |
| `cascadia-commons/src/lib/types/lifecycle.ts`                    | Lifecycle types: ChangeActionMappings, RevisionScheme, phase config                                     |
| `cascadia-api/src/lib/db/schema/items.ts`                        | Schema: change_orders, change_order_affected_items, change_order_designs                                |
| `cascadia-api/src/lib/db/schema/versioning.ts`                   | Schema: branches, branch_items, commits                                                                 |
| `cascadia-api/src/server/routes/change-orders.ts`                | Canonical transition endpoint                                                                           |
