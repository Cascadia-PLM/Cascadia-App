# Work Instructions

## Overview

Work Instructions (WIs) bring manufacturing execution into the PLM digital thread. In discrete manufacturing, a work instruction is a step-by-step procedure that tells a shop floor technician exactly how to assemble, inspect, or test a physical product. Think of it as the bridge between what engineering designs and what manufacturing actually builds.

Traditional PLM systems either lack work instructions entirely or bolt them on as an expensive MES (Manufacturing Execution System) add-on. Cascadia takes a different approach: work instructions are a first-class item type, deeply integrated with the parts, BOMs, and change orders that engineering already manages. When an engineer changes a dimension on a part, the work instruction that references that dimension knows about it automatically.

### How Work Instructions Fit the Digital Thread

```
Requirement --> Part (EBOM) --> Part (MBOM) --> Work Instruction --> Work Order --> Execution Record
                                    |                  |            (traveler line)        |
                              "what to build"   "how to build it"   "this build's copy"   "proof it was built"
```

A WorkInstruction is a **template** -- authored content describing a procedure. It is never executed directly. Work orders **instantiate** templates into their traveler (`work_order_instructions` -- one frozen copy per template × part), and executions (`instruction_executions`) record runs of those traveler lines. This definition/usage separation follows the same SysML v2 pattern used for Parts throughout Cascadia; the full design is in `docs/proposals/work-order-traveler.md`.

### Item Type Registration

WorkInstruction is registered as a standard Cascadia item type via `ItemTypeRegistry`:

| Property      | Value                                              |
| ------------- | -------------------------------------------------- |
| Name          | `WorkInstruction`                                  |
| Table         | `work_instructions`                                |
| Prefix        | `WI` (auto-numbering: `WI000001`, `WI000002`, ...) |
| Default State | `Draft`                                            |
| Lifecycle     | Free (self-controlled, no ECO required)            |
| Icon          | `ClipboardCheck`                                   |

Because work instructions use the Free lifecycle, they are not subject to branch protection. Authors can edit them directly on `main` without creating an ECO. This is intentional -- manufacturing procedures change more frequently and informally than engineering designs.

### Type-Specific Fields

The `work_instructions` table extends the base `items` table (two-table pattern):

| Field           | Type        | Description                             |
| --------------- | ----------- | --------------------------------------- |
| `description`   | text        | Summary of the procedure                |
| `estimatedTime` | integer     | Expected completion time in minutes     |
| `difficulty`    | varchar(20) | `Easy`, `Medium`, or `Hard`             |
| `safetyNotes`   | text        | Safety considerations for the procedure |
| `requiredTools` | text        | Tools and equipment needed              |

---

## Operations Management

Operations group steps into named phases within a work instruction. A single work instruction for assembling a motor controller might have operations like "Wiring", "Mechanical Assembly", and "Final Inspection". Each operation contains an ordered subset of the instruction's steps.

### Schema: `work_instruction_operations`

| Field               | Type         | Description                                       |
| ------------------- | ------------ | ------------------------------------------------- |
| `id`                | uuid         | Primary key                                       |
| `workInstructionId` | uuid         | FK to `work_instructions.itemId` (cascade delete) |
| `orderIndex`        | integer      | Position in sequence (0-based)                    |
| `title`             | varchar(500) | Operation name (required)                         |
| `description`       | text         | Optional details                                  |
| `estimatedTime`     | integer      | Estimated minutes for this operation              |

Operations are ordered by `orderIndex`. When an operation is deleted, remaining operations are automatically reindexed to fill the gap. Steps assigned to a deleted operation have their `operationId` set to `null` (ON DELETE SET NULL) -- they become unassigned rather than deleted.

### Steps Within Operations

Each step has an optional `operationId` foreign key. Steps with `operationId = null` are "unassigned" and appear outside any operation grouping. The UI allows dragging steps between operations or removing them from an operation.

---

## Step Content Types

Steps are the atomic units of a work instruction. Each step contains an ordered array of **content blocks** stored as JSONB in the `content` column. The block editor uses a vertical stack layout -- blocks are full-width and rendered top-to-bottom.

### Schema: `work_instruction_steps`

| Field               | Type         | Description                                                 |
| ------------------- | ------------ | ----------------------------------------------------------- |
| `id`                | uuid         | Primary key                                                 |
| `workInstructionId` | uuid         | FK to `work_instructions.itemId` (cascade delete)           |
| `operationId`       | uuid         | FK to `work_instruction_operations.id` (set null on delete) |
| `orderIndex`        | integer      | Position in sequence (0-based)                              |
| `title`             | varchar(500) | Optional step header                                        |
| `content`           | jsonb        | `StepContent` -- array of content blocks                    |

### Content Block Structure

```typescript
interface StepContent {
  blocks: Array<StepContentBlock>
}

interface StepContentBlock {
  id: string
  type: 'text' | 'image' | 'parametric' | 'dataField'
  // ... type-specific fields below
}
```

### Text Blocks

Plain rich-text content. The `content` field holds HTML.

```json
{
  "id": "block-uuid",
  "type": "text",
  "content": "<p>Apply thread locker to the M6 bolts before inserting into the housing.</p>"
}
```

### Image Blocks

Reference files stored in the Cascadia vault. Images are uploaded through the existing file vault infrastructure and referenced by `fileId`.

```json
{
  "id": "block-uuid",
  "type": "image",
  "fileId": "vault-file-uuid",
  "alt": "Motor housing bolt pattern",
  "caption": "Torque bolts in star pattern to 25 ft-lbs"
}
```

### Parametric Blocks

The signature integration feature. Parametric blocks link to a specific attribute on a specific part. When the work instruction is rendered, the system resolves the current value from the database. If the part's weight changes from 2.5 kg to 2.7 kg, every work instruction referencing that weight updates automatically.

```json
{
  "id": "block-uuid",
  "type": "parametric",
  "partId": "part-uuid",
  "attributePath": "weight",
  "label": "Component weight:",
  "unit": "kg",
  "fallbackValue": "See engineering drawing"
}
```

**Resolvable attributes** come from three sources:

| Source             | Examples                                                               | Path Format                  |
| ------------------ | ---------------------------------------------------------------------- | ---------------------------- |
| Item-level columns | `name`, `itemNumber`, `revision`, `state`                              | `name`                       |
| Part typed columns | `material`, `weight`, `weightUnit`, `cost`, `partType`, `leadTimeDays` | `weight`                     |
| JSONB attributes   | Custom fields stored in `items.attributes`                             | `attributes.tensileStrength` |

The `ParametricResolutionService` handles resolution. For single blocks, it queries one part. For full work instruction rendering, `resolveAllSteps()` batch-queries all referenced parts in a single database call for efficiency.

When a part cannot be found, the resolution returns `{ value: null, available: false }` and the UI falls back to the `fallbackValue` string.

### Data Field Blocks

Capture input from the technician during execution. These blocks define what data to collect -- the actual values are recorded in the execution's `stepData` JSONB column.

```json
{
  "id": "block-uuid",
  "type": "dataField",
  "fieldType": "numeric",
  "fieldLabel": "Measured torque (ft-lbs)",
  "fieldRequired": true,
  "fieldValidation": { "min": 25, "max": 35 }
}
```

| Field Type | Input                | Validation                      |
| ---------- | -------------------- | ------------------------------- |
| `text`     | Free-form text input | Optional regex `pattern`        |
| `numeric`  | Number input         | Optional `min` and `max` bounds |
| `checkbox` | Boolean toggle       | None                            |
| `passFail` | Pass/Fail selector   | None                            |

---

## PLM Integration

### Part Attachments

Work instructions are linked to parts through a many-to-many junction table (`work_instruction_part_attachments`). One work instruction can apply to multiple parts, and one part can have multiple work instructions.

| Field               | Type      | Description                                   |
| ------------------- | --------- | --------------------------------------------- |
| `id`                | uuid      | Primary key                                   |
| `workInstructionId` | uuid      | FK to work instruction                        |
| `partId`            | uuid      | FK to part item                               |
| `inheritToMBOM`     | boolean   | If true, auto-copies to derived MBOM parts    |
| `inheritedFromId`   | uuid      | Tracks provenance from EBOM source attachment |
| `createdBy`         | uuid      | FK to user                                    |
| `createdAt`         | timestamp | When attached                                 |

A unique constraint on `(workInstructionId, partId)` prevents duplicate attachments.

Attachments can be created from either direction:

- From a work instruction: attach parts via `POST /api/v1/work-instructions/:id/parts`
- From a part: view attached work instructions via `GET /api/v1/parts/:id/work-instructions`

### MBOM Inheritance

When `inheritToMBOM` is `true` on an EBOM part attachment, the `WorkInstructionInheritanceService` automatically copies that attachment to derived MBOM parts during MBOM creation.

**How it works:**

1. `MbomService.createFromEbom()` copies EBOM items to a new MBOM design, producing an `itemIdMap` (source EBOM ID -> new MBOM ID).
2. After item copying, it calls `WorkInstructionInheritanceService.inheritAttachments()`.
3. The service finds all source EBOM attachments where `inheritToMBOM = true`.
4. For each, it creates a new attachment on the corresponding MBOM part with `inheritedFromId` set to the source attachment (tracking provenance) and `inheritToMBOM = false` (inherited attachments do not cascade further).
5. `onConflictDoNothing()` skips duplicates if the WI is already attached to the MBOM part.

For existing MBOMs, `syncInheritedAttachments()` can re-sync new WI attachments added to EBOM parts after the initial MBOM creation. It rebuilds the item ID mapping from `itemNumber` or `usageOf` references.

### Change Alerts

When an ECO is released and merged to main, Cascadia automatically creates change alerts for every work instruction attached to the modified parts. This keeps WI authors informed when engineering changes affect their procedures.

**Trigger chain:**

1. `ChangeOrderMergeService` completes an ECO merge.
2. It collects the IDs of all parts that were modified.
3. It submits a background job: `notification.workinstruction.partchanged`.
4. The `wiPartChangedHandler` calls `WorkInstructionChangeAlertService.createAlerts()`.
5. The service finds all WI-part attachments for the changed parts and inserts one alert per unique WI-part pair.

### Schema: `work_instruction_change_alerts`

| Field               | Type        | Description                                              |
| ------------------- | ----------- | -------------------------------------------------------- |
| `id`                | uuid        | Primary key                                              |
| `workInstructionId` | uuid        | FK to work instruction                                   |
| `partId`            | uuid        | FK to changed part                                       |
| `ecoId`             | uuid        | FK to the ECO that triggered the change (nullable)       |
| `changeType`        | varchar(50) | `part_modified`, `part_obsoleted`, or `parametric_stale` |
| `changedFields`     | jsonb       | Array of field names that changed                        |
| `previousValues`    | jsonb       | Snapshot of old values                                   |
| `newValues`         | jsonb       | Snapshot of new values                                   |
| `status`            | varchar(20) | `pending`, `acknowledged`, or `dismissed`                |
| `acknowledgedBy`    | uuid        | FK to user who acted on the alert                        |
| `acknowledgedAt`    | timestamp   | When acknowledged/dismissed                              |
| `notes`             | text        | Optional notes from the acknowledger                     |

### Alert Acknowledgment

Alerts start in `pending` status. WI authors can:

- **Acknowledge** -- "I've reviewed this change and updated the WI accordingly."
- **Dismiss** -- "This change doesn't affect the work instruction."
- **Bulk acknowledge** -- Mark all pending alerts for a WI as acknowledged at once.

Both actions record who acted, when, and optional notes explaining the decision. The `getAlertCounts()` method provides quick badge counts (pending vs. total) for the UI.

---

## The Traveler: Instances Inside Work Orders

Templates become executable by being **instantiated into a work order's traveler** -- the ordered list of instructions that particular build must perform. A work order building an assembly may carry many lines: fabrication instructions for each subassembly part plus the final assembly procedure.

### Instantiation and Snapshot Freezing

Adding a template to a traveler (by hand, or via **populate**, which walks the order part's BOM and instantiates every attached template, deepest parts first) copies the template's metadata, operations, and steps into the line's `snapshot` JSONB. From that moment the line is independent:

- Editing the template never changes travelers already on the floor.
- Deleting the template nulls the provenance FK; the line keeps executing from its snapshot.
- A line can be explicitly **re-frozen** from its template (`refresh`) -- but only until its first execution. After that the line is a manufacturing record, not a plan.
- Parametric blocks in the snapshot still resolve **live** against current part data -- the snapshot freezes the procedure, not the engineering values it points at.

### Schema: `work_order_instructions`

| Field                 | Type         | Description                                                 |
| --------------------- | ------------ | ----------------------------------------------------------- |
| `id`                  | uuid         | Primary key                                                 |
| `workOrderId`         | uuid         | FK to work order (cascade delete)                           |
| `workInstructionId`   | uuid         | Provenance FK to the template (SET NULL on template delete) |
| `partId`              | uuid         | The part this line applies to (order part or BOM child)     |
| `orderIndex`          | integer      | Traveler sequence                                           |
| `title`               | varchar(500) | Template name at snapshot                                   |
| `instructionNumber`   | varchar(64)  | Template item number at snapshot                            |
| `instructionRevision` | varchar(10)  | Template revision at snapshot                               |
| `snapshot`            | jsonb        | Frozen metadata + operations + steps                        |
| `snapshotAt`          | timestamptz  | When frozen                                                 |
| `requiredCount`       | integer      | Completed runs needed (1 = batch; order qty = per-unit)     |
| `skippedAt/By/Reason` | --           | Audited not-applicable marker                               |

**Line status is derived, never stored**: `Skipped` if skipped; `Complete` when countable runs (`Complete` or `Approved`) ≥ `requiredCount`; `In Progress` if any execution exists; else `Not Started`.

### Work Order Completion Gate

A work order cannot transition to `Complete` while any non-skipped line is open. Skipping (reason mandatory, recorded with who/when) is the audited escape hatch; a line that has reached its required count can no longer be skipped. Cancellation is not gated. Conversely, starting an execution on a `Not Started` order auto-transitions it to `In Progress` -- execution is what starts an order.

## Execution Tracking

### Starting an Execution

An execution is a run of one traveler line, started from the work order context (`POST /api/v1/work-orders/:id/instructions/:instructionId/executions`). Standalone executions no longer exist -- performing a procedure outside an order means creating an order for it.

If the same user already has an in-progress run of the same line (and the same `unitLabel`, when given), the API returns the existing execution with `resumed: true` rather than creating a duplicate. Extra runs beyond `requiredCount` are allowed -- rework happens.

### Schema: `instruction_executions`

| Field                    | Type         | Description                                |
| ------------------------ | ------------ | ------------------------------------------ |
| `id`                     | uuid         | Primary key                                |
| `workOrderInstructionId` | uuid         | FK to the traveler line (cascade delete)   |
| `executedBy`             | uuid         | FK to user performing the run              |
| `unitLabel`              | varchar(200) | Optional serial/unit tag this run covers   |
| `status`                 | varchar(30)  | Current status (see below)                 |
| `startedAt`              | timestamp    | When the run began                         |
| `completedAt`            | timestamp    | When finished (null while in progress)     |
| `duration`               | integer      | Total seconds (computed on completion)     |
| `stepData`               | jsonb        | Captured values keyed by snapshot block ID |
| `notes`                  | text         | Optional notes                             |
| `currentStepIndex`       | integer      | Tracks progress through steps              |

### Execution Status Flow

```
In Progress --> Complete --> (if work order requires sign-off) --> Pending Approval --> Approved
                                                                                   --> Rejected --> (resubmit) --> Pending Approval
In Progress --> Incomplete   (abandoned)
```

| Status             | Meaning                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `In Progress`      | Technician is actively performing the procedure                                           |
| `Complete`         | All steps finished; becomes `Pending Approval` instead if the order has `requiresSignOff` |
| `Incomplete`       | Run was abandoned (`POST .../abandon`) -- kept as a record, never counts toward the line  |
| `Pending Approval` | Completed but awaiting supervisor sign-off (does not count toward the line yet)           |
| `Approved`         | Supervisor approved the run (counts)                                                      |
| `Rejected`         | Supervisor rejected the run; only the original executor can resubmit                      |

### Step Data Capture

During execution, data field block values are captured incrementally. Each captured value is stored in the `stepData` JSONB column, keyed by the **snapshot's** block ID (which is why snapshots freeze once execution begins):

```json
{
  "block-uuid-1": {
    "value": 32.5,
    "capturedAt": "2025-01-15T14:30:00Z",
    "blockId": "block-uuid-1"
  },
  "block-uuid-2": {
    "value": true,
    "capturedAt": "2025-01-15T14:31:15Z",
    "blockId": "block-uuid-2"
  }
}
```

The `updateStepData()` method merges new captures into the existing JSONB -- it reads the current data, adds or overwrites the entry for the given `blockId`, and writes it back. This preserves all previously captured values.

Progress tracking uses `currentStepIndex` so the technician can resume where they left off.

### Sign-Off Workflows

Work orders with `requiresSignOff = true` trigger a supervisor review after each run completes. The flow:

1. Technician completes the run. Status becomes `Pending Approval` (instead of `Complete`).
2. Supervisor reviews the execution data and submits a decision.
3. Decision is `approved` or `rejected`. Rejection requires mandatory comments explaining why.
4. The sign-off record is stored in the `execution_sign_offs` table.
5. On approval, the run counts toward its line's `requiredCount`.

Sign-off no longer touches `quantityCompleted` -- an approved run of one instruction was never evidence that a finished unit left the line. `quantityCompleted` is derived from produced units for serial-tracked parts (`WorkOrderMaterialService.produce`) and manually settable otherwise.

### Schema: `execution_sign_offs`

| Field         | Type        | Description                                     |
| ------------- | ----------- | ----------------------------------------------- |
| `id`          | uuid        | Primary key                                     |
| `executionId` | uuid        | FK to execution (cascade delete)                |
| `reviewerId`  | uuid        | FK to reviewing user                            |
| `decision`    | varchar(20) | `approved` or `rejected`                        |
| `comments`    | text        | Required for rejections, optional for approvals |
| `reviewedAt`  | timestamp   | When the decision was made                      |

---

## API Endpoints

All endpoints require authentication. Permission requirements are noted per endpoint.

### Work Instruction CRUD

| Method | Path                            | Permission                 | Description                |
| ------ | ------------------------------- | -------------------------- | -------------------------- |
| GET    | `/api/v1/work-instructions/:id` | `work_instructions:read`   | Get WI with steps          |
| PUT    | `/api/v1/work-instructions/:id` | `work_instructions:update` | Update WI metadata         |
| DELETE | `/api/v1/work-instructions/:id` | `work_instructions:delete` | Delete WI and all children |

Work instructions are created through the standard `ItemService.create()` flow, like any other item type.

### Operations

| Method | Path                                                    | Permission                 | Description                             |
| ------ | ------------------------------------------------------- | -------------------------- | --------------------------------------- |
| GET    | `/api/v1/work-instructions/:id/operations`              | `work_instructions:read`   | List operations ordered by index        |
| POST   | `/api/v1/work-instructions/:id/operations`              | `work_instructions:update` | Create operation (appended to end)      |
| PUT    | `/api/v1/work-instructions/:id/operations`              | `work_instructions:update` | Bulk reorder operations                 |
| PUT    | `/api/v1/work-instructions/:id/operations/:operationId` | `work_instructions:update` | Update operation title/description/time |
| DELETE | `/api/v1/work-instructions/:id/operations/:operationId` | `work_instructions:update` | Delete operation (reindexes remaining)  |

### Steps

| Method | Path                                          | Permission                 | Description                                 |
| ------ | --------------------------------------------- | -------------------------- | ------------------------------------------- |
| GET    | `/api/v1/work-instructions/:id/steps`         | `work_instructions:read`   | List steps ordered by index                 |
| POST   | `/api/v1/work-instructions/:id/steps`         | `work_instructions:update` | Create step (with optional position insert) |
| PUT    | `/api/v1/work-instructions/:id/steps`         | `work_instructions:update` | Bulk reorder steps                          |
| GET    | `/api/v1/work-instructions/:id/steps/:stepId` | `work_instructions:read`   | Get single step                             |
| PUT    | `/api/v1/work-instructions/:id/steps/:stepId` | `work_instructions:update` | Update step content/title/order/operation   |
| DELETE | `/api/v1/work-instructions/:id/steps/:stepId` | `work_instructions:update` | Delete step (reindexes remaining)           |

When creating a step with a specific `orderIndex`, existing steps at or after that position are shifted up automatically.

### Part Attachments

| Method | Path                                  | Permission                 | Description                                        |
| ------ | ------------------------------------- | -------------------------- | -------------------------------------------------- |
| GET    | `/api/v1/work-instructions/:id/parts` | `work_instructions:read`   | List attached parts with details                   |
| POST   | `/api/v1/work-instructions/:id/parts` | `work_instructions:update` | Attach a part (body: `{ partId, inheritToMBOM? }`) |
| PATCH  | `/api/v1/work-instructions/:id/parts` | `work_instructions:update` | Update attachment flags (e.g., `inheritToMBOM`)    |
| DELETE | `/api/v1/work-instructions/:id/parts` | `work_instructions:update` | Detach a part (query or body: `partId`)            |
| GET    | `/api/v1/parts/:id/work-instructions` | `parts:read`               | List WIs attached to a specific part               |

### Parametric Resolution

| Method | Path                                               | Permission               | Description                                |
| ------ | -------------------------------------------------- | ------------------------ | ------------------------------------------ |
| GET    | `/api/v1/work-instructions/:id/resolve-parametric` | `work_instructions:read` | Resolve all parametric blocks in all steps |

Returns a map keyed by `{partId}.{attributePath}` with `{ value, available }` for each parametric reference.

### Change Alerts

| Method | Path                                   | Permission                 | Description                                                                 |
| ------ | -------------------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| GET    | `/api/v1/work-instructions/:id/alerts` | `work_instructions:read`   | List alerts with counts (filterable by `?status=pending`)                   |
| PUT    | `/api/v1/work-instructions/:id/alerts` | `work_instructions:update` | Acknowledge or dismiss a single alert (body: `{ alertId, action, notes? }`) |
| POST   | `/api/v1/work-instructions/:id/alerts` | `work_instructions:update` | Bulk acknowledge all pending alerts                                         |

### Usage

| Method | Path                                  | Permission               | Description                                                   |
| ------ | ------------------------------------- | ------------------------ | ------------------------------------------------------------- |
| GET    | `/api/v1/work-instructions/:id/usage` | `work_instructions:read` | Traveler lines instantiated from this template, with progress |

### Traveler & Executions (work order side)

Instantiation and execution live under `/api/v1/work-orders/:id/…` — the template routes carry no execution endpoints.

| Method   | Path                                                          | Permission               | Description                                                                         |
| -------- | ------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| GET      | `…/instructions`                                              | `work_orders:read`       | The traveler with derived status/progress                                           |
| POST     | `…/instructions`                                              | `work_orders:update`     | Instantiate a template (`{ workInstructionId, partId?, requiredCount?, perUnit? }`) |
| POST     | `…/instructions/populate`                                     | `work_orders:update`     | Instantiate from part attachments across the order's BOM                            |
| PUT      | `…/instructions`                                              | `work_orders:update`     | Reorder lines                                                                       |
| GET      | `…/instructions/:instructionId`                               | `work_orders:read`       | Line detail (snapshot)                                                              |
| PATCH    | `…/instructions/:instructionId`                               | `work_orders:update`     | Update `requiredCount`                                                              |
| POST     | `…/instructions/:instructionId/skip` / `unskip` / `refresh`   | `work_orders:update`     | Skip (reason required) / unskip / re-freeze                                         |
| DELETE   | `…/instructions/:instructionId`                               | `work_orders:update`     | Remove (only while unexecuted)                                                      |
| GET      | `…/instructions/:instructionId/resolve-parametric`            | `work_orders:read`       | Resolve snapshot parametric blocks against current part data                        |
| GET/POST | `…/instructions/:instructionId/executions`                    | `work_instructions:read` | List runs / start-or-resume a run (`{ unitLabel? }`)                                |
| GET      | `…/executions`                                                | `work_orders:read`       | Every run for the order                                                             |
| GET/PUT  | `…/executions/:executionId`                                   | `work_instructions:read` | Run detail / step data & progress                                                   |
| POST     | `…/executions/:executionId/complete` / `abandon` / `resubmit` | `work_instructions:read` | Finish / abandon / resubmit a rejected run                                          |
| GET      | `…/executions/:executionId/sign-off`                          | `work_orders:read`       | Sign-off records                                                                    |
| POST     | `…/executions/:executionId/sign-off`                          | `work_orders:update`     | Submit approval/rejection (`{ decision, comments? }`)                               |

Note: running executions requires only `work_instructions:read`, since manufacturing technicians on read-only seats need to execute and record data (resubmit is executor-gated in the service). Sign-off uses `work_orders` permissions since it is a supervisory function tied to work order management.

---

## Permissions by Role

| Role            | Permissions             |
| --------------- | ----------------------- |
| Admin           | Full CRUD + manage      |
| Program Manager | Full CRUD               |
| Engineer        | Full CRUD               |
| Quality         | Read + update + approve |
| Manufacturing   | Create + read + update  |
| Viewer          | Read only               |

---

## Key Source Files

| Area                       | Path                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| Database schema            | `packages/core/src/lib/db/schema/items.ts` (search for `workInstructions`) |
| Type definitions           | `packages/core/src/lib/items/types/work-instruction.ts`                    |
| Item type registration     | `packages/core/src/lib/items/registerItemTypes.server.ts`                  |
| Numbering scheme           | `packages/core/src/lib/items/numbering/schemes.ts`                         |
| Inheritance service        | `packages/core/src/lib/services/WorkInstructionInheritanceService.ts`      |
| Change alert service       | `packages/core/src/lib/services/WorkInstructionChangeAlertService.ts`      |
| Traveler service           | `packages/core/src/lib/services/WorkOrderInstructionService.ts`            |
| Execution service          | `packages/core/src/lib/services/InstructionExecutionService.ts`            |
| Traveler/execution schema  | `packages/core/src/lib/db/schema/work-orders.ts`                           |
| Parametric resolution      | `packages/core/src/lib/services/ParametricResolutionService.ts`            |
| Background job definitions | `packages/core/src/lib/jobs/definitions/workinstruction/`                  |
| API routes                 | `packages/core/src/server/routes/work-instructions.ts`                     |
| Parts reverse-lookup       | `packages/core/src/server/routes/parts.ts`                                 |
| UI components              | `packages/core/src/components/work-instructions/`                          |
