# Item Types Reference

Cascadia PLM manages engineering data through **item types** -- typed records that represent the artifacts of product development. Every item in the system is an instance of a registered item type, and all items share common base fields while carrying type-specific data in a companion table.

This document covers every core item type: its purpose, database schema, lifecycle, relationships, API surface, and UI pages.

---

## The Two-Table Pattern

All item types in Cascadia follow a **two-table pattern**:

1. **`items` table** -- holds fields shared by every item (identity, versioning, audit trail, SysML metadata).
2. **Type-specific table** (e.g., `parts`, `documents`, `change_orders`) -- holds fields unique to that type, joined via `item_id` foreign key.

`ItemService` manages both tables transparently. When you create a Part, it inserts one row into `items` and one into `parts`. The `itemType` discriminator column on `items` tells the system which companion table to join.

### Base Item Fields (all types)

| Column                        | Type             | Description                                                                     |
| ----------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `id`                          | UUID (PK)        | Unique row identifier                                                           |
| `master_id`                   | UUID             | Stable identity across revisions (all revisions of the same item share this)    |
| `item_number`                 | varchar(100)     | Human-readable identifier (e.g., `PN-000001`)                                   |
| `revision`                    | varchar(10)      | Revision letter/number (assigned on ECO merge for driven types)                 |
| `item_type`                   | varchar(50)      | Discriminator: `Part`, `Document`, `ChangeOrder`, etc.                          |
| `name`                        | varchar(500)     | Display name                                                                    |
| `state`                       | varchar(50)      | Current lifecycle state (e.g., `Draft`, `Released`)                             |
| `is_current`                  | boolean          | Whether this is the current version                                             |
| `design_id`                   | UUID (FK)        | Which design this item belongs to                                               |
| `commit_id`                   | UUID (FK)        | Which commit introduced this version                                            |
| `in_design_structure`         | boolean          | Whether part appears as root in BOM tree                                        |
| `attributes`                  | JSONB            | Extensible key-value attributes                                                 |
| `metamodel`                   | varchar(50)      | `cascadia`, `sysml2`, or `kerml`                                                |
| `sysml_type`                  | varchar(100)     | SysML v2 type mapping                                                           |
| `usage_of`                    | UUID             | If set, this item is a "usage" referencing a definition item (SysML v2 pattern) |
| `is_deleted`                  | boolean          | Soft delete flag                                                                |
| `locked_by` / `locked_at`     | UUID / timestamp | Pessimistic lock for checkout                                                   |
| `created_at` / `created_by`   | timestamp / UUID | Audit: creation                                                                 |
| `modified_at` / `modified_by` | timestamp / UUID | Audit: last modification                                                        |

### Item Numbering

Each item type has a default numbering scheme defined in `src/lib/items/numbering/schemes.ts`:

| Item Type       | Prefix | Example      |
| --------------- | ------ | ------------ |
| Part            | `PN`   | `PN-000001`  |
| Document        | `DOC`  | `DOC-000001` |
| ChangeOrder     | `ECO`  | `ECO-000001` |
| Requirement     | `REQ`  | `REQ-000001` |
| Task            | `TSK`  | `TSK-000001` |
| TestPlan        | `TP`   | `TP-000001`  |
| TestCase        | `TC`   | `TC-000001`  |
| Issue           | `ISS`  | `ISS-000001` |
| WorkInstruction | `WI`   | `WI-000001`  |

Most types allow manual entry of item numbers. Change Orders are always auto-numbered. Parts support family variant numbering (e.g., `PN-000001-001`).

### Lifecycle Categories

Item types use one of three lifecycle categories:

- **Driven** -- state transitions are controlled by ECOs. Cannot be modified on `main` directly. (Part, Document, Requirement)
- **Driving** -- the ECO itself, which controls Driven lifecycles. (ChangeOrder)
- **Free** -- self-controlled, no ECO required. Can transition states independently. (Task, TestPlan, TestCase, WorkInstruction, Issue)

---

## 1. Part

**Purpose:** Represents a physical or logical component in the product structure. Parts are the primary building blocks of BOMs (Bills of Materials) and are the most common item type in any PLM system.

**Lifecycle:** Driven (controlled by ECOs)

**Default State:** Draft

**Numbering:** `PN-000001` (family variants: `PN-000001-001`)

### Type-Specific Fields

| Column                 | Type                   | Description                                         |
| ---------------------- | ---------------------- | --------------------------------------------------- |
| `item_id`              | UUID (PK, FK to items) | Links to base item                                  |
| `description`          | text                   | Detailed part description                           |
| `part_type`            | varchar(20)            | `Manufacture`, `Purchase`, `Phantom`, or `Software` |
| `material`             | varchar(100)           | Material specification (e.g., `Aluminum 6061`)      |
| `weight`               | decimal(10,3)          | Part weight                                         |
| `weight_unit`          | varchar(10)            | Unit of weight (default: `kg`)                      |
| `cost`                 | decimal(10,2)          | Unit cost                                           |
| `cost_currency`        | varchar(3)             | Currency code (default: `USD`)                      |
| `lead_time_days`       | integer                | Procurement/manufacturing lead time                 |
| `quantity_on_hand`     | integer                | Current inventory count                             |
| `reorder_point`        | integer                | Inventory reorder threshold                         |
| `location`             | text                   | Storage location                                    |
| `last_inventory_check` | timestamp              | Last physical inventory date                        |

### Part Types

| Part Type       | Description                                                                      |
| --------------- | -------------------------------------------------------------------------------- |
| **Manufacture** | Fabricated in-house from raw materials or sub-assemblies                         |
| **Purchase**    | Procured from external suppliers (COTS components)                               |
| **Phantom**     | Logical grouping that does not exist as a physical unit (used for BOM structure) |
| **Software**    | Software component or firmware                                                   |

### Lifecycle States

Draft -> In Review -> Approved -> Released -> Obsolete

### Relationships

| Relationship | Target Type | Description                                         |
| ------------ | ----------- | --------------------------------------------------- |
| `BOM`        | Part        | Bill of Materials (parent-child assembly structure) |
| `Document`   | Document    | Attached drawings, specs, datasheets                |
| `Change`     | ChangeOrder | ECOs affecting this part                            |

### API Endpoints

| Method | Path                               | Description                                                            |
| ------ | ---------------------------------- | ---------------------------------------------------------------------- |
| GET    | `/api/v1/items/search?itemType=Part`  | Search/list parts                                                      |
| GET    | `/api/v1/items/$id`                   | Get part by ID (with optional `?branch=`, `?commit=`, `?tag=` context) |
| POST   | `/api/v1/items/$id`                   | Create part                                                            |
| PUT    | `/api/v1/items/$id`                   | Update part                                                            |
| DELETE | `/api/v1/items/$id`                   | Delete part                                                            |
| GET    | `/api/v1/parts/$id`                   | Part-specific detail endpoint                                          |
| GET    | `/api/v1/parts/$id/validating-tests`  | Get test cases that validate this part                                 |
| GET    | `/api/v1/items/$id/history`           | Version history                                                        |
| POST   | `/api/v1/items/$id/checkin`           | Check in after editing                                                 |
| POST   | `/api/v1/items/$id/cancel-checkout`   | Cancel checkout                                                        |
| GET    | `/api/v1/items/$id/lock-status`       | Check lock status                                                      |
| POST   | `/api/v1/items/$id/unlock`            | Force unlock                                                           |
| POST   | `/api/v1/items/$itemId/files/upload`  | Upload file attachment (CAD model, drawing)                            |
| GET    | `/api/v1/items/$itemId/files`         | List attached files                                                    |
| GET    | `/api/v1/items/$itemId/files/primary` | Get primary CAD model                                                  |
| GET    | `/api/v1/items/$id/thumbnail`         | Get thumbnail image                                                    |

### UI Pages

| Path         | Component   | Description                            |
| ------------ | ----------- | -------------------------------------- |
| `/parts`     | Parts index | List/search all parts                  |
| `/parts/new` | PartForm    | Create new part                        |
| `/parts/$id` | Part detail | View part details, BOM, files, history |

### Key Files

- Schema: `src/lib/db/schema/items.ts` (parts table)
- Types: `src/lib/items/types/part.ts`
- Form: `src/components/parts/PartForm.tsx`

---

## 2. Document

**Purpose:** Version-controlled file containers for engineering documents -- drawings, specifications, datasheets, test reports, and any other files that need formal revision control.

**Lifecycle:** Driven (controlled by ECOs)

**Default State:** Draft

**Numbering:** `DOC-000001`

### Type-Specific Fields

| Column         | Type                   | Description                         |
| -------------- | ---------------------- | ----------------------------------- |
| `item_id`      | UUID (PK, FK to items) | Links to base item                  |
| `description`  | text                   | Document description                |
| `file_id`      | UUID                   | Reference to file in vault storage  |
| `file_name`    | varchar(500)           | Original file name                  |
| `file_size`    | integer                | File size in bytes                  |
| `mime_type`    | varchar(100)           | MIME type (e.g., `application/pdf`) |
| `storage_path` | text                   | Path in vault storage               |

### Lifecycle States

Draft -> In Review -> Approved -> Released -> Obsolete

### Relationships

| Relationship | Target Type | Description                                |
| ------------ | ----------- | ------------------------------------------ |
| `Part`       | Part        | Parts this document describes or specifies |
| `Change`     | ChangeOrder | ECOs affecting this document               |

### File Management

Documents integrate with the vault file system for version-controlled file storage. Files support:

- **Check-out/check-in** workflow via `/api/v1/files/$fileId/checkout` and `/api/v1/files/$fileId/checkin`
- **Version history** via `/api/v1/files/$fileId/versions`
- **Download** via `/api/v1/files/$fileId/versions/$version/download`
- **CAD conversion** via `/api/v1/files/$fileId/convert` (STEP/IGES to STL/GLB)
- **Metadata** via `/api/v1/files/$fileId/metadata`

### API Endpoints

| Method | Path                                            | Description                        |
| ------ | ----------------------------------------------- | ---------------------------------- |
| GET    | `/api/v1/items/search?itemType=Document`           | Search/list documents              |
| GET    | `/api/v1/items/$id`                                | Get document by ID                 |
| POST   | `/api/v1/items/$id`                                | Create document                    |
| PUT    | `/api/v1/items/$id`                                | Update document                    |
| DELETE | `/api/v1/items/$id`                                | Delete document                    |
| GET    | `/api/v1/documents/$id`                            | Document-specific detail endpoint  |
| POST   | `/api/v1/files`                                    | Upload a new file                  |
| GET    | `/api/v1/files/$fileId`                            | Get file metadata                  |
| POST   | `/api/v1/files/$fileId/checkout`                   | Check out file for editing         |
| POST   | `/api/v1/files/$fileId/checkin`                    | Check in edited file               |
| GET    | `/api/v1/files/$fileId/versions`                   | List file versions                 |
| GET    | `/api/v1/files/$fileId/versions/$version/download` | Download specific version          |
| POST   | `/api/v1/files/$fileId/convert`                    | Convert CAD file (STEP to STL/GLB) |

### UI Pages

| Path             | Component       | Description                                    |
| ---------------- | --------------- | ---------------------------------------------- |
| `/documents`     | Documents index | List/search all documents                      |
| `/documents/new` | DocumentForm    | Create new document with file upload           |
| `/documents/$id` | Document detail | View document, download files, version history |

### Key Files

- Schema: `src/lib/db/schema/items.ts` (documents table)
- Types: `src/lib/items/types/document.ts`
- Form: `src/components/documents/DocumentForm.tsx`
- Vault schema: `src/lib/db/schema/vault.ts`

---

## 3. Change Order

**Purpose:** Formalizes engineering changes through a structured approval workflow. Change Orders are the "driving" mechanism of Cascadia's ECO-as-Branch model -- creating an ECO creates an isolated branch where engineers can make changes without affecting the released baseline on `main`.

**Lifecycle:** Driving (controls Driven lifecycles for Parts, Documents, Requirements)

**Default State:** Draft

**Numbering:** `ECO-000001` (always auto-numbered)

### Type-Specific Fields

| Column                     | Type                   | Description                                     |
| -------------------------- | ---------------------- | ----------------------------------------------- |
| `item_id`                  | UUID (PK, FK to items) | Links to base item                              |
| `change_type`              | varchar(20)            | `ECO`, `ECN`, `Deviation`, `MCO`, or `XCO`      |
| `priority`                 | varchar(20)            | `low`, `medium`, `high`, or `critical`          |
| `reason_for_change`        | text                   | Why the change is needed                        |
| `impact_description`       | text                   | What areas are affected                         |
| `implementation_date`      | timestamp              | Target implementation date                      |
| `submitted_at`             | timestamp              | When the ECO was submitted for review           |
| `approved_at`              | timestamp              | When the ECO was approved                       |
| `approved_by`              | UUID (FK to users)     | Who approved the ECO                            |
| `implemented_at`           | timestamp              | When changes were implemented                   |
| `closed_at`                | timestamp              | When the ECO was closed                         |
| `impact_assessment_status` | varchar(20)            | `pending`, `in_progress`, `completed`, `failed` |
| `risk_level`               | varchar(20)            | `low`, `medium`, `high`, `critical`             |
| `is_baseline`              | boolean                | Whether to create a baseline on release         |
| `baseline_name`            | varchar(100)           | Name for the baseline                           |

### Change Order Types

| Type          | Full Name                     | Description                                     |
| ------------- | ----------------------------- | ----------------------------------------------- |
| **ECO**       | Engineering Change Order      | Standard engineering change (most common)       |
| **ECN**       | Engineering Change Notice     | Notification of a change (informational)        |
| **MCO**       | Manufacturing Change Order    | Manufacturing process change                    |
| **Deviation** | Deviation                     | Temporary departure from released configuration |
| **XCO**       | Cross-Functional Change Order | Changes spanning multiple functional areas      |

### Change Actions

Each affected item on an ECO has a change action:

| Action     | Description                               |
| ---------- | ----------------------------------------- |
| `release`  | Release a new item for the first time     |
| `revise`   | Create a new revision of an existing item |
| `obsolete` | Mark an item as obsolete                  |
| `add`      | Add a new item to the design              |
| `remove`   | Remove an item from the design            |
| `promote`  | Promote an item to a new lifecycle state  |

### Lifecycle States

Draft -> Submitted -> Impact Assessment -> Review -> Approved -> Implementation -> Implemented -> Closed

Also: Rejected (from Review)

### Related Tables

The Change Order has several supporting tables beyond the main `change_orders` table:

| Table                         | Description                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `change_order_affected_items` | Items directly affected by this ECO, with change action and working copies                  |
| `change_order_impacted_items` | Items discovered by impact analysis (where-used, BOM children, etc.)                        |
| `change_order_risks`          | Risk assessments (inventory, production, cost, schedule, compliance, quality, cross-design) |
| `change_order_impact_reports` | Summary reports of impact analysis runs                                                     |
| `change_order_designs`        | Designs affected by this ECO, with branch/merge status                                      |

### ECO-as-Branch Workflow

1. **Create ECO** -- An ECO item is created, and a branch record is established in `change_order_designs` for each affected design.
2. **Add affected items** -- Items are added with change actions (`revise`, `add`, `obsolete`, etc.).
3. **Checkout** -- Items are checked out to the ECO branch via `CheckoutService`. Working copies are created on the branch for `revise` actions.
4. **Edit** -- Engineers modify working copies on the branch. Changes are isolated from `main`.
5. **Impact assessment** -- `ImpactAssessmentService` discovers downstream impacts (where-used, BOM children, document references).
6. **Submit and review** -- ECO transitions through workflow states. Approvers review changes.
7. **Approve and release** -- On final approval, `EcoReleaseService` merges the branch to `main`, assigns revision letters (A, B, C...), and updates lifecycle states.

### Relationships

| Relationship | Target Type                 | Description                   |
| ------------ | --------------------------- | ----------------------------- |
| `Affects`    | Part, Document, ChangeOrder | Items affected by this change |
| `Document`   | Document                    | Supporting documentation      |

### API Endpoints

| Method | Path                                                  | Description                            |
| ------ | ----------------------------------------------------- | -------------------------------------- |
| GET    | `/api/v1/items/search?itemType=ChangeOrder`              | Search/list change orders              |
| GET    | `/api/v1/change-orders/$id`                              | Get change order with full details     |
| POST   | `/api/v1/items/$id`                                      | Create change order                    |
| PUT    | `/api/v1/items/$id`                                      | Update change order                    |
| GET    | `/api/v1/change-orders/$id/affected-items`               | List affected items                    |
| POST   | `/api/v1/change-orders/$id/affected-items`               | Add affected item                      |
| POST   | `/api/v1/change-orders/$id/checkout`                     | Checkout items to ECO branch           |
| GET    | `/api/v1/change-orders/$id/designs`                      | List designs affected by ECO           |
| GET    | `/api/v1/change-orders/$id/designs/$designId/structure`  | View BOM structure on ECO branch       |
| POST   | `/api/v1/change-orders/$id/impact-assessment`            | Run impact assessment                  |
| GET    | `/api/v1/change-orders/$id/risks`                        | List risk assessments                  |
| GET    | `/api/v1/change-orders/$id/conflicts`                    | Detect merge conflicts                 |
| POST   | `/api/v1/change-orders/$id/resolve-conflicts`            | Resolve merge conflicts                |
| GET    | `/api/v1/change-orders/$id/conflict-reviews`             | Review conflict resolutions            |
| POST   | `/api/v1/change-orders/$id/release`                      | Release (merge to main)                |
| GET    | `/api/v1/change-orders/$id/summary`                      | Get ECO summary                        |
| GET    | `/api/v1/change-orders/$id/bom-changes`                  | View BOM-level changes                 |
| GET    | `/api/v1/change-orders/$id/branch-history`               | View branch commit history             |
| GET    | `/api/v1/change-orders/$id/branch-history/graph`         | Visual commit graph                    |
| POST   | `/api/v1/change-orders/$id/workflow/transition`          | Transition workflow state              |
| GET    | `/api/v1/change-orders/$id/workflow/validate-transition` | Validate a transition before executing |
| GET    | `/api/v1/change-orders/$id/workflow/history`             | Workflow transition history            |
| GET    | `/api/v1/change-orders/$id/workflow/structure`           | Workflow definition structure          |
| GET    | `/api/v1/change-orders/$id/approvals`                    | List approval records                  |
| GET    | `/api/v1/change-orders/$id/approvals/can-approve`        | Check if current user can approve      |
| POST   | `/api/v1/change-orders/$id/approvals/$stateId`           | Submit approval/rejection              |
| GET    | `/api/v1/change-orders/editable`                         | List ECOs the user can edit            |

### UI Pages

| Path                 | Component           | Description                                                      |
| -------------------- | ------------------- | ---------------------------------------------------------------- |
| `/change-orders`     | Change Orders index | List/search all ECOs                                             |
| `/change-orders/new` | ChangeOrderForm     | Create new ECO                                                   |
| `/change-orders/$id` | Change Order detail | Full ECO view: affected items, impact, approvals, branch history |

### Key Files

- Schema: `src/lib/db/schema/items.ts` (change_orders and related tables)
- Types: `src/lib/items/types/change-order.ts`
- Form: `src/components/change-orders/ChangeOrderForm.tsx`
- Service: `src/lib/items/services/ChangeOrderService.ts`
- Release: `src/lib/services/EcoReleaseService.ts` (in service layer)

---

## 4. Requirement

**Purpose:** Captures product requirements -- what the product must do, how well it must perform, and how compliance will be verified. Requirements support hierarchical decomposition (parent/child), verification tracking, and traceability to parts and test cases.

**Lifecycle:** Driven (controlled by ECOs)

**Default State:** Draft

**Numbering:** `REQ-000001`

### Type-Specific Fields

| Column                  | Type                   | Description                                                                           |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `item_id`               | UUID (PK, FK to items) | Links to base item                                                                    |
| `description`           | text                   | Requirement description                                                               |
| `type`                  | varchar(50)            | `Functional`, `Non-Functional`, `Performance`, `Security`, `Usability`, or `Business` |
| `priority`              | varchar(20)            | `MustHave`, `ShouldHave`, `CouldHave`, or `WontHave` (MoSCoW)                         |
| `status`                | varchar(50)            | `Proposed`, `Approved`, `Implemented`, `Verified`, or `Rejected`                      |
| `acceptance_criteria`   | text                   | Conditions for requirement satisfaction                                               |
| `source`                | varchar(200)           | Origin of the requirement (e.g., customer, standard, regulation)                      |
| `category`              | varchar(100)           | Grouping category                                                                     |
| `verification_method`   | varchar(50)            | `Analysis`, `Inspection`, `Demonstration`, or `Test`                                  |
| `verification_status`   | varchar(50)            | `NotStarted`, `InProgress`, `Passed`, `Failed`, or `Waived`                           |
| `allocated_design_id`   | UUID (FK to designs)   | Design element this requirement is allocated to                                       |
| `parent_requirement_id` | UUID (FK to items)     | Parent requirement (for derived requirements hierarchy)                               |

### Lifecycle States

Draft -> Proposed -> In Review -> Approved -> Implemented -> Verified -> Rejected

### Relationships

| Relationship | Target Type | Description                         |
| ------------ | ----------- | ----------------------------------- |
| `Part`       | Part        | Parts that satisfy this requirement |
| `Document`   | Document    | Related specification documents     |
| `Dependency` | Requirement | Requirements this depends on        |

### Verification Methods

Requirements support formal verification tracking (common in aerospace and defense):

| Method            | Description                                      |
| ----------------- | ------------------------------------------------ |
| **Analysis**      | Verified by analysis, calculation, or simulation |
| **Inspection**    | Verified by visual examination                   |
| **Demonstration** | Verified by operational demonstration            |
| **Test**          | Verified by formal test procedure                |

### API Endpoints

| Method | Path                                           | Description                                 |
| ------ | ---------------------------------------------- | ------------------------------------------- |
| GET    | `/api/v1/items/search?itemType=Requirement`       | Search/list requirements                    |
| GET    | `/api/v1/items/$id`                               | Get requirement by ID                       |
| POST   | `/api/v1/items/$id`                               | Create requirement                          |
| PUT    | `/api/v1/items/$id`                               | Update requirement                          |
| GET    | `/api/v1/requirements/$id`                        | Requirement-specific detail                 |
| POST   | `/api/v1/requirements/$id/derive`                 | Create derived (child) requirement          |
| GET    | `/api/v1/requirements/$id/parent`                 | Get parent requirement                      |
| POST   | `/api/v1/requirements/$id/satisfy`                | Mark requirement as satisfied by a part     |
| GET    | `/api/v1/requirements/$id/verifying-tests`        | Get test cases that verify this requirement |
| GET    | `/api/v1/items/$id/satisfied-requirements`        | Get requirements satisfied by an item       |
| GET    | `/api/v1/designs/$designId/requirements-coverage` | Requirements coverage report                |
| GET    | `/api/v1/designs/$designId/verification-gaps`     | Find unverified requirements                |
| GET    | `/api/v1/designs/$designId/gap-analysis`          | Full gap analysis                           |

### UI Pages

| Path                | Component          | Description                                         |
| ------------------- | ------------------ | --------------------------------------------------- |
| `/requirements`     | Requirements index | List/search all requirements                        |
| `/requirements/new` | RequirementForm    | Create new requirement                              |
| `/requirements/$id` | Requirement detail | View requirement, traceability, verification status |

### Key Files

- Schema: `src/lib/db/schema/items.ts` (requirements table)
- Types: `src/lib/items/types/requirement.ts`
- Form: `src/components/requirements/RequirementForm.tsx`

---

## 5. Task

**Purpose:** Tracks work items, action items, and engineering tasks. Tasks use a Kanban-style workflow and are the only item type that does not require a design association. They can be scoped to a program or used standalone.

**Lifecycle:** Free (self-controlled, no ECO required)

**Default State:** Backlog

**Numbering:** `TSK-000001`

### Type-Specific Fields

| Column            | Type                   | Description                            |
| ----------------- | ---------------------- | -------------------------------------- |
| `item_id`         | UUID (PK, FK to items) | Links to base item                     |
| `program_id`      | UUID (FK to programs)  | Program this task belongs to           |
| `parent_task_id`  | UUID (FK to items)     | Parent task for sub-task hierarchy     |
| `description`     | text                   | Task description                       |
| `assignee`        | UUID (FK to users)     | Assigned user                          |
| `priority`        | varchar(20)            | `Low`, `Medium`, `High`, or `Critical` |
| `due_date`        | timestamp              | Task due date                          |
| `estimated_hours` | decimal(6,2)           | Estimated effort in hours              |
| `actual_hours`    | decimal(6,2)           | Actual effort in hours                 |
| `tags`            | JSONB (string array)   | Categorization tags                    |

### Lifecycle States (Kanban)

Backlog -> To Do -> In Progress -> In Review -> Done

Also: Cancelled

### Relationships

| Relationship | Target Type | Description               |
| ------------ | ----------- | ------------------------- |
| `Blocker`    | Task        | Tasks that block this one |
| `Dependency` | Task        | Tasks this depends on     |
| `Document`   | Document    | Related documents         |

### API Endpoints

| Method | Path                              | Description          |
| ------ | --------------------------------- | -------------------- |
| GET    | `/api/v1/items/search?itemType=Task` | Search/list tasks    |
| GET    | `/api/v1/items/$id`                  | Get task by ID       |
| POST   | `/api/v1/items/$id`                  | Create task          |
| PUT    | `/api/v1/items/$id`                  | Update task          |
| GET    | `/api/v1/tasks/$id`                  | Task-specific detail |

### UI Pages

| Path         | Component   | Description                            |
| ------------ | ----------- | -------------------------------------- |
| `/tasks`     | Tasks index | List/search tasks, Kanban view         |
| `/tasks/new` | TaskForm    | Create new task                        |
| `/tasks/$id` | Task detail | View task details, sub-tasks, blockers |

### Key Files

- Schema: `src/lib/db/schema/items.ts` (tasks table)
- Types: `src/lib/items/types/task.ts`
- Form: `src/components/tasks/TaskForm.tsx`

---

## 6. Work Instruction

**Purpose:** Rich, step-by-step manufacturing instructions that guide operators through assembly, inspection, and test procedures. Work Instructions feature a block-based content editor with support for text, images, parametric values (live part data), and data collection fields. They can be attached to parts and executed as formal records.

**Lifecycle:** Free (self-controlled, no ECO required)

**Default State:** Draft

**Numbering:** `WI-000001`

### Type-Specific Fields

| Column           | Type                   | Description                          |
| ---------------- | ---------------------- | ------------------------------------ |
| `item_id`        | UUID (PK, FK to items) | Links to base item                   |
| `description`    | text                   | Work instruction description         |
| `estimated_time` | integer                | Estimated completion time in minutes |
| `difficulty`     | varchar(20)            | `Easy`, `Medium`, or `Hard`          |
| `safety_notes`   | text                   | Safety considerations and warnings   |
| `required_tools` | text                   | Tools and equipment needed           |

### Supporting Tables

Work Instructions have a rich sub-structure stored across several tables:

#### Operations (`work_instruction_operations`)

Named groupings of steps (e.g., "Assembly", "Inspection", "Final Test").

| Column                | Type         | Description               |
| --------------------- | ------------ | ------------------------- |
| `id`                  | UUID (PK)    | Operation identifier      |
| `work_instruction_id` | UUID (FK)    | Parent work instruction   |
| `order_index`         | integer      | Display order             |
| `title`               | varchar(500) | Operation name            |
| `description`         | text         | Operation description     |
| `estimated_time`      | integer      | Estimated time in minutes |

#### Steps (`work_instruction_steps`)

Individual steps within a work instruction. Each step contains an array of content blocks stored as JSONB.

| Column                | Type                  | Description                          |
| --------------------- | --------------------- | ------------------------------------ |
| `id`                  | UUID (PK)             | Step identifier                      |
| `work_instruction_id` | UUID (FK)             | Parent work instruction              |
| `operation_id`        | UUID (FK, nullable)   | Parent operation (optional grouping) |
| `order_index`         | integer               | Display order                        |
| `title`               | varchar(500)          | Step title                           |
| `content`             | JSONB (`StepContent`) | Block-based content (see below)      |

#### Step Content Block Types

Each step's `content` field is a `StepContent` object containing an array of blocks:

| Block Type   | Description                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `text`       | Rich text HTML content                                                                                                                           |
| `image`      | Image from vault (with alt text and caption)                                                                                                     |
| `parametric` | Live value pulled from a part attribute (e.g., weight, material, custom attributes). Updates automatically when the part changes.                |
| `dataField`  | Data collection field filled in during execution. Types: `text`, `numeric`, `checkbox`, `passFail`. Supports validation rules (min/max/pattern). |

#### Part Attachments (`work_instruction_part_attachments`)

Links Work Instructions to Parts, typically MBOM parts. Supports automatic inheritance from EBOM to MBOM designs.

| Column                | Type      | Description                                               |
| --------------------- | --------- | --------------------------------------------------------- |
| `work_instruction_id` | UUID (FK) | Parent work instruction                                   |
| `part_id`             | UUID (FK) | Attached part                                             |
| `inherit_to_mbom`     | boolean   | Auto-attach to derived manufacturing BOMs                 |
| `inherited_from_id`   | UUID      | Source attachment (for EBOM-to-MBOM inheritance tracking) |

#### Change Alerts (`work_instruction_change_alerts`)

Notifies work instruction authors when linked parts change.

| Column                           | Type                 | Description                                              |
| -------------------------------- | -------------------- | -------------------------------------------------------- |
| `work_instruction_id`            | UUID (FK)            | Affected work instruction                                |
| `part_id`                        | UUID (FK)            | Changed part                                             |
| `eco_id`                         | UUID (FK, nullable)  | ECO that caused the change                               |
| `change_type`                    | varchar(50)          | `part_modified`, `part_obsoleted`, or `parametric_stale` |
| `changed_fields`                 | JSONB (string array) | Which fields changed                                     |
| `previous_values` / `new_values` | JSONB                | Before/after values                                      |
| `status`                         | varchar(20)          | `pending`, `acknowledged`, or `dismissed`                |

#### Executions (`work_instruction_executions`)

Records of work instruction execution by operators, with captured data from data collection fields.

| Column                        | Type                | Description                                                                         |
| ----------------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| `id`                          | UUID (PK)           | Execution identifier                                                                |
| `work_instruction_id`         | UUID (FK)           | Executed work instruction                                                           |
| `work_instruction_revision`   | varchar(10)         | Revision at time of execution                                                       |
| `work_order_id`               | UUID (FK, nullable) | Associated work order                                                               |
| `executed_by`                 | UUID (FK)           | Operator                                                                            |
| `status`                      | varchar(30)         | `In Progress`, `Complete`, `Incomplete`, `Pending Approval`, `Approved`, `Rejected` |
| `started_at` / `completed_at` | timestamp           | Execution timeframe                                                                 |
| `duration`                    | integer             | Elapsed seconds                                                                     |
| `step_data`                   | JSONB               | Captured data from data collection fields                                           |
| `current_step_index`          | integer             | Progress tracking                                                                   |

### Lifecycle States

Draft -> In Review -> Approved -> Released -> Obsolete

### Relationships

| Relationship | Target Type | Description                           |
| ------------ | ----------- | ------------------------------------- |
| `Part`       | Part        | Attached parts (typically MBOM parts) |
| `Document`   | Document    | Reference documents                   |

### API Endpoints

| Method | Path                                                          | Description                          |
| ------ | ------------------------------------------------------------- | ------------------------------------ |
| GET    | `/api/v1/items/search?itemType=WorkInstruction`                  | Search/list work instructions        |
| GET    | `/api/v1/items/$id`                                              | Get work instruction by ID           |
| POST   | `/api/v1/items/$id`                                              | Create work instruction              |
| PUT    | `/api/v1/items/$id`                                              | Update work instruction              |
| GET    | `/api/v1/work-instructions/$id`                                  | Work instruction detail (with steps) |
| GET    | `/api/v1/work-instructions/$id/steps`                            | List steps                           |
| POST   | `/api/v1/work-instructions/$id/steps`                            | Add step                             |
| PUT    | `/api/v1/work-instructions/$id/steps/$stepId`                    | Update step                          |
| DELETE | `/api/v1/work-instructions/$id/steps/$stepId`                    | Delete step                          |
| GET    | `/api/v1/work-instructions/$id/operations`                       | List operations                      |
| POST   | `/api/v1/work-instructions/$id/operations`                       | Add operation                        |
| PUT    | `/api/v1/work-instructions/$id/operations/$operationId`          | Update operation                     |
| DELETE | `/api/v1/work-instructions/$id/operations/$operationId`          | Delete operation                     |
| GET    | `/api/v1/work-instructions/$id/parts`                            | List attached parts                  |
| POST   | `/api/v1/work-instructions/$id/parts`                            | Attach part                          |
| DELETE | `/api/v1/work-instructions/$id/parts`                            | Detach part                          |
| GET    | `/api/v1/work-instructions/$id/alerts`                           | List change alerts                   |
| GET    | `/api/v1/work-instructions/$id/resolve-parametric`               | Resolve parametric block values      |
| GET    | `/api/v1/work-instructions/$id/executions`                       | List execution records               |
| POST   | `/api/v1/work-instructions/$id/executions`                       | Start new execution                  |
| GET    | `/api/v1/work-instructions/$id/executions/$executionId`          | Get execution detail                 |
| POST   | `/api/v1/work-instructions/$id/executions/$executionId/complete` | Complete execution                   |
| POST   | `/api/v1/work-instructions/$id/executions/$executionId/sign-off` | Sign off execution                   |

### UI Pages

| Path                                             | Component                      | Description                                 |
| ------------------------------------------------ | ------------------------------ | ------------------------------------------- |
| `/work-instructions`                             | Work Instructions index        | List/search all work instructions           |
| `/work-instructions/new`                         | WorkInstructionForm            | Create new work instruction                 |
| `/work-instructions/$id`                         | Work instruction detail/editor | Block-based step editor                     |
| `/work-instructions/$id/execute`                 | Execution view                 | Step-by-step operator execution interface   |
| `/work-instructions/$id/present`                 | Presentation view              | Full-screen display for shop floor          |
| `/work-instructions/$id/executions/$executionId` | Execution record               | View completed execution with captured data |

### Key Files

- Schema: `src/lib/db/schema/items.ts` (work_instructions and related tables)
- Types: `src/lib/items/types/work-instruction.ts`
- Form: `src/components/work-instructions/WorkInstructionForm.tsx`
- Components: `src/components/work-instructions/` (StepEditor, ParametricBlock, etc.)

---

## 7. Issue

**Purpose:** Tracks quality issues, engineering problems, and customer-reported defects. Issues can be linked to affected parts and documents, assigned to engineers for investigation, and connected to the Change Orders that resolve them. Similar to "Problem Reports" in traditional PLM systems like Aras Innovator.

**Lifecycle:** Free (self-controlled, no ECO required)

**Default State:** Open

**Numbering:** `ISS-000001`

> **Note:** The Issue item type has a complete database schema, API, and UI (list, detail, form, and history views). Advanced features like dashboard views and Kanban boards are not yet implemented.

### Type-Specific Fields

| Column              | Type                   | Description                                                            |
| ------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `item_id`           | UUID (PK, FK to items) | Links to base item                                                     |
| `description`       | text                   | Issue description                                                      |
| `severity`          | varchar(20)            | `Critical`, `High`, `Medium`, or `Low`                                 |
| `priority`          | varchar(20)            | `Critical`, `High`, `Medium`, or `Low`                                 |
| `category`          | varchar(50)            | `Design`, `Manufacturing`, `Quality`, `Customer`, `Safety`, or `Other` |
| `reported_by`       | UUID (FK to users)     | User who reported the issue                                            |
| `reported_date`     | timestamp              | When the issue was reported                                            |
| `assigned_to`       | UUID (FK to users)     | Assigned investigator                                                  |
| `resolution`        | text                   | Resolution description                                                 |
| `resolved_date`     | timestamp              | When resolved                                                          |
| `root_cause`        | text                   | Root cause analysis                                                    |
| `affected_item_ids` | JSONB (UUID array)     | Items affected by this issue                                           |
| `program_id`        | UUID (FK to programs)  | Associated program                                                     |
| `design_ids`        | JSONB (UUID array)     | Multiple designs this issue relates to (no branch control)             |

### Lifecycle States

Open -> In Progress -> Pending -> Resolved -> Verified -> Closed

Also: Cancelled

### Relationships

| Relationship   | Target Type        | Description                         |
| -------------- | ------------------ | ----------------------------------- |
| `AffectedItem` | Part, Document     | Items affected by this issue        |
| `RelatedIssue` | Issue              | Related issues                      |
| `CausedBy`     | ChangeOrder, Issue | Root cause (what caused this issue) |
| `ResolvedBy`   | ChangeOrder        | ECO that resolves this issue        |

### API Endpoints

| Method | Path                               | Description           |
| ------ | ---------------------------------- | --------------------- |
| GET    | `/api/v1/items/search?itemType=Issue` | Search/list issues    |
| GET    | `/api/v1/items/$id`                   | Get issue by ID       |
| POST   | `/api/v1/items/$id`                   | Create issue          |
| PUT    | `/api/v1/items/$id`                   | Update issue          |
| GET    | `/api/v1/issues/$id`                  | Issue-specific detail |

### UI Pages

| Path          | Component    | Description                                |
| ------------- | ------------ | ------------------------------------------ |
| `/issues`     | Issues index | List/search issues                         |
| `/issues/new` | IssueForm    | Create new issue                           |
| `/issues/$id` | Issue detail | View issue details, resolution, root cause |

### Key Files

- Schema: `src/lib/db/schema/items.ts` (issues table)
- Types: `src/lib/items/types/issue.ts`
- Form: `src/components/issues/IssueForm.tsx`

---

## 8. Project (Programs and Designs)

**Purpose:** Programs and Designs form the organizational hierarchy of Cascadia PLM. They are not item types in the `ItemTypeRegistry` sense (they do not use the two-table pattern), but they are the top-level containers that organize all items.

The hierarchy is: **Organization -> Program -> Design -> Items**

### Program

A Program is a permission boundary and organizational container. Programs typically map to contracts, product lines, or major projects.

#### Program Fields

| Column            | Type         | Description                                                            |
| ----------------- | ------------ | ---------------------------------------------------------------------- |
| `id`              | UUID (PK)    | Program identifier                                                     |
| `name`            | varchar(200) | Program name                                                           |
| `code`            | varchar(50)  | Unique short code (e.g., `WIDGET`)                                     |
| `description`     | text         | Program description                                                    |
| `contract_number` | varchar(100) | Contract or PO number                                                  |
| `customer`        | varchar(200) | Customer name                                                          |
| `start_date`      | timestamp    | Program start date                                                     |
| `target_end_date` | timestamp    | Target completion date                                                 |
| `status`          | varchar(50)  | `Active`, `On Hold`, `Completed`, or `Cancelled`                       |
| `settings`        | JSONB        | Program-specific settings (approval workflow, ECO number format, etc.) |
| `attributes`      | JSONB        | Custom extensible attributes                                           |

#### Program Membership (`program_members`)

Users are granted access to programs through membership records.

| Column                | Type        | Description                              |
| --------------------- | ----------- | ---------------------------------------- |
| `program_id`          | UUID (FK)   | Program                                  |
| `user_id`             | UUID (FK)   | User                                     |
| `role`                | varchar(50) | `admin`, `lead`, `engineer`, or `viewer` |
| `can_create_eco`      | boolean     | Permission flag                          |
| `can_approve_eco`     | boolean     | Permission flag                          |
| `can_manage_products` | boolean     | Permission flag                          |

#### Program API Endpoints

| Method | Path                                | Description                  |
| ------ | ----------------------------------- | ---------------------------- |
| GET    | `/api/v1/programs/$id`                 | Get program details          |
| PUT    | `/api/v1/programs/$id`                 | Update program               |
| GET    | `/api/v1/programs/$id/members/$userId` | Get/manage member            |
| GET    | `/api/v1/programs/$id/history/graph`   | Program commit history graph |

#### Program UI Pages

| Path            | Component      | Description                              |
| --------------- | -------------- | ---------------------------------------- |
| `/programs`     | Programs index | List all programs                        |
| `/programs/new` | ProgramForm    | Create new program                       |
| `/programs/$id` | Program detail | View program with designs, members, ECOs |

### Design

A Design is a version-controlled container for items within a program. Designs have their own branch structure (main + ECO branches) and commit history. Items (Parts, Documents, Requirements, etc.) belong to a design.

#### Design Types

| Type              | Description                                                                      |
| ----------------- | -------------------------------------------------------------------------------- |
| **Engineering**   | Standard engineering design containing EBOM                                      |
| **Manufacturing** | Manufacturing design containing MBOM, derived from an Engineering design         |
| **Library**       | Standard Library, globally accessible across programs (e.g., standard fasteners) |
| **Family**        | Container for organizing related designs                                         |

#### Design Fields

| Column                   | Type                | Description                                            |
| ------------------------ | ------------------- | ------------------------------------------------------ |
| `id`                     | UUID (PK)           | Design identifier                                      |
| `program_id`             | UUID (FK, nullable) | Owning program (null for Library)                      |
| `name`                   | varchar(200)        | Design name                                            |
| `code`                   | varchar(50)         | Unique short code                                      |
| `description`            | text                | Design description                                     |
| `design_type`            | varchar(50)         | `Engineering`, `Manufacturing`, `Library`, or `Family` |
| `parent_design_id`       | UUID                | Parent design (for Family hierarchy)                   |
| `clone_source_design_id` | UUID                | Source if this design was cloned                       |
| `source_design_id`       | UUID                | Source Engineering design (for Manufacturing type)     |
| `source_tag_id`          | UUID                | Baseline tag used as derivation point                  |
| `source_commit_id`       | UUID                | Commit used as derivation point                        |
| `planned_quantity`       | integer             | Planned production quantity                            |
| `default_branch_id`      | UUID                | Default branch (usually main)                          |
| `is_archived`            | boolean             | Archive flag                                           |
| `sysml_project_id`       | UUID                | SysML API compatibility                                |
| `attributes`             | JSONB               | Custom extensible attributes                           |

#### Design API Endpoints

| Method | Path                                           | Description                  |
| ------ | ---------------------------------------------- | ---------------------------- |
| GET    | `/api/v1/designs/families`                        | List design families         |
| GET    | `/api/v1/designs/$designId/requirements-coverage` | Requirements coverage report |
| GET    | `/api/v1/designs/$designId/test-coverage`         | Test coverage report         |
| GET    | `/api/v1/designs/$designId/verification-gaps`     | Verification gap analysis    |
| GET    | `/api/v1/designs/$designId/gap-analysis`          | Full gap analysis            |
| GET    | `/api/v1/designs/$id/history/graph`               | Design commit history graph  |

#### Design UI Pages

| Path                                | Component            | Description                                         |
| ----------------------------------- | -------------------- | --------------------------------------------------- |
| `/designs`                          | Designs index        | List all designs                                    |
| `/designs/new`                      | DesignForm           | Create new design                                   |
| `/designs/$id`                      | Design detail        | View design with BOM tree, items, branches, history |
| `/designs/$id/edit`                 | Design edit          | Edit design metadata                                |
| `/designs/workspaces`               | Workspace index      | List personal workspaces                            |
| `/designs/workspaces/$id`           | Workspace detail     | Personal workspace view                             |
| `/designs/collaborative/$sessionId` | Collaborative design | AI-powered collaborative design session             |

### Key Files

- Program schema: `src/lib/db/schema/programs.ts`
- Design schema: `src/lib/db/schema/designs.ts`
- Versioning schema: `src/lib/db/schema/versioning.ts` (branches, commits, tags)
- Program form: `src/components/programs/ProgramForm.tsx`
- Design form: `src/components/designs/DesignForm.tsx`

---

## Additional Item Types

### Test Plan

**Purpose:** Container for organizing test cases into a structured test campaign.

**Lifecycle:** Free | **Default State:** Draft | **Numbering:** `TP-000001`

| Field            | Type         | Description                                |
| ---------------- | ------------ | ------------------------------------------ |
| `scope`          | text         | What the test plan covers                  |
| `environment`    | varchar(100) | Test environment                           |
| `entry_criteria` | text         | Conditions to begin testing                |
| `exit_criteria`  | text         | Conditions to consider testing complete    |
| `status`         | varchar(50)  | `Draft`, `Active`, `Completed`, `Archived` |

**States:** Draft, In Review, Approved, Released, Obsolete, Active, Completed, Archived

**Relationships:** TestCase (contains), Requirement (validates), Document (references)

### Test Case

**Purpose:** Individual test procedure linked to a test plan, with step-by-step instructions and execution tracking.

**Lifecycle:** Free | **Default State:** Draft | **Numbering:** `TC-000001`

| Field              | Type                   | Description                                     |
| ------------------ | ---------------------- | ----------------------------------------------- |
| `test_plan_id`     | UUID (FK)              | Parent test plan                                |
| `test_type`        | varchar(50)            | `Unit`, `Integration`, `System`, `Acceptance`   |
| `preconditions`    | text                   | Setup requirements                              |
| `steps`            | JSONB (TestStep array) | Array of `{stepNumber, action, expectedResult}` |
| `execution_status` | varchar(50)            | `NotRun`, `Passed`, `Failed`, `Blocked`         |
| `last_executed_at` | timestamp              | Last execution date                             |
| `last_executed_by` | UUID (FK)              | Last executor                                   |
| `environment`      | varchar(100)           | Execution environment                           |

**States:** Draft, In Review, Approved, Released, Obsolete, NotRun, Passed, Failed, Blocked

**Relationships:** VERIFIED_BY -> Requirement, VALIDATES -> Part, TestPlan (parent), Document (references)

**Test Executions** are stored in the `test_executions` table with status, duration, actual results, and notes.

**API:** `/api/v1/test-cases/$id/executions`

---

## Item Type Registry

All item types are registered in `ItemTypeRegistry`, which implements a two-tier configuration pattern:

1. **Code definitions** -- Type-safe configs defined in `src/lib/items/registerItemTypes.server.ts` (schemas, components, table names, default states).
2. **Runtime configs** -- Business rules from the database `item_type_configs` table (overridable labels, permissions, lifecycle assignments, relationships).

Runtime configs override code defaults for configurable fields. Components and schemas always come from code for type safety.

### Registration Source

`src/lib/items/registerItemTypes.server.ts`

### Lifecycle Assignment

Each item type is assigned a lifecycle definition by ID (stored in `src/lib/items/lifecycle-ids.ts`). The lifecycle controls valid states and transition rules. Multiple item types can share the same lifecycle definition.

### Permissions Model

Each registered type declares CRUD permissions by role:

| Item Type       | Delete Restricted To                   |
| --------------- | -------------------------------------- |
| Part            | Admin, Engineer                        |
| Document        | Admin, Engineer                        |
| ChangeOrder     | Admin, Engineer                        |
| Requirement     | Admin, Engineer, ProductManager        |
| Task            | Admin, ProjectManager, Engineer        |
| WorkInstruction | Admin, Engineer, ManufacturingEngineer |
| Issue           | Admin, Engineer, QualityEngineer       |
| TestPlan        | Admin, Engineer, QualityEngineer       |
| TestCase        | Admin, Engineer, QualityEngineer       |

All types currently allow create, read, and update for all roles (`*`).

---

## Relationships Between Types

The `item_relationships` table stores typed, directed relationships between any two items. Key relationship types used across the system:

| Relationship Type | Typical Source   | Typical Target     | Description                 |
| ----------------- | ---------------- | ------------------ | --------------------------- |
| `BOM`             | Part (parent)    | Part (child)       | Bill of Materials hierarchy |
| `Document`        | Part             | Document           | Attached documentation      |
| `Affects`         | ChangeOrder      | Part, Document     | ECO affected items          |
| `VERIFIED_BY`     | TestCase         | Requirement        | Test verifies requirement   |
| `VALIDATES`       | TestCase         | Part               | Test validates part         |
| `Dependency`      | Requirement/Task | Requirement/Task   | Depends-on relationship     |
| `Blocker`         | Task             | Task               | Blocking relationship       |
| `AffectedItem`    | Issue            | Part, Document     | Items affected by issue     |
| `CausedBy`        | Issue            | ChangeOrder, Issue | Root cause link             |
| `ResolvedBy`      | Issue            | ChangeOrder        | Resolution link             |

Relationship records include optional fields for quantity, reference designator, find number, SysML composition/multiplicity, and cross-design traceability (source/target design, derivation method).

**API:** `GET/POST/DELETE /api/relationships`

---

## Generic Item API

All item types share these common endpoints via the unified `ItemService`:

| Method | Path                                    | Description                                                                    |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------ |
| GET    | `/api/v1/items/search`                     | Search items with filters (`itemType`, `designId`, `state`, `q`, pagination)   |
| GET    | `/api/v1/items/$id`                        | Get item by ID with optional version context (`?branch=`, `?commit=`, `?tag=`) |
| POST   | `/api/v1/items/$id`                        | Create item (type determined by `itemType` field in body)                      |
| PUT    | `/api/v1/items/$id`                        | Update item                                                                    |
| DELETE | `/api/v1/items/$id`                        | Soft-delete item                                                               |
| GET    | `/api/v1/items/$id/history`                | Version history across revisions                                               |
| GET    | `/api/v1/items/$id/available-contexts`     | List branches/commits where item exists                                        |
| POST   | `/api/v1/items/$id/checkin`                | Check in after editing                                                         |
| POST   | `/api/v1/items/$id/cancel-checkout`        | Cancel checkout                                                                |
| GET    | `/api/v1/items/$id/lock-status`            | Check lock status                                                              |
| POST   | `/api/v1/items/$id/unlock`                 | Force unlock                                                                   |
| GET    | `/api/v1/items/$id/impact-analysis`        | Run impact analysis on item                                                    |
| GET    | `/api/v1/items/$id/satisfied-requirements` | Requirements satisfied by this item                                            |
