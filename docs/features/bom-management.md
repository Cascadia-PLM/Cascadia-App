# Bill of Materials (BOM) Management

## Overview

Bill of Materials management is one of the core functions of any Product Lifecycle Management system. A BOM defines the hierarchical structure of a product -- which parts make up an assembly, in what quantities, and in what positions. Cascadia implements BOM management as a fully versioned, branch-aware system that integrates with its ECO-as-Branch change control workflow.

In Cascadia, a BOM is not a standalone entity. It is the set of **parent/child relationships** between items (primarily Parts) within a Design. These relationships are stored in the `item_relationships` table with a `relationshipType` of `'BOM'`. Because every item lives on a branch and relationships are tracked through commits, BOM changes follow the same branching and merging model as item data changes.

Key principles of Cascadia's BOM approach:

- **Relationship-based**: BOMs are expressed as directed relationships between items, not as a separate BOM table.
- **Branch-aware**: BOM structures are resolved per-branch, so ECO branches can add or remove children without affecting the released main branch.
- **Version-resolved**: When viewing historical commits or tags, the BOM tree reconstructs the structure as it existed at that point in time.
- **Cross-design capable**: Parts in one design can reference parts in another design, with read-only subtree expansion.
- **ECO-controlled**: After initial release, all BOM changes must go through an Engineering Change Order.

---

## Parent/Child Relationships

### Data Model

BOM relationships use the general-purpose `item_relationships` table. A BOM relationship connects a **source** (parent assembly) to a **target** (child component).

**Schema** (`src/lib/db/schema/items.ts`):

```
item_relationships
├── id              UUID (PK)
├── sourceId        UUID → items.id (parent assembly)
├── targetId        UUID → items.id (child component)
├── relationshipType VARCHAR(50) = 'BOM'
├── quantity        DECIMAL(10,3)
├── referenceDesignator TEXT
├── findNumber      INTEGER
├── metadata        JSONB
├── isComposite     BOOLEAN (default true for BOM)
├── isDirected      BOOLEAN (default true)
├── multiplicityLower INTEGER
├── multiplicityUpper INTEGER
├── usageAttributes JSONB
├── sourceDesignId  UUID → designs.id
├── targetDesignId  UUID → designs.id
├── sourceDomain    VARCHAR(50) ('engineering' | 'manufacturing')
├── targetDomain    VARCHAR(50)
├── derivationMethod VARCHAR(50) ('direct' | 'substitute' | 'addition')
├── derivationNotes TEXT
├── createdAt       TIMESTAMP
├── createdBy       UUID → users.id
├── modifiedAt      TIMESTAMP
├── modifiedBy      UUID → users.id
```

**Unique constraint**: `(sourceId, targetId, relationshipType)` -- a parent can only have one BOM link to a given child.

**Indexes**: `sourceId`, `targetId`, `relationshipType`, and a composite index on `(sourceDesignId, targetDesignId)` for cross-design queries.

### Directionality

All BOM relationships are directed:

- **Source** = parent assembly (the item that "contains" children)
- **Target** = child component (the item "contained by" the parent)

This means:

- Querying `WHERE sourceId = <assemblyId>` returns children (the BOM of that assembly).
- Querying `WHERE targetId = <partId>` returns parents (where-used).

### Example BOM Structure

```
Widget Assembly (WA-1000)
├── [1] Frame Weldment (WA-1100)         qty: 1
│   ├── [1] Frame Tube (WA-1101)         qty: 4
│   ├── [2] Mounting Bracket (WA-1102)   qty: 2
│   └── [3] Baseplate (WA-1103)          qty: 1
├── [2] Drive Module (WA-1200)           qty: 2
│   ├── [1] Motor (WA-1201)             qty: 1
│   ├── [2] Gearbox (WA-1202)           qty: 1
│   └── [3] Wheel Assembly (WA-1203)    qty: 1
│       ├── [1] Wheel (WA-1204)         qty: 1
│       └── [2] Tire (WA-1205)          qty: 1
└── [3] Control Board (WA-1300)          qty: 1
```

Each line in this tree is one row in `item_relationships` where `relationshipType = 'BOM'`.

---

## Relationship Fields

Each BOM relationship carries three key metadata fields:

### Quantity

The number of units of the child required by the parent. Stored as `DECIMAL(10,3)` to support fractional quantities (e.g., 0.5 kg of adhesive, 2.5 meters of wire).

- Default: `1`
- Displayed in the BOM tree as "x{quantity}" when greater than 1
- Tracked in commit history when changed

### Find Number

An integer position identifier that establishes the assembly sequence. Find numbers define the order in which components appear on engineering drawings and assembly instructions.

- Optional field
- Typically sequential integers (1, 2, 3, ...) within a parent
- Displayed in the BOM tree grid and on engineering drawings
- Common convention: find numbers are unique per parent assembly

### Reference Designator

A text field used primarily for electrical and electronic components to identify specific placement positions on a PCB or wiring diagram.

- Optional field
- Examples: `R1`, `R2`, `C1`, `U1`, `J1-J4`
- Supports comma-separated lists for multiple instances
- Stored as free text to accommodate various naming conventions

### History Tracking

All three fields are tracked in the commit history. When a relationship field changes, a commit is created with a `fieldCategory: 'relationship'` change record containing the old and new values. The field change names follow the pattern:

- `bom_quantity_changed` -- quantity was modified
- `bom_refdes_changed` -- reference designator was modified
- `bom_findnumber_changed` -- find number was modified
- `bom_added` / `bom_removed` -- entire relationship was added or removed

---

## BOM Tree Visualization

Cascadia provides an expandable tree-table view for visualizing BOM structures. This is the primary way users interact with BOMs.

### Component Architecture

The BOM tree visualization is built from reusable components in `src/components/bom/`:

| Component            | Purpose                                            |
| -------------------- | -------------------------------------------------- |
| `BomTreeView`        | Core tree-table renderer with two layout modes     |
| `BOMTreeNode` (type) | Shared node interface used across all BOM views    |
| `useTreeSelection`   | Multi-select hook (click, shift-click, ctrl-click) |
| `exportBomTree`      | CSV export of flattened tree data                  |
| `helpers`            | State badge variants, item route generation        |

### Layout Modes

**Grid layout** (`layout="grid"`): A structured table with configurable columns, column resize handles, column filtering, header row with select-all checkbox, and per-column alignment. Each row supports context menus.

**Flow layout** (`layout="flow"`): A simpler list view with item number, name, revision, state badge, and quantity indicator. No column headers.

### BOMTreeNode Interface

All BOM tree components share a common node type (`src/components/bom/types.ts`):

```typescript
interface BOMTreeNode {
  itemId: string
  masterId?: string
  itemNumber: string
  name: string
  revision: string
  state: string
  itemType: string
  designId: string | null
  quantity?: number
  findNumber?: number
  relationshipId?: string
  children?: Array<BOMTreeNode>

  // Cross-design fields
  designCode?: string
  designName?: string
  isExternal?: boolean

  // ECO-specific fields
  isInEco?: boolean
  changeAction?: string | null

  // Cross-design reference fields
  isCrossDesignRef?: boolean
  crossReferenceId?: string
}
```

### Where the Tree Appears

The BOM tree is used in several contexts:

1. **Design Structure Tab** (`src/components/designs/StructureTab.tsx`) -- the main BOM view for a design, showing root assemblies, their children, orphan items, and cross-design references.

2. **Part Relationships Panel** (`src/components/items/PartRelationshipsPanel.tsx`) -- the BOM tab on a part detail page, showing both the children (outgoing BOM) and where-used (incoming BOM) of a specific part, with graph, table, and tree views.

3. **ECO Tree Table** (`src/components/change-orders/EcoTreeTable.tsx`) -- the BOM tree within an ECO context, highlighting which items are affected and their change actions.

### Tree Construction

The BOM tree is built server-side in the `GET /api/designs/:id/structure` endpoint (`src/routes/api/designs/$id/structure.ts`):

1. **Resolve items for the current branch context** (main, ECO branch, historical tag/commit)
2. **Query all BOM relationships** where source items are in the design
3. **Build a children map** mapping each parent ID to its list of children
4. **Identify root items** -- Parts with `inDesignStructure=true` that have no parent in the BOM
5. **Recursively build tree nodes** with cycle detection (visited set)
6. **Add cross-design references** as additional root nodes
7. **Identify orphan items** -- non-Part items and Parts with `inDesignStructure=false`

### Features

- **Expand/collapse**: Click chevron to expand or collapse subtrees
- **Multi-select**: Checkbox selection with shift-click for range, ctrl-click for toggle
- **Column resize**: Drag column borders to resize
- **Column filtering**: Per-column filter popovers
- **Context menus**: Right-click for actions (add child, remove, open detail page, etc.)
- **CSV export**: Export the full indented BOM to a CSV file
- **External badges**: Items from other designs show an amber badge with the source design code

---

## Where-Used Queries

A where-used query answers the question: "What assemblies use this part?" It traverses the BOM in the **reverse direction** -- from child to parent -- to find all ancestors.

### Implementation

Where-used queries are implemented as a recursive CTE (Common Table Expression) in PostgreSQL, found in `ImpactAssessmentService.findWhereUsed()` (`src/lib/items/services/ImpactAssessmentService.ts`):

```sql
WITH RECURSIVE where_used AS (
  -- Base case: direct parents
  SELECT
    r.source_id as item_id,
    i.master_id, i.item_number, i.revision, i.name,
    i.item_type, i.state, i.design_id,
    1 as depth,
    ARRAY[r.target_id, r.source_id] as path,
    r.quantity, r.find_number, r.reference_designator
  FROM item_relationships r
  JOIN items i ON i.id = r.source_id
  WHERE r.target_id = :itemId
    AND r.relationship_type = 'BOM'
    AND i.is_current = true

  UNION ALL

  -- Recursive case: parents of parents
  SELECT
    r.source_id, i.master_id, i.item_number, ...
    wu.depth + 1,
    wu.path || r.source_id,
    r.quantity, r.find_number, r.reference_designator
  FROM item_relationships r
  JOIN items i ON i.id = r.source_id
  JOIN where_used wu ON wu.item_id = r.target_id
  WHERE wu.depth < :maxDepth
    AND r.relationship_type = 'BOM'
    AND i.is_current = true
    AND NOT r.source_id = ANY(wu.path)  -- Prevent cycles
)
SELECT wu.*, d.code as design_code, d.name as design_name
FROM where_used wu
LEFT JOIN designs d ON d.id = wu.design_id
ORDER BY depth, item_number
```

Key characteristics:

- **Max depth**: Configurable, defaults to 15 levels
- **Cycle prevention**: Uses a PostgreSQL array path to detect and prevent circular references
- **Cross-design aware**: Joins with the `designs` table to include design code and name for items in other designs
- **Current versions only**: Filters to `is_current = true` to avoid showing obsolete revisions

### Where It Appears

1. **Graph navigator** on the Part Relationships Panel -- set direction to "incoming" to see where-used as a visual graph
2. **Impact Assessment** -- when running impact analysis on an ECO, where-used traversal identifies all assemblies that could be affected by a part change
3. **API**: `GET /api/items/:id/graph?direction=incoming` returns the where-used graph data

### WhereUsedNode Type

```typescript
interface WhereUsedNode {
  itemId: string
  masterId: string
  itemNumber: string
  revision: string
  name: string
  itemType: string
  state: string
  depth: number
  path: Array<string>
  quantity?: string
  findNumber?: number
  referenceDesignator?: string
  designId?: string | null
  designCode?: string | null
  designName?: string | null
}
```

---

## Multi-Level BOM Expansion

The design structure API provides full multi-level BOM expansion. When you view a design's structure, the server recursively builds the complete tree by:

1. Starting with root items (top-level Parts with no BOM parent)
2. For each item, looking up its BOM children from `item_relationships`
3. Recursively expanding each child's children
4. Attaching quantity and find number to each child node
5. Detecting cycles via a visited set to prevent infinite recursion

### External Subtree Expansion

When a BOM child belongs to a different design (cross-design relationship), the server recursively expands that external item's subtree as well, up to a maximum depth of 10 levels. This allows viewing the full product structure even when components are managed in separate designs.

The expansion algorithm:

1. Identify external target IDs (items not in the current design)
2. Fetch those items with their design info
3. Query their BOM children
4. Repeat until no new external children are found or max depth is reached

### CSV Export

The BOM tree can be exported to CSV via `exportBomTreeToCsv()` (`src/components/bom/exportBomTree.ts`). The export:

- Flattens the tree with a `Level` column (0 = root, 1 = first child level, etc.)
- Includes: Level, Item Number, Name, Revision, State, Type, Quantity, Find Number, Design, External
- Optionally includes ECO fields: In ECO, Change Action
- Uses the level-based indented format, which can be re-imported

---

## Cross-Design References

Cross-design references allow a design to link to items managed in other designs without duplicating them. These references appear as read-only entries in the BOM tree.

### Data Model

Cross-design references use a dedicated table (`src/lib/db/schema/crossReferences.ts`):

```
design_cross_references
├── id                    UUID (PK)
├── referencingDesignId   UUID → designs.id (the design displaying the reference)
├── referencedItemId      UUID → items.id (the item being referenced)
├── sourceDesignId        UUID → designs.id (the design owning the item)
├── branchId              UUID → branches.id (null = on main)
├── changeType            VARCHAR ('added' | 'deleted' | null)
├── inDesignStructure     BOOLEAN (default true)
├── notes                 TEXT
├── createdAt/createdBy   audit fields
├── modifiedAt/modifiedBy audit fields
```

**Unique constraint**: `(referencingDesignId, referencedItemId, branchId)`

### Branch Tracking

Cross-design references follow the same branch pattern as `branchItems`:

| branchId | changeType  | Meaning                             |
| -------- | ----------- | ----------------------------------- |
| NULL     | NULL        | Reference exists on main (baseline) |
| X        | `'added'`   | Reference was added on branch X     |
| X        | `'deleted'` | Reference was removed on branch X   |

This means adding or removing cross-design references can be tracked through ECO branches.

### How They Appear

In the BOM tree:

- Cross-design references appear as **root-level nodes** with `isCrossDesignRef=true`
- They show an amber badge with the source design code (e.g., "STD-LIB")
- Their subtree is expanded recursively (children from the source design are shown read-only)
- The `crossReferenceId` field links back to the `design_cross_references` row for management operations

### Service

`CrossDesignReferenceService` (`src/lib/services/CrossDesignReferenceService.ts`) handles:

- Creating references (validates item exists, is in a different design)
- Querying references for a design (with branch awareness)
- Removing references
- Merging branch references to main during ECO release

---

## BOM Changes via ECO

After a design's initial release, all BOM changes must go through an Engineering Change Order. This ensures that structural changes are reviewed, approved, and tracked.

### How BOM Changes Work in an ECO

1. **Create an ECO** -- this creates a branch from main.
2. **Add affected items** -- the parent assembly that will have its BOM modified must be added as an affected item with a "revise" change action.
3. **Make BOM changes** -- add, remove, or modify child relationships on the working copy of the parent assembly.
4. **Approve and release** -- when the ECO is approved and released, the BOM changes are merged to main along with all other item changes.

### API Endpoint

`POST /api/change-orders/:id/bom-changes` (`src/routes/api/change-orders/$id/bom-changes.ts`):

```typescript
// Request body
{
  parentItemId: string    // Must be an affected item in this ECO
  childItemId: string     // The child to add/remove/modify
  quantity: number        // Default: 1
  findNumber?: number
  action: 'add' | 'remove' | 'modify'
}
```

**Validation rules**:

- The ECO must be in Draft or InReview state
- The parent item must be an affected item in the ECO (matched by affectedItemId or masterId)
- The child item must exist

`DELETE /api/change-orders/:id/bom-changes?relationshipId=<id>`:

- Removes a specific BOM relationship by its relationship ID
- Same validation: ECO must be editable, parent must be an affected item

### Commit Tracking

Every BOM add, remove, or modify operation creates a commit on the ECO branch with:

- A descriptive message: "Added BOM relationship: WA-1000 -> WA-1101"
- Field-level change records with `fieldCategory: 'relationship'`
- The old and new values of the relationship

### Merge Behavior

When an ECO is released, the `ChangeOrderMergeService` handles BOM relationships:

1. For each modified or added item, the service copies all BOM relationships from the source item (old revision or draft) to the new released item.
2. If a child was also revised in the same ECO, the relationship target is resolved to the new released version of that child.
3. This ensures BOM relationships always point to the correct item versions after release.

---

## BOM Import

Cascadia supports importing BOMs from spreadsheet files (CSV and XLSX) with automatic format detection.

### Supported Formats

#### Level-Based (Indented) BOM

The most common BOM export format. A `Level` column indicates the hierarchy depth:

```
Level | Item Number | Name              | Quantity
0     | WA-1000     | Widget Assembly   | 1
1     | WA-1100     | Frame Weldment    | 1
2     | WA-1101     | Frame Tube        | 4
2     | WA-1102     | Mounting Bracket  | 2
1     | WA-1200     | Drive Module      | 2
2     | WA-1201     | Motor             | 1
```

**Algorithm**: Uses a stack to track the current parent at each level. When the level decreases, items are popped from the stack until a valid parent is found.

#### Parent-Child BOM

Each row explicitly names its parent:

```
Item Number | Parent Item Number | Name            | Quantity
WA-1000     |                    | Widget Assembly | 1
WA-1100     | WA-1000            | Frame Weldment  | 1
WA-1101     | WA-1100            | Frame Tube      | 4
WA-1102     | WA-1100            | Mounting Bracket| 2
```

**Algorithm**: Builds an item number to row index map, then matches each row's parent reference to find the relationship.

#### Flat Parts List

No hierarchy information. All parts are created as standalone items with no BOM relationships:

```
Item Number | Name            | Part Type
WA-1101     | Frame Tube      | Manufacture
WA-1102     | Mounting Bracket| Purchase
WA-1201     | Motor           | Purchase
```

### Auto-Detection

The import system automatically detects the BOM format based on which columns are mapped (`src/lib/import/bom-parser.ts`):

| Mapped Columns                      | Detected Format         | Confidence |
| ----------------------------------- | ----------------------- | ---------- |
| `level` only                        | Level-based             | 0.85-0.95  |
| `parentItemNumber` only             | Parent-child            | 0.85-0.95  |
| Both `level` and `parentItemNumber` | Level-based (preferred) | 0.70       |
| Neither                             | Flat                    | 1.00       |

Having a `quantity` column increases confidence by 0.10.

### Import API

Two API endpoints handle BOM import:

- `POST /api/import/parts` -- Create parts from validated rows
- `POST /api/import/parts-bom` -- Create parts AND establish BOM relationships together

The import supports:

- Branch-aware import (direct to main for pre-release designs, or to ECO branch for post-release)
- Quantity, find number, and reference designator from import columns
- External parent support (link to existing items not in the import file)
- BOM validation including cycle detection and duplicate checking

### Import Result

The BOM import returns a `BomImportResult` that extends the standard import result with relationship tracking:

```typescript
interface BomImportResult extends ImportResult {
  relationshipsCreated: number
  relationshipsFailed: number
  failedRelationships: Array<{
    parentItemNumber: string
    childItemNumber: string
    error: string
  }>
}
```

---

## MBOM (Manufacturing BOM)

The Manufacturing BOM represents the structure of a product as it will be manufactured, which often differs from the Engineering BOM (EBOM). Cascadia has foundational MBOM infrastructure with ongoing development.

### Current Status

MBOM support is at the **basic infrastructure** stage. The core service exists but full UI workflows are still in development.

### Design Type Model

MBOMs are represented as separate **Manufacturing** type designs, derived from Engineering designs:

```
designs table:
├── designType = 'Manufacturing'
├── sourceDesignId → Engineering design it was derived from
├── sourceTagId → Specific baseline/tag used as derivation point
└── sourceCommitId → Commit used if no tag specified
```

### Creation Process

`MbomService.createFromEbom()` (`src/lib/services/MbomService.ts`) handles MBOM creation:

1. Validates the source is an Engineering design
2. Creates a new Manufacturing design with source tracking
3. Creates a main branch and initial commit
4. Copies the EBOM structure (items and BOM relationships) into the new design
5. Creates `EBOM_SOURCE` relationships linking each MBOM item back to its EBOM source for traceability
6. Inherits work instruction attachments from EBOM to MBOM items
7. Optionally renumbers items with the MBOM design code prefix

### Digital Thread

The EBOM-to-MBOM relationship provides a digital thread for traceability:

- Each MBOM item has an `EBOM_SOURCE` relationship pointing to its originating EBOM item
- Cross-design relationship fields track `sourceDomain` ('engineering') and `targetDomain` ('manufacturing')
- `derivationMethod` indicates how each item was derived: `'direct'` (as-is copy), `'substitute'` (manufacturing alternative), or `'addition'` (new manufacturing-specific item)

### Upstream Change Detection

The `upstreamChanges` table tracks when the source EBOM changes, allowing the MBOM to detect and review engineering changes:

- When an ECO releases changes in the source Engineering design, upstream change records are created
- The MBOM owner can review changes with actions: `accept`, `reject`, or `defer`
- Accepted changes can optionally trigger creation of a Manufacturing Change Order (MCO)

---

## API Reference

### Relationship CRUD

| Method | Endpoint                          | Description                                                            |
| ------ | --------------------------------- | ---------------------------------------------------------------------- |
| GET    | `/api/v1/items/:id/relationships`    | Get relationships for an item (optional `?type=BOM&branch=<id>`)       |
| POST   | `/api/v1/items/:id/relationships`    | Add a relationship                                                     |
| PUT    | `/api/v1/relationships/:id`          | Update relationship fields (quantity, findNumber, referenceDesignator) |
| DELETE | `/api/v1/relationships/:id`          | Remove a relationship                                                  |
| POST   | `/api/v1/relationships/batch-create` | Batch create up to 500 relationships                                   |

### Design Structure

| Method | Endpoint                            | Description                                                                     |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------- |
| GET    | `/api/v1/designs/:id/structure`        | Get BOM tree (optional `?branch=<id>&tag=<id>&commit=<id>&expandExternal=true`) |
| GET    | `/api/v1/designs/:id/cross-references` | Get cross-design references                                                     |

### Graph / Where-Used

| Method | Endpoint               | Description                                                                             |
| ------ | ---------------------- | --------------------------------------------------------------------------------------- |
| GET    | `/api/v1/items/:id/graph` | Get relationship graph (optional `?depth=2&direction=all&types=BOM&includeUsages=true`) |

### ECO BOM Changes

| Method | Endpoint                                                 | Description                                       |
| ------ | -------------------------------------------------------- | ------------------------------------------------- |
| POST   | `/api/v1/change-orders/:id/bom-changes`                     | Add/remove/modify BOM relationship in ECO context |
| DELETE | `/api/v1/change-orders/:id/bom-changes?relationshipId=<id>` | Remove BOM relationship by ID in ECO context      |

### Import

| Method | Endpoint                | Description                         |
| ------ | ----------------------- | ----------------------------------- |
| POST   | `/api/v1/import/parts`     | Import parts from spreadsheet       |
| POST   | `/api/v1/import/parts-bom` | Import parts with BOM relationships |

### MBOM

| Method | Endpoint                                          | Description               |
| ------ | ------------------------------------------------- | ------------------------- |
| POST   | `/api/v1/mbom`                                       | Create MBOM from EBOM     |
| GET    | `/api/v1/mbom/:designId/upstream-changes`            | Get upstream EBOM changes |
| POST   | `/api/v1/mbom/:designId/upstream-changes/:id/review` | Review an upstream change |

---

## Key Source Files

| File                                                  | Purpose                                          |
| ----------------------------------------------------- | ------------------------------------------------ |
| `src/lib/db/schema/items.ts`                          | `itemRelationships` table definition             |
| `src/lib/db/schema/crossReferences.ts`                | `designCrossReferences` table definition         |
| `src/lib/items/services/ItemRelationshipService.ts`   | Relationship CRUD with branch merging            |
| `src/lib/items/services/ImpactAssessmentService.ts`   | Where-used traversal and impact analysis         |
| `src/lib/services/CrossDesignReferenceService.ts`     | Cross-design reference management                |
| `src/lib/services/MbomService.ts`                     | MBOM creation and upstream change tracking       |
| `src/lib/services/ChangeOrderMergeService.ts`         | BOM relationship copying during ECO release      |
| `src/lib/import/bom-parser.ts`                        | BOM format detection and relationship extraction |
| `src/lib/import/types.ts`                             | BOM import type definitions                      |
| `src/components/bom/BomTreeView.tsx`                  | Core tree-table UI component                     |
| `src/components/bom/types.ts`                         | Shared `BOMTreeNode` interface                   |
| `src/components/bom/exportBomTree.ts`                 | CSV export of BOM trees                          |
| `src/components/bom/useTreeSelection.ts`              | Multi-select hook for tree views                 |
| `src/components/designs/StructureTab.tsx`             | Design structure BOM tab                         |
| `src/components/items/PartRelationshipsPanel.tsx`     | Part-level relationships panel                   |
| `src/components/designs/AddPartToStructureDialog.tsx` | Add child to BOM dialog                          |
| `src/routes/api/designs/$id/structure.ts`             | BOM tree API endpoint                            |
| `src/routes/api/items/$id/relationships.ts`           | Relationship API endpoint                        |
| `src/routes/api/items/$id/graph.ts`                   | Graph/where-used API endpoint                    |
| `src/routes/api/change-orders/$id/bom-changes.ts`     | ECO BOM changes API                              |
| `src/routes/api/relationships/batch-create.ts`        | Batch relationship creation                      |
| `tests/e2e/workflows/bom-management.spec.ts`          | E2E tests for BOM workflows                      |
