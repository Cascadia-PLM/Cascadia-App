# Git-Style Versioning

Cascadia replaces traditional PLM linear revision tracking with a Git-inspired versioning model. Every change is recorded as an immutable commit, work is isolated in branches, and revision letters are assigned only when changes merge to the production baseline.

This document covers the full versioning system from the user's perspective, with enough technical depth to understand the data model driving it.

---

## 1. Overview

### The Problem with Traditional PLM Revision Tracking

Traditional PLM systems track revisions as a linear sequence per item:

```
Part PN-001:  Rev A --> Rev B --> Rev C --> Rev D
```

This linear model creates real engineering problems:

- **Serial bottleneck**: Only one change can be in progress at a time per item. If ECO-001 is revising PN-001 from A to B, ECO-002 must wait.
- **Messy cancellation**: If ECO-001 is cancelled after work has started, the half-done Rev B must be manually cleaned up.
- **Lost context**: Rev C is just "the next revision" -- there is no record of which ECO produced it or what other items changed alongside it.
- **No time travel**: You cannot view the design as it existed at a past milestone without restoring backups.

### Cascadia's Git-Style Approach

Cascadia borrows three foundational ideas from Git:

1. **Branches** isolate concurrent work streams
2. **Commits** create immutable snapshots of every change
3. **Merge** integrates completed work back to the baseline

Applied to PLM, this looks like:

```
main:           [Init] -------- [Merge ECO-001] -------- [Merge ECO-002]
                  |                    ^                        ^
                  |                    |                        |
eco/ECO-001:      +-- [edit] -- [edit]-+                       |
                  |                                            |
eco/ECO-002:      +---------- [edit] -- [edit] -- [edit] ------+
```

Key benefits:

- **Parallel work**: Multiple ECOs can modify the same part simultaneously on separate branches.
- **Clean cancellation**: Deleting a branch discards all uncommitted and committed changes with no cleanup.
- **Grouped changes**: Every commit on an ECO branch records what changed, why, and by whom.
- **Automatic revision assignment**: Revision letters (A, B, C...) are assigned at merge time, not at checkout.
- **Full time travel**: Any historical state can be reconstructed from the commit graph.

---

## 2. Revision Letters

Revision letters are the official identifier for released versions of an item. In Cascadia, they are **only assigned when an ECO merges to the main branch** -- never during the editing process.

### Revision Schemes

Cascadia supports multiple revision schemes, configured per lifecycle:

| Scheme             | Sequence                     | Example                             |
| ------------------ | ---------------------------- | ----------------------------------- |
| `alpha` (default)  | A, B, C, ..., Z, AA, AB, ... | Traditional PLM lettering           |
| `numeric`          | 1, 2, 3, ...                 | Simple numeric versioning           |
| `prefixed-numeric` | X1, X2, X3, ...              | Prefix + number                     |
| `none`             | (no revision tracking)       | For items that don't need revisions |

### How Revision Assignment Works

1. An item exists on main as `PN-001 Rev A (Released)`.
2. An engineer checks it out to an ECO branch. The working copy gets a placeholder revision of `-` (dash) and a state of `Draft` or `Editable`.
3. The engineer makes changes and commits them. The revision remains `-` throughout.
4. When the ECO is approved and released, the system:
   - Looks up the **current** revision on main (which may have advanced if another ECO released first).
   - Calculates the next revision: `A -> B`, `Z -> AA`, `AZ -> BA`.
   - Creates a new released item version: `PN-001 Rev B (Released)`.
   - Marks the previous version as `Superseded`.

### First Release

Items created for the first time have no previous revision. On their first release, they receive revision `A` (or `1`, or the initial value for whatever scheme is configured):

```
On ECO branch:    PN-NEW Rev - (Draft)
After release:    PN-NEW Rev A (Released)
```

This holds for an item created directly on main during the pre-release phase as well, and for the same reason: **a create never states a revision.** `revision` is optional on every create schema, and `ItemService.create` writes the value the item's lifecycle implies -- the placeholder `-` for an ECO-controlled (`Driven`) type, whose revision is the release's to assign, and the scheme's initial revision for anything else, which no release ever revises.

A client that supplies the conventional-looking `"A"` instead breaks this: nothing distinguishes it from a real released revision A, so the first release calculates `A -> B` and the item reaches main as `Rev B` having never been released as `Rev A`. The marker is what makes the first release land on `A` -- `getNextRevision('-')` returns the scheme's first value.

### Concurrent ECO Handling

If two ECOs modify the same part:

- ECO-001 releases first: `PN-001 Rev A -> Rev B`
- ECO-002 releases second: the system sees main is now at `Rev B`, calculates `B -> C`, and assigns `Rev C`.

The placeholder `-` revision is resolved against main's **current** revision at merge time, not the revision at branch creation time. This prevents revision collisions.

---

## 3. Master/Instance Pattern

Every item in Cascadia has two identity fields:

| Field      | Purpose                                                                          |
| ---------- | -------------------------------------------------------------------------------- |
| `id`       | Unique identifier for this specific version (a UUID, changes with each revision) |
| `masterId` | Stable identifier that links all revisions of the same item together             |

When a part is revised from Rev A to Rev B, a new row is inserted with a new `id` but the **same `masterId`**. This allows the system to:

- Track all revisions of the same item across its lifetime
- Resolve "give me the current version of this item" by finding the latest version with a given `masterId`
- Show revision history by querying all items sharing a `masterId`

```
items table:
  id: "abc-111"  masterId: "master-001"  itemNumber: "PN-001"  revision: "A"  isCurrent: false
  id: "abc-222"  masterId: "master-001"  itemNumber: "PN-001"  revision: "B"  isCurrent: false
  id: "abc-333"  masterId: "master-001"  itemNumber: "PN-001"  revision: "C"  isCurrent: true
```

The `isCurrent` flag marks the latest released version. When a new revision is created on merge, the previous version's `isCurrent` is set to `false`.

### Relationship Stability

BOM relationships and cross-references store specific `items.id` values (version-specific). When viewing items at a branch or commit context, the `VersionResolver` translates these to the correct version for that context. This means relationships always point to a concrete version, and the system resolves context-appropriate versions at query time.

### Reading relationships across a revision

A relationship names one item **version**, not a master, and a revision moves
only the source's side of it:

- `createRevisionWorkingCopy` copies the item's **outgoing** edges onto the
  working copy, so the branch can re-quantify or delete a line and have that be
  what ships.
- The merge rebuilds those outgoing edges on the released row, re-pointing a
  target that was revised in the same change order.

Everything else is left exactly where it was pointing, which breaks a naive
read from either direction:

| Read                                | What goes wrong after a revision                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Incoming** -- who points at me?   | Links the item inherited are missed: a test case still names the requirement revision the release superseded, so the new revision reports zero verifying tests and 0% coverage |
| **Incoming** -- who points at me?   | Links a revision left behind are counted twice: rev A and rev B both claim to satisfy the requirement, so the same part is listed twice, once Released and once Superseded     |
| **Outgoing** -- what do I point at? | The reference is a revision behind: the part still names the requirement row the release superseded, and reads back with its `Superseded` badge                                |

`lib/items/version-lineage.ts` owns all three corrections, keyed on one
predicate -- `findSupersededRows`, meaning _not the master's current row, and
not a working copy_:

| Primitive                 | Direction | Rule                                                                              |
| ------------------------- | --------- | --------------------------------------------------------------------------------- |
| `resolveInheritedLineage` | Incoming  | Walk the lineage backwards, so a row is read together with the rows it superseded |
| `findSupersededRows`      | Incoming  | **Drop** the claims a revision left behind                                        |
| `followSupersededRows`    | Outgoing  | **Follow** a stale reference forward to the revision that replaced it             |

`ItemRelationshipService` applies them to the edge table -- `findIncomingLinks`
and `findOutgoingLinks` for the traceability readers, `followSupersededRows`
alone for the generic BOM / reference reader (`getRelationshipsWithDetails`).

Incoming and outgoing are deliberately not symmetric. A stale **target** is
only a stale _reference_ -- the link is the source's own content and still
means what it says, so it is followed forward. A stale **source** is a stale
_claim_: the new revision carries its own copy of the edge whenever it still
means it, so following rev A's edge forward would re-assert a link the change
order may have deleted on purpose.

The lineage walk runs backwards only. A current row inherits the superseded
rows behind it; a working copy inherits the released lineage it was cut from,
so a requirement opened inside an ECO still shows the coverage it arrived with;
a superseded row names only itself, so an old revision still reports what it
actually had. **Nothing ever inherits from a working revision** -- that is what
keeps a link recorded inside one ECO invisible to main and to every other
branch until the merge promotes it.

Thread caches invalidate by lineage for the same reason: a cached thread lists
the rows it resolved to, but the edges behind it can hang off a different
revision of the same item, so a write anywhere in a lineage invalidates the
whole lineage.

#### The same rule for pointer columns

An edge is not the only way one item names another. A few type-specific
columns are foreign keys doing the same job -- `requirements.parent_requirement_id`
is the derive hierarchy -- and they are written once and copied forward by the
type handler onto every later revision of the row that owns them. They need
the same treatment, and got it late: until this change the reads matched
the id they were handed.

`RequirementService` routes both directions of the derive hierarchy through
the primitives above, then resolves the answer at one context:

- **Children** (`getChildRequirements`) expand the parent row's lineage to
  find every row that named it, then resolve each child **master** at the
  parent row's own context. That is what makes the answer one row per child --
  the extra rows are versions of a child, not siblings.
- **The parent** (`getParentRequirement`) resolves the stored row at the
  child row's context, since the child owns the pointer and only the id in it
  is stale.

A row names its own context -- the ECO/workspace branch it is a working copy
on, or its design's released context -- so neither read takes a branch
parameter. Read from inside a branch, both answer with that branch's rows;
read from main, with the current released ones.

---

## 4. Commits

Every change in Cascadia creates a commit -- an immutable snapshot recording what changed, who changed it, and why.

### Commit Structure

```
Commit:
  id:               UUID (unique identifier)
  designId:         UUID (which design this belongs to)
  branchId:         UUID (which branch the commit lives on)
  parentId:         UUID (previous commit on this branch, null for initial)
  mergeParentId:    UUID (second parent for merge commits, null for normal commits)
  message:          "Updated motor mount dimensions for thermal clearance"
  itemsAdded:       0
  itemsChanged:     1
  itemsDeleted:     0
  changeOrderItemId: UUID (links to ECO for release/merge commits)
  revisionsAssigned: { "PN-001": "B", "PN-002": "C" }  (populated on merge to main)
  createdBy:        UUID (the user)
  createdAt:        timestamp
```

### Commit Messages

Commit messages are required and serve as the audit trail. The system generates messages automatically for common operations:

- `"Part PN-001 created"` -- when a new item is created
- `"Part PN-001 updated: weight, material"` -- when fields are modified
- `"Merge ECO-001: Motor mount redesign"` -- when an ECO branch is merged

### Parent Chain

Each commit points to its `parentId` (the previous commit on the same branch). This forms a linked list that can be walked backwards to reconstruct any historical state. The initial commit on a branch has `parentId` set to the branch's `baseCommitId` -- the commit on main where the branch was created.

---

## 5. Commit History

Every design maintains a complete commit history accessible from the design detail view. The history shows:

- All commits on the current branch (or main)
- Author name and timestamp
- Change statistics (items added/modified/deleted)
- Links to the ECO that triggered the change (for release commits)
- Tags (baselines) attached to specific commits

### Per-Item History

Each item also has its own history timeline, visible in the item detail view's History tab. This shows every commit that touched that specific item (by `masterId`), including:

- The commit message
- The change type (added, modified, deleted)
- Field-level diffs showing exactly what changed (e.g., `weight: 10kg -> 20kg`)
- The previous version for comparison

### Branch-Scoped History

When viewing an ECO branch, the history includes:

- Commits made directly on the ECO branch
- Main branch commits up to the fork point (the commit where the branch was created)

This gives engineers context for what the baseline looked like when they started working.

### Deleting an Item, and What Survives

There are two deletes, and only one of them is history.

**Branch-recorded deletion** (`CheckoutService.deleteOnBranch`) is the normal path. The item is marked deleted on the branch, the deletion rides the branch's commits, and the merge carries it to main as an `isDeleted` item. Nothing is destroyed: the item, its versions and its field changes stay readable at any earlier commit or tag, and the deletion itself appears in the history as a change like any other.

**Hard deletion** (`ItemService.delete`) removes the `items` row outright. The row _is_ the version content, so the database cascades from it: `item_versions` and `item_field_changes` go with it, and so do the workflow instance, its history and approvals, a change order's affected and impacted item lists, and a work order's traveler lines and their executions. Per-item history is read from `items` (`CommitService.getItemCommits` selects on `masterId` + `designId`), so a hard-deleted item leaves no readable trace beyond the commits themselves. None of it is recoverable.

Because it is unrecoverable, the hard delete is bounded to rows that do not yet carry evidence meant to outlive them. `ItemService.delete` refuses when:

- the item's state is in its lifecycle's **released family** (released, revising, obsolete, superseded) — released lineage is immutable everywhere else, and this is not an exception;
- the item's state is **final with a `finalKind` of `release` or `complete`** — the record that a release or a build happened. Against the shipped lifecycles that is an approved change order and a completed work order; `cancel` finals and finals that declare no kind (a retired tool, a scrapped physical part) stay deletable;
- the item is governed by a **Driving** definition — a change order — and has **left its initial state**. A change order past Draft holds votes, a locked branch and an affected-item list.

Everything past those bounds is retired through its lifecycle instead: cancel the change order, obsolete the part, or delete it on a branch so the deletion is itself recorded. The rules are read from lifecycle configuration, never from state names, so a renamed or custom lifecycle follows them unchanged.

---

## 6. Design History Graph

Cascadia provides an interactive visual representation of the commit history as a directed acyclic graph (DAG). The graph is built with React Flow (`@xyflow/react`) and laid out using the Dagre graph layout algorithm.

### What the Graph Shows

```
         [main HEAD]
              |
         [Merge ECO-002]  <-- orange dashed merge edge
              |       \
         [Merge ECO-001]  [ECO-002 commit]
              |       \         |
         [Initial]    [ECO-001 commit]
```

- **Nodes**: Each commit is a node showing its message, author, date, and change stats.
- **Solid edges**: Parent relationships (normal commit chain).
- **Orange dashed edges**: Merge relationships (ECO branch merged into main).
- **Color coding**: Green for main, orange for ECO branches, blue for workspace branches, purple for release branches.
- **Tags**: Displayed as badges on the commit node they point to.
- **HEAD marker**: A special node at the top of the main branch column.

### Layout Strategy

The graph uses a bottom-to-top layout (oldest at bottom, newest at top):

1. **Dagre** computes vertical positions based on the commit DAG structure.
2. **Horizontal columns** are assigned by branch type:
   - Column 0: main branch (leftmost)
   - Column 1+: ECO branches, ordered by merge time (first merged = leftmost)
   - Open (unmerged) branches are placed in rightmost columns.
3. **Commit consolidation**: Sequential similar commits (same author, same action type, within 30 minutes) are grouped into a single node to reduce visual clutter. Important commits (merges, ECO-linked, tagged) are never consolidated.

### Navigation

Clicking a commit node navigates to a historical view showing the design as it existed at that commit. This enables reviewing past states without modifying anything.

### Program-Level Graph

At the program level, a cross-design graph shows commits from all designs in the program, with connector edges showing ECOs that span multiple designs.

---

## 7. Branch Isolation

Branch isolation is the core mechanism that enables parallel work. Changes made on an ECO branch are invisible to anyone viewing main (or another branch) until the ECO is released and merged.

### How Isolation Works

The `branchItems` table tracks which items have been modified on each branch:

```
branch_items:
  branchId:      UUID    -- the branch
  itemMasterId:  UUID    -- the item being tracked (stable identity)
  currentItemId: UUID    -- the version being edited on this branch
  baseItemId:    UUID    -- the version when the branch was created (for diff)
  changeType:    string  -- 'added', 'modified', 'deleted', or null (unchanged)
  checkedOutBy:  UUID    -- who has it locked for editing
```

When viewing items on a branch, the `VersionResolver` follows this logic:

1. Check if a `branchItem` exists for the requested item on this branch.
2. If yes, return the `currentItemId` (the branch-specific version).
3. If no, fall back to the released version on main.

This means an ECO branch sees a composite view: its own modified items overlaid on top of the current main baseline. Items not touched by the ECO appear exactly as they do on main.

### Lazy Branch Item Creation

Branch items are created lazily -- only when an item is first checked out to a branch. This avoids copying the entire design's item set when a branch is created, which is critical for large designs with thousands of parts.

### Branch Types

| Type        | Naming                       | Purpose                              | Who Creates                | Merges To                                  |
| ----------- | ---------------------------- | ------------------------------------ | -------------------------- | ------------------------------------------ |
| `main`      | `main`                       | Released/production baseline         | System (one per design)    | N/A                                        |
| `eco`       | `eco/ECO-001`                | Engineering Change Order work        | System (on first checkout) | main (on release)                          |
| `workspace` | `workspace/thermal-analysis` | Personal drafts and experiments      | User                       | Never directly — adopted into an ECO first |
| `release`   | `release/v1.0`               | Hotfix branch from a tagged baseline | User                       | main                                       |

Workspace branches never merge to main themselves. Their exit path is
**adoption**: converting the workspace to a new ECO
(`POST /api/v1/workspaces/:id/convert-to-eco`) or merging it into an existing
one (`POST /api/v1/workspaces/:id/merge-to-eco`). Both are backed by
`ChangeOrderService.adoptWorkspaceItems()`, which **moves** the workspace's
branch items onto the ECO branch — the drafted versions themselves transfer,
nothing is copied — and registers each one in the ECO's reviewed scope
(created items as `release`, checked-out items as `revise`). From there the
normal ECO release machinery merges them to main and assigns revisions. Items
whose master is already on the ECO are skipped, and a workspace emptied by
adoption can be deleted safely.

### Branch Lifecycle

```
Created (active) --> Merged/Archived (ECO released or cancelled)
```

- Review freezes the ECO's **scope** (which items it covers), not its branch:
  work on the items already in scope continues throughout. See
  [Scope Locking](./change-management.md#scope-locking).
- **Locked branches** (`isLocked`) prevent further commits. Locking is a manual
  administrative action (`PATCH /api/v1/branches/:id`); no workflow transition
  sets it.
- **Archived branches** are retained for history but hidden from active branch lists.

### Branch Protection

The main branch becomes protected after the first ECO release (when released items exist). In the protected state:

- Items cannot be checked out directly on main.
- All changes must flow through ECO branches.
- Only the merge operation (triggered by ECO release) can update main.

Before any items are released (pre-release phase), main is unprotected and allows direct editing for initial setup.

---

## 8. Merge Commits

When an ECO is released, its branch is merged into main via a **merge commit**. Merge commits are special because they have two parents:

```
Merge Commit:
  parentId:         UUID  -- the previous HEAD of main (target branch)
  mergeParentId:    UUID  -- the HEAD of the ECO branch (source branch)
  message:          "Merge ECO-001: Motor mount redesign"
  changeOrderItemId: UUID  -- links to the ECO item
  revisionsAssigned: {
    "PN-001": "B",
    "PN-002": "C"
  }
```

### What Happens During Merge

The `ChangeOrderMergeService.mergeBranchToMain()` method orchestrates the following within a serializable transaction:

1. **For each modified item on the ECO branch:**
   - Resolve the placeholder revision (`-`) against main's current revision.
   - Create a new released item version with the assigned revision and `Released` state.
   - Mark the previous version on main as `Superseded` (or `isCurrent: false`).
   - Update the main branch's `branchItem` to point to the new released version.

2. **For each added item:**
   - Assign the initial revision (e.g., `A`).
   - Create the released item version on main.

3. **For each deleted item:**
   - Set the item's state to the lifecycle's obsolete state and soft-delete it
     (`isDeleted`), then drop its `branchItem` row from main.

4. **After all items are processed:**
   - Create a merge commit on the main branch recording all changes.
   - Update main's `headCommitId` to point to the merge commit.
   - Update BOM relationships to point to the new released item versions.
   - Archive the ECO branch.

5. **If the ECO is flagged as a baseline:**
   - Create a tag on the merge commit with the specified baseline name.

### Conflict Detection

Before merge, the system runs conflict detection via `ConflictDetectionService`:

| Conflict Type             | Severity | Description                                                                           |
| ------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `checkout`                | Warning  | Item is still checked out; the release checks it in automatically                     |
| `concurrent_modification` | Error    | Main moved on for this item since the branch was created (another ECO released first) |
| `field_conflict`          | Error    | Same field was changed differently on two branches                                    |
| `cross_eco`               | Warning  | Same item is being modified by another active ECO                                     |
| `no_changes`              | Info     | Branch has no changes to merge (skipped)                                              |
| `branch_not_found`        | Error    | Invalid branch reference                                                              |

Error-severity conflicts block the release, and the same verdict is reported by
the Conflicts tab, the release preview, and the merge itself. Resolve them with
rebase or pull-from-main.

Warnings do not block. They can be marked reviewed (`conflictReviews`) to record
that someone looked at them -- an audit annotation, not an override: nothing is
gated on it.

---

## 9. Baseline Tags

Tags are named pointers to specific commits, creating permanent bookmarks in the design's history. They serve the same purpose as baselines in traditional PLM systems.

### Tag Types

| Type          | Purpose                                              | Example                        |
| ------------- | ---------------------------------------------------- | ------------------------------ |
| `baseline`    | Design review snapshots                              | `PDR-baseline`, `CDR-baseline` |
| `release`     | Product release milestones                           | `v1.0.0`, `v2.0-RC1`           |
| `eco-release` | Auto-created when ECO with baseline flag is released | `ECO-001-release`              |
| `milestone`   | Project milestones                                   | `Phase-2-complete`             |

### Creating Tags

Tags are created on the HEAD commit of the main branch:

```
Design: Widget Assembly Prototype
  main branch HEAD commit: "Merge ECO-003"
  Tag: "CDR-baseline" -> points to that commit
```

Tags can also be auto-created during ECO release when the change order has the `isBaseline` flag set and a `baselineName` specified.

### Using Tags

Tags enable three key capabilities:

1. **Time travel**: View the entire design as it existed at a tagged commit. The `VersionResolver` resolves all items through the commit ancestry at that point.

2. **Comparison**: Compare two tags to see all commits and changes between them. The `CommitService.compareTags()` method computes the commit diff between two tag points using recursive CTE ancestry queries.

3. **Release branches**: Create a release branch from a tag to enable hotfixes on a specific release without affecting ongoing main development.

---

## 10. Change History Tracking

Cascadia records field-level changes for every item modification, enabling precise audit trails.

### How It Works

When an item is modified and committed, the `CheckoutService` computes field-level diffs by comparing the old and new item versions:

```
itemFieldChanges:
  itemVersionId:  UUID     -- links to the itemVersion record in this commit
  fieldName:      string   -- "weight"
  fieldPath:      string   -- "attributes.customField" (for nested fields)
  oldValue:       JSONB    -- 10.5
  newValue:       JSONB    -- 12.3
  fieldCategory:  string   -- "core", "type", "attribute", or "relationship"
```

### Field Categories

| Category       | Fields                    | Examples                                 |
| -------------- | ------------------------- | ---------------------------------------- |
| `core`         | Base item fields          | name, state, revision, itemNumber        |
| `type`         | Type-specific fields      | weight, material, partType, documentType |
| `attribute`    | Custom attributes (JSONB) | Any key in the `attributes` column       |
| `relationship` | BOM/reference changes     | Parent-child relationship modifications  |

### What Gets Tracked

- **Value changes**: `weight: 10kg -> 20kg`
- **State transitions**: `state: Draft -> Released`
- **Nested attribute changes**: `attributes.thermalRating: "Class A" -> "Class B"`
- **Null-to-value**: `material: null -> "Aluminum 6061"` (for newly set fields)
- **Value-to-null**: `leadTimeDays: 14 -> null` (for cleared fields)

### UI Presentation

The History tab on each item shows a timeline of commits with expandable field-level diffs. Each change displays:

- The field name in human-readable format (camelCase converted to title case)
- Old value and new value side by side
- Color-coded badges for the change type (added, modified, deleted)
- The commit message and author

---

## 11. Relationship Change Tracking

BOM (Bill of Materials) and other relationship changes are tracked through the same commit/field-change mechanism as item property changes.

### How Relationship Changes Are Recorded

When items are added to or removed from a BOM, the changes are recorded via the `relationship` field category in `itemFieldChanges`. The `CheckoutService.computeFieldChanges()` function detects changes to relationship-related fields.

### BOM Updates During Merge

When an ECO branch is merged to main, the `ChangeOrderMergeService` updates BOM relationships to point to the newly created released item versions. This is tracked through:

1. An `itemIdMapping` that maps old item version IDs to new released version IDs.
2. Relationship records are updated to reference the new version IDs.
3. Cross-design references are synchronized via `CrossDesignReferenceService`.

### What Is Tracked

- Adding a child to a BOM (parent-child relationship created)
- Removing a child from a BOM (relationship deleted)
- Changing quantity or other relationship properties
- Cross-design references between items in different designs

---

## 12. Version Resolution

The `VersionResolver` service is responsible for answering the question: "What version of this item should I see right now?" The answer depends on the **version context** -- where in the commit/branch/tag graph the user is looking.

### Version Context Types

```typescript
type VersionContext =
  | { type: 'released'; designId: string } // Main branch HEAD
  | { type: 'branch'; branchId: string } // Any branch HEAD
  | { type: 'commit'; commitId: string } // Specific commit
  | { type: 'tag'; tagId: string } // Tag's commit
```

Priority when parsing from URL parameters: `commit > tag > branch > released`.

### Resolution Strategies

**Released context** (`type: 'released'`):

Returns the item as it exists on the main branch HEAD. Resolution order:

1. Walk the main branch's HEAD commit ancestry to find the item's latest version in the commit graph.
2. Fallback: query items directly with `isCurrent: true` (for pre-commit data).
3. Fallback: query items with `state: 'Released'` (for seed data not yet in commit history).

**Branch context** (`type: 'branch'`):

Returns the working version on a specific branch:

1. Check the `branchItems` table for an entry with this branch and item `masterId`.
2. If found (and not deleted), return the `currentItemId`.
3. If not found, fall back to the released version on main (the item hasn't been touched on this branch).

**Commit context** (`type: 'commit'`):

Returns the item as it existed at a specific point in time:

1. Compute the full ancestry of the target commit using a recursive CTE.
2. Find all `itemVersion` records for this item's `masterId`.
3. Walk the item versions in reverse chronological order.
4. Return the first version whose `commitId` is in the ancestor set.
5. If the most recent match is a `deleted` change type, return null.

**Tag context** (`type: 'tag'`):

Resolves to the tag's commit and delegates to the commit strategy.

### Batch Resolution

For listing all items at a context (e.g., the Design Structure view), `getItemsAtContext()` uses optimized batch queries:

- For **branch context**: Fetches all released items, then overlays branch-specific modifications.
- For **commit context**: Fetches all items and `itemVersions` for the design in bulk, then resolves per-masterId in memory using the commit ancestry set.

### Cross-Design Resolution

When resolving relationship targets that point to items in other designs, the `VersionResolver` uses:

- The ECO's design contexts (if the target design is also affected by the same ECO).
- The target design's released version (if the target design is not part of the current ECO).

---

## 13. How Latest Item Per Branch Is Determined

Unlike some PLM systems that use a materialized database view, Cascadia determines the latest item version per `masterId` per branch through the `VersionResolver` service's resolution logic at query time.

### Resolution Logic (Conceptual "currentItemVersions")

The equivalent of a `currentItemVersions` view is computed dynamically:

**For the main branch:**

1. Start from the main branch's `headCommitId`.
2. Compute the commit ancestry (all commits reachable by walking `parentId` and `mergeParentId` chains).
3. For each unique `masterId` in the design, find the most recent `itemVersion` record whose `commitId` is in the ancestry set.
4. If the most recent record has `changeType: 'deleted'`, the item does not exist at this point.
5. Otherwise, return the `itemId` from that `itemVersion` record.

**For ECO/workspace branches:**

1. Check the `branchItems` table for explicit overrides (items checked out or modified on this branch).
2. For items not in `branchItems`, fall back to the main branch resolution above.
3. The composite view is: branch-specific items overlaid on the main baseline.

**For commit/tag contexts:**

1. Compute the commit ancestry from the specific commit.
2. For each `masterId`, find the most recent `itemVersion` in that ancestry.
3. This gives a point-in-time snapshot that never changes (commits are immutable).

### Why Not a Materialized View?

A database view would need to be recomputed on every commit and would not handle branch-specific overlays or historical point-in-time queries. The recursive CTE approach handles all contexts uniformly and is cached effectively by PostgreSQL's query planner for repeated access patterns.

### Performance Considerations

- Commit ancestry is computed via a single recursive CTE query (`WITH RECURSIVE`), which PostgreSQL executes efficiently.
- For batch operations (listing all items), the system fetches all items and versions in bulk and resolves in memory, avoiding N+1 query patterns.
- The `branchItems` table provides a fast shortcut for branch-context queries, avoiding full ancestry traversal when the answer is a simple lookup.

---

## Data Flow Diagrams

### ECO Lifecycle Through Versioning

```
1. CREATE ECO
   |
   v
2. ADD AFFECTED ITEMS           items table: existing Released items identified
   |
   v
3. CHECKOUT ITEM TO ECO         branchItems: entry created with baseItemId = released version
   |                            branches: eco branch created (if first checkout)
   v
4. EDIT ITEM                    items: working copy updated on branch
   |                            branchItems: changeType set to 'modified'
   v
5. COMMIT CHANGES               commits: new commit on ECO branch
   |                            itemVersions: links commit to changed items
   |                            itemFieldChanges: records field-level diffs
   v
6. SUBMIT / APPROVE ECO         branches: ECO branch locked
   |
   v
7. RELEASE ECO (MERGE)          items: new Released version created, old marked Superseded
                                commits: merge commit on main with two parents
                                branchItems (main): updated to point to new version
                                branches: ECO branch archived
                                tags: baseline tag created (if isBaseline)
                                revisionsAssigned: { "PN-001": "B" }
```

### Version Resolution Flow

```
User requests item at context
        |
        v
  +-----+------+
  |  Context?   |
  +--+--+--+---+
     |  |  |  |
     v  v  v  v
 released  branch  commit  tag
     |       |       |       |
     v       |       v       v
  main HEAD  |    walk       lookup tag's
  commit     |    commit     commitId, then
  ancestry   |    ancestry   walk ancestry
     |       v       |
     |    branchItems |
     |    lookup +    |
     |    fallback    |
     |    to main     |
     v       v       v
     +---+---+---+---+
         |
         v
   Return item version
   (or null if deleted)
```

---

## Key Database Tables

| Table              | Purpose                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `items`            | All item versions (each revision is a separate row, linked by `masterId`)     |
| `branches`         | Branch metadata: name, type, HEAD commit, base commit, lock/archive state     |
| `commits`          | Immutable commit records with parent chain, stats, and ECO linkage            |
| `tags`             | Named pointers to specific commits (baselines, releases)                      |
| `branchItems`      | Per-branch item tracking: current version, base version, checkout status      |
| `itemVersions`     | Audit log linking commits to the specific item versions they created/modified |
| `itemFieldChanges` | Field-level change records: old value, new value, field category              |
| `conflictReviews`  | Records of acknowledged merge conflicts for audit purposes                    |

---

## Git Analogy Reference

| Git Concept       | Cascadia Equivalent   | Notes                                               |
| ----------------- | --------------------- | --------------------------------------------------- |
| Repository        | Design                | Version container for a set of related items        |
| Branch            | Branch                | `main`, `eco/ECO-001`, `workspace/kai`              |
| Commit            | Commit                | Immutable snapshot with parent chain                |
| HEAD              | `branch.headCommitId` | Latest commit on a branch                           |
| Merge commit      | Merge commit          | Two parents: main HEAD + ECO branch HEAD            |
| Tag               | Tag                   | Named pointer to a commit                           |
| `git checkout`    | Checkout to branch    | Creates `branchItem` entry, copies released version |
| `git diff`        | Field-level changes   | `itemFieldChanges` table records precise diffs      |
| `git log`         | Commit history        | Walk parent chain from HEAD                         |
| Working directory | Branch items view     | Composite of branch changes + main baseline         |
| `.gitignore`      | N/A                   | All items are tracked                               |
| `git stash`       | N/A                   | Use workspace branches for experimental work        |

---

## See Also

- [Change Orders](./change-management.md) -- ECO workflow and lifecycle
- [Architecture](../architecture/) -- Overall system architecture
- Developer reference: `packages/core/src/lib/services/VersionResolver.ts`, `packages/core/src/lib/services/CommitService.ts`, `packages/core/src/lib/services/BranchService.ts`
