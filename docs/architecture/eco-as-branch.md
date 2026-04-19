# ECO-as-Branch: Change Management Architecture

The signature feature of Cascadia PLM is "ECO-as-Branch" -- each Engineering Change Order gets its own isolated data branch, inspired by Git's branching model but applied to database records. This document explains the data model, the full lifecycle, and the implementation details.

---

## The Git Analogy

| Git Concept   | Cascadia Concept       | Purpose                                             |
| ------------- | ---------------------- | --------------------------------------------------- |
| Repository    | Design                 | Container for versioned engineering data            |
| Branch        | Branch (`eco/ECO-001`) | Isolated workspace for a change order               |
| `main` branch | `main` branch          | The released, canonical state of the design         |
| Commit        | Commit                 | Immutable snapshot recording what changed           |
| Merge         | ECO Release            | Merge branch changes back to main, assign revisions |
| Working copy  | branchItem + checkout  | Item checked out for editing on a branch            |
| Conflict      | Cross-ECO conflict     | Two ECOs modify the same item concurrently          |

The analogy is structural, not metaphorical. Cascadia implements actual branches, commits with parent pointers, merge commits with dual parents, and branch isolation via overlay records.

---

## Data Model

### designs

Top-level container. Each design owns a `main` branch created automatically.

```
Design "UAV-T1" (designType = 'Engineering')
  ├── defaultBranchId → main branch
  └── programId → "UAV Program"
```

### branches

Each design has a `main` branch. ECO branches are created when affected items are added.

```sql
-- Main branch
{ id: 'br-1', designId: 'd-1', name: 'main', branchType: 'main',
  headCommitId: 'c-3', baseCommitId: 'c-0' }

-- ECO branch (forked from main's HEAD at c-3)
{ id: 'br-2', designId: 'd-1', name: 'eco/ECO-001', branchType: 'eco',
  headCommitId: 'c-3', baseCommitId: 'c-3',
  changeOrderItemId: 'item-eco-1', isLocked: false, isArchived: false }
```

Key fields:

| Field               | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `headCommitId`      | The tip of the branch -- advances with each commit                         |
| `baseCommitId`      | The main branch commit this ECO was forked from (fixed at creation)        |
| `changeOrderItemId` | Links to the ChangeOrder item that owns this branch                        |
| `isLocked`          | Set to `true` when ECO is submitted for approval -- prevents further edits |
| `isArchived`        | Set to `true` after merge -- branch becomes read-only for audit            |

### branchItems

The key table that makes branch isolation work. It stores **per-branch overrides** of items. Items not modified on the ECO branch have no `branchItem` record -- they are inherited from main by fallback.

```sql
-- Item P-1001 modified on ECO branch
{ branchId: 'br-2', itemMasterId: 'master-1',
  currentItemId: 'item-v2',    -- latest version on this branch
  baseItemId: 'item-v1',       -- version when branch was created (for diffing)
  changeType: 'modified',
  checkedOutBy: 'user-1', checkedOutAt: '2024-01-15' }
```

`changeType` values:

- `null` -- item is on the branch but unchanged (baseline copy)
- `'added'` -- new item created on this branch
- `'modified'` -- existing item has been edited
- `'deleted'` -- item marked for removal

### commits

Immutable snapshots forming a linear chain per branch, with optional merge parents.

```sql
-- Regular commit on ECO branch
{ id: 'c-4', branchId: 'br-2', parentId: 'c-3',
  message: 'Updated weight for P-1001',
  itemsChanged: 1 }

-- Merge commit (ECO release)
{ id: 'c-5', branchId: 'br-1',  -- on main branch
  parentId: 'c-3',               -- main's previous HEAD
  mergeParentId: 'c-4',          -- ECO branch's HEAD
  changeOrderItemId: 'item-eco-1',
  revisionsAssigned: { "P-1001": "B", "P-1002": "C" } }
```

### itemVersions & itemFieldChanges

These provide audit trail:

| Table              | Purpose                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `itemVersions`     | Links items to commits: which commit changed which item, with `changeType` |
| `itemFieldChanges` | Field-level changes: `fieldName`, `oldValue`, `newValue`, `fieldCategory`  |

---

## The Full ECO Lifecycle

### Phase 1: ECO Creation (Branch Creation)

```
Service: ChangeOrderService.addAffectedItem()
         → BranchService.getOrCreateEcoBranch()
```

When a ChangeOrder is created and affected items are added:

1. The ECO item is created in the `items` table with `state = 'Draft'`
2. For each affected item with a design, `BranchService.getOrCreateEcoBranch()`:
   - Creates an `eco/{ECO-number}` branch pointing to main's current HEAD
   - Records the association in `changeOrderDesigns` (which designs this ECO affects)
   - If the affected item is Released and the action is `revise`, creates a working copy on the ECO branch

```
BEFORE:
  main: ───C0───C1───C2───C3 (HEAD)
              P-1001 rev A (Released)

AFTER:
  main:         ───C0───C1───C2───C3 (HEAD)
                                  /
  eco/ECO-001:                  C3 (base = C3, head = C3)
                               branchItem: P-1001 (changeType: null)
```

### Phase 2: Checkout and Editing

```
Service: CheckoutService.checkout()
         CheckoutService.saveChanges()
```

When a user edits an item on the ECO branch:

1. **Checkout**: `CheckoutService.checkout(itemMasterId, branchId, userId)`
   - Finds or creates a `branchItem` record
   - Sets `checkedOutBy` and `checkedOutAt` (prevents concurrent editing)

2. **Save changes**: `CheckoutService.saveChanges()`
   - Creates a **new `items` row** with modified fields (new `id`, same `masterId`, `revision = 'DRAFT'`)
   - Computes field-level diffs via `computeFieldChanges(oldItem, newItem)`
   - Updates `branchItem.currentItemId` to point to the new version
   - Sets `branchItem.changeType = 'modified'`
   - Creates a commit via `CommitService.create()`
   - Records changes in `itemFieldChanges` for audit trail

```
AFTER EDIT:
  main:         ───C0───C1───C2───C3 (HEAD, P-1001 rev A)
                                  /
  eco/ECO-001:                  C3───C4 (P-1001 modified, revision='DRAFT')
                                      └─ itemFieldChanges: weight 10→15
```

### Phase 3: Submission (Branch Locking)

When the ECO transitions to "Submitted for Approval" via the workflow:

- `BranchService.lockBranch(branchId)` sets `branches.isLocked = true`
- `CommitService.create()` checks the lock and rejects new commits
- Users can still view changes but cannot edit

### Phase 4: Approval and Release (Merge)

```
Service: ChangeOrderService.close()
         → ChangeOrderMergeService.merge()
           → mergeBranchToMain()
```

When the ECO transitions to its final state (e.g., "Approved"), `ChangeOrderService.close()` triggers the merge:

1. **Validate** via `validateMerge(branchId)` -- checks for checkout locks and conflicts
2. **Auto-checkin** all items still checked out
3. **For each changed item**:
   - Get current release state from main via `VersionResolver.getReleasedVersion()`
   - Assign next revision letter via `RevisionService.getNextRevision()` (A->B, B->C, Z->AA)
   - Update the item: `revision = 'B'`, `state = 'Released'`
4. **Create merge commit** via `CommitService.createMergeCommit()`:
   - `parentId = main.headCommitId` (first parent)
   - `mergeParentId = eco.headCommitId` (second parent)
   - `revisionsAssigned = { "P-1001": "B" }`
5. **Archive branch** -- `isArchived = true` for permanent audit trail

```
AFTER MERGE:
  main:         ───C0───C1───C2───C3──────────────C5 (merge commit)
                                  /               /    P-1001 rev B (Released)
  eco/ECO-001:                  C3───C4──────────┘
                                (archived, read-only)
```

### Phase 5: Archival

- `BranchService.archiveBranch(branchId)` sets `isArchived = true`
- Branch no longer appears in branch selectors
- Full commit history preserved for audit

---

## Branch Isolation

The isolation guarantee is implemented by `VersionResolver` in `src/lib/services/VersionResolver.ts`.

### How It Works

When the UI requests items for a branch, `VersionResolver.getBranchItems()` merges two sources:

1. **Main branch items** -- all released items on main
2. **Branch overrides** -- `branchItems` records for this ECO branch

The merge logic:

```
For each item in the design:
  1. Check: does a branchItem override exist for this branch + masterId?
     - YES and changeType != 'deleted' → show the BRANCH version
     - YES and changeType == 'deleted' → hide the item
     - NO → show the MAIN version (inherited)
  2. Also include items with changeType == 'added' (new on branch)
```

This means:

- **ECO A modifying P-1001** sees its modified version; everyone else sees the released version
- **ECO B adding P-2000** sees the new part; nobody else does until ECO B is merged
- **ECO C deleting P-3000** sees the part removed; everyone else still sees it

No data duplication for unmodified items. The branch stores only deltas.

### Version Resolution Methods

| Method                                   | Context               | Behavior                                                  |
| ---------------------------------------- | --------------------- | --------------------------------------------------------- |
| `getReleasedVersion(masterId, designId)` | Main branch           | Walks commit history to find latest version at HEAD       |
| `getWorkingVersion(masterId, branchId)`  | ECO/workspace branch  | Checks `branchItems` first, falls back to main            |
| `getBranchItems(branchId, filters)`      | Full BOM for a branch | Merges main + branch overrides transparently              |
| `getItemAtCommit(masterId, commitId)`    | Time-travel           | Walks ancestor commits to find version at a point in time |

---

## Revision Assignment

Revisions are assigned **only on merge to main**, never during ECO work.

While on an ECO branch, items have `revision = 'DRAFT'`. On merge, `ChangeOrderMergeService` calls `RevisionService.getNextRevision()`:

| Current Revision on Main | Next Revision |
| ------------------------ | ------------- |
| (new item, no revision)  | A             |
| A                        | B             |
| B                        | C             |
| Z                        | AA            |
| AA                       | AB            |

This design ensures:

- **Draft work does not consume revision letters** -- abandoned ECOs waste nothing
- **Parallel ECOs cannot collide** -- revisions are assigned atomically at merge time
- **Revision history is linear** -- no gaps, no out-of-order

The merge commit stores the assignment map in JSONB: `{ "P-1001": "B", "P-1002": "C" }`.

---

## Pre-Release vs. Post-Release Protection

This is the one-way gate that forces the ECO workflow:

- **Pre-release phase**: No item in the design has `state = 'Released'`. You can freely create, edit, and delete items directly on main. This is the initial design phase.
- **Post-release phase**: At least one item has been Released (via an ECO merge). Now main is **protected** -- `ItemService.create()` throws `BranchProtectionError` if you try to add items directly.

Once a design enters post-release, there is no going back. All changes must flow through ECO branches.

---

## Conflict Detection

`ConflictDetectionService` in `src/lib/services/ConflictDetectionService.ts` detects three kinds of conflicts:

### 1. Checkout Locks

Same item checked out by different users on the same or different branches. Prevents concurrent editing.

### 2. Main Divergence

Compares `branchItem.baseItemId` (version when branch was forked) against the current main version. If main has advanced (another ECO merged the same item), the branch base is stale.

```
ECO-001 forked at C3 (P-1001 rev A)
ECO-002 merged at C5 (P-1001 rev B)   ← main advanced
ECO-001 still has baseItemId pointing to rev A  ← STALE
```

### 3. Cross-ECO Conflicts

Two active ECOs modifying the same item. Detected by scanning `branchItems` across all open ECO branches for the same `itemMasterId`.

### Field-Level Conflict Resolution

During merge, if a conflict is detected, the system compares which specific fields each side changed:

- **Different fields modified** -- auto-merge (JSON merge)
- **Same field with same value** -- no conflict
- **Same field with different values** -- manual resolution required

---

## Key Service Files

| Service                    | File                                           | Key Methods                                                       |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| `BranchService`            | `src/lib/services/BranchService.ts`            | `createEcoBranch()`, `lockBranch()`, `archiveBranch()`            |
| `CommitService`            | `src/lib/services/CommitService.ts`            | `create()`, `createMergeCommit()`, `getBranchChanges()`           |
| `CheckoutService`          | `src/lib/services/CheckoutService.ts`          | `checkout()`, `saveChanges()`, `createOnBranch()`                 |
| `VersionResolver`          | `src/lib/services/VersionResolver.ts`          | `getReleasedVersion()`, `getWorkingVersion()`, `getBranchItems()` |
| `ChangeOrderMergeService`  | `src/lib/services/ChangeOrderMergeService.ts`  | `merge()`, `mergeBranchToMain()`, `validateMerge()`               |
| `ConflictDetectionService` | `src/lib/services/ConflictDetectionService.ts` | `detectConflictsForBranch()`, `detectCrossEcoConflicts()`         |
| `ChangeOrderService`       | `src/lib/items/services/ChangeOrderService.ts` | `addAffectedItem()`, `close()`                                    |
| `RevisionService`          | `src/lib/services/RevisionService.ts`          | `getNextRevision()`                                               |

---

## Workflow Trigger

All ECO state transitions go through a single endpoint:

```
POST /api/change-orders/:id/workflow/transition
```

When transitioning to a final state (e.g., "Approved"), the endpoint auto-triggers `close()` which orchestrates the merge. There are no separate `/submit`, `/approve`, or `/release` routes.

---

## Related Documentation

- [Change Management Deep Dive](../change-management-deep-dive.md) -- exhaustive code-level walkthrough with data examples
- [Service Layer](./service-layer.md) -- service dependencies and layering
- [Two-Table Pattern](./two-table-pattern.md) -- how items are stored
