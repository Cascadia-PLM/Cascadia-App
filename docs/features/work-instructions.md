# Work Instructions

## Overview

Work Instructions (WIs) bring manufacturing execution into the PLM digital thread. In discrete manufacturing, a work instruction is a step-by-step procedure that tells a shop floor technician exactly how to assemble, inspect, or test a physical product. Think of it as the bridge between what engineering designs and what manufacturing actually builds.

Traditional PLM systems either lack work instructions entirely or bolt them on as an expensive MES (Manufacturing Execution System) add-on. Cascadia takes a different approach: work instructions are a first-class item type, deeply integrated with the parts, BOMs, and change orders that engineering already manages. When an engineer changes a dimension on a part, the work instruction that references that dimension knows about it automatically.

### How Work Instructions Fit the Digital Thread

```
Requirement --> Part (EBOM) --> Part (MBOM) --> Work Instruction --> Execution Record
                                    |                  |                    |
                              "what to build"   "how to build it"   "proof it was built"
```

A WorkInstruction is a **template** -- authored content describing a procedure. A WorkInstructionExecution is an **instance** -- a record that someone performed that procedure on a specific date, for a specific work order, capturing actual measured values along the way. This definition/usage separation follows the same SysML v2 pattern used for Parts throughout Cascadia.

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

- From a work instruction: attach parts via `POST /api/work-instructions/:id/parts`
- From a part: view attached work instructions via `GET /api/parts/:id/work-instructions`

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

## Execution Tracking

### Starting an Execution

An execution begins when a technician starts performing a work instruction, typically from a work order context. The system snapshots the current revision of the WI at execution start time so there is a permanent record of which version was followed, even if the WI is later revised.

If the same user already has an in-progress execution for the same WI (and optionally the same work order), the API returns the existing execution with `resumed: true` rather than creating a duplicate.

### Schema: `work_instruction_executions`

| Field                     | Type        | Description                            |
| ------------------------- | ----------- | -------------------------------------- |
| `id`                      | uuid        | Primary key                            |
| `workInstructionId`       | uuid        | FK to work instruction                 |
| `workInstructionRevision` | varchar(10) | Snapshot of revision at start          |
| `workOrderId`             | uuid        | FK to work order (nullable)            |
| `executedBy`              | uuid        | FK to user performing the WI           |
| `status`                  | varchar(30) | Current status (see below)             |
| `startedAt`               | timestamp   | When execution began                   |
| `completedAt`             | timestamp   | When finished (null while in progress) |
| `duration`                | integer     | Total seconds (computed on completion) |
| `stepData`                | jsonb       | Captured values keyed by block ID      |
| `notes`                   | text        | Optional notes                         |
| `currentStepIndex`        | integer     | Tracks progress through steps          |

### Execution Status Flow

```
In Progress --> Complete --> (if work order requires sign-off) --> Pending Approval --> Approved
                                                                                   --> Rejected
In Progress --> Incomplete
```

| Status             | Meaning                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `In Progress`      | Technician is actively performing the procedure                                                |
| `Complete`         | All steps finished; auto-transitions to `Pending Approval` if work order has `requiresSignOff` |
| `Incomplete`       | Execution was abandoned before finishing                                                       |
| `Pending Approval` | Completed but awaiting supervisor sign-off                                                     |
| `Approved`         | Supervisor approved the execution                                                              |
| `Rejected`         | Supervisor rejected the execution                                                              |

### Step Data Capture

During execution, data field block values are captured incrementally. Each captured value is stored in the `stepData` JSONB column, keyed by block ID:

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

### Work Order Linking

Work orders are standalone operational records (not a Cascadia item type). They track what to build, how many, and by when.

| Field               | Type         | Description                                            |
| ------------------- | ------------ | ------------------------------------------------------ |
| `workOrderNumber`   | varchar(20)  | Human-readable ID (unique)                             |
| `partId`            | uuid         | What to build                                          |
| `quantity`          | integer      | How many                                               |
| `quantityCompleted` | integer      | Auto-incremented on approved executions                |
| `status`            | varchar(20)  | `Not Started`, `In Progress`, `Complete`, `Cancelled`  |
| `priority`          | varchar(10)  | `Low`, `Normal`, `High`, `Urgent`                      |
| `dueDate`           | timestamp    | Target completion                                      |
| `requiresSignOff`   | boolean      | If true, completed executions go to `Pending Approval` |
| `customerOrder`     | varchar(200) | External reference for ERP sync                        |
| `assignedTo`        | jsonb        | Array of user IDs                                      |
| `programId`         | uuid         | Organizational scope                                   |

When an execution linked to a work order is approved through sign-off, the work order's `quantityCompleted` is automatically incremented by 1.

### Sign-Off Workflows

Work orders with `requiresSignOff = true` trigger a supervisor review after execution completion. The flow:

1. Technician completes execution. Status becomes `Pending Approval` (instead of `Complete`).
2. Supervisor reviews the execution data and submits a decision.
3. Decision is `approved` or `rejected`. Rejection requires mandatory comments explaining why.
4. The sign-off record is stored in the `execution_sign_offs` table.
5. On approval, the execution status updates to `Approved` and the work order's `quantityCompleted` increments.

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

| Method | Path                         | Permission                 | Description                |
| ------ | ---------------------------- | -------------------------- | -------------------------- |
| GET    | `/api/work-instructions/:id` | `work_instructions:read`   | Get WI with steps          |
| PUT    | `/api/work-instructions/:id` | `work_instructions:update` | Update WI metadata         |
| DELETE | `/api/work-instructions/:id` | `work_instructions:delete` | Delete WI and all children |

Work instructions are created through the standard `ItemService.create()` flow, like any other item type.

### Operations

| Method | Path                                                 | Permission                 | Description                             |
| ------ | ---------------------------------------------------- | -------------------------- | --------------------------------------- |
| GET    | `/api/work-instructions/:id/operations`              | `work_instructions:read`   | List operations ordered by index        |
| POST   | `/api/work-instructions/:id/operations`              | `work_instructions:update` | Create operation (appended to end)      |
| PUT    | `/api/work-instructions/:id/operations`              | `work_instructions:update` | Bulk reorder operations                 |
| PUT    | `/api/work-instructions/:id/operations/:operationId` | `work_instructions:update` | Update operation title/description/time |
| DELETE | `/api/work-instructions/:id/operations/:operationId` | `work_instructions:update` | Delete operation (reindexes remaining)  |

### Steps

| Method | Path                                       | Permission                 | Description                                 |
| ------ | ------------------------------------------ | -------------------------- | ------------------------------------------- |
| GET    | `/api/work-instructions/:id/steps`         | `work_instructions:read`   | List steps ordered by index                 |
| POST   | `/api/work-instructions/:id/steps`         | `work_instructions:update` | Create step (with optional position insert) |
| PUT    | `/api/work-instructions/:id/steps`         | `work_instructions:update` | Bulk reorder steps                          |
| GET    | `/api/work-instructions/:id/steps/:stepId` | `work_instructions:read`   | Get single step                             |
| PUT    | `/api/work-instructions/:id/steps/:stepId` | `work_instructions:update` | Update step content/title/order/operation   |
| DELETE | `/api/work-instructions/:id/steps/:stepId` | `work_instructions:update` | Delete step (reindexes remaining)           |

When creating a step with a specific `orderIndex`, existing steps at or after that position are shifted up automatically.

### Part Attachments

| Method | Path                               | Permission                 | Description                                        |
| ------ | ---------------------------------- | -------------------------- | -------------------------------------------------- |
| GET    | `/api/work-instructions/:id/parts` | `work_instructions:read`   | List attached parts with details                   |
| POST   | `/api/work-instructions/:id/parts` | `work_instructions:update` | Attach a part (body: `{ partId, inheritToMBOM? }`) |
| PATCH  | `/api/work-instructions/:id/parts` | `work_instructions:update` | Update attachment flags (e.g., `inheritToMBOM`)    |
| DELETE | `/api/work-instructions/:id/parts` | `work_instructions:update` | Detach a part (query or body: `partId`)            |
| GET    | `/api/parts/:id/work-instructions` | `parts:read`               | List WIs attached to a specific part               |

### Parametric Resolution

| Method | Path                                            | Permission               | Description                                |
| ------ | ----------------------------------------------- | ------------------------ | ------------------------------------------ |
| GET    | `/api/work-instructions/:id/resolve-parametric` | `work_instructions:read` | Resolve all parametric blocks in all steps |

Returns a map keyed by `{partId}.{attributePath}` with `{ value, available }` for each parametric reference.

### Change Alerts

| Method | Path                                | Permission                 | Description                                                                 |
| ------ | ----------------------------------- | -------------------------- | --------------------------------------------------------------------------- |
| GET    | `/api/work-instructions/:id/alerts` | `work_instructions:read`   | List alerts with counts (filterable by `?status=pending`)                   |
| PUT    | `/api/work-instructions/:id/alerts` | `work_instructions:update` | Acknowledge or dismiss a single alert (body: `{ alertId, action, notes? }`) |
| POST   | `/api/work-instructions/:id/alerts` | `work_instructions:update` | Bulk acknowledge all pending alerts                                         |

### Executions

| Method | Path                                                          | Permission               | Description                                          |
| ------ | ------------------------------------------------------------- | ------------------------ | ---------------------------------------------------- |
| GET    | `/api/work-instructions/:id/executions`                       | `work_instructions:read` | List executions (paginated: `?limit=&offset=`)       |
| POST   | `/api/work-instructions/:id/executions`                       | `work_instructions:read` | Start or resume execution (body: `{ workOrderId? }`) |
| GET    | `/api/work-instructions/:id/executions/:executionId`          | `work_instructions:read` | Get execution details                                |
| PUT    | `/api/work-instructions/:id/executions/:executionId`          | `work_instructions:read` | Update step data or progress                         |
| POST   | `/api/work-instructions/:id/executions/:executionId/complete` | `work_instructions:read` | Mark execution complete                              |

Note: Starting and updating executions require only `read` permission, since manufacturing technicians on read-only seats need to execute and record data.

### Sign-Off

| Method | Path                                                          | Permission           | Description                                                 |
| ------ | ------------------------------------------------------------- | -------------------- | ----------------------------------------------------------- |
| GET    | `/api/work-instructions/:id/executions/:executionId/sign-off` | `work_orders:read`   | Get sign-off records                                        |
| POST   | `/api/work-instructions/:id/executions/:executionId/sign-off` | `work_orders:update` | Submit approval/rejection (body: `{ decision, comments? }`) |

Sign-off endpoints use `work_orders` permissions since they are a supervisory function tied to work order management.

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

| Area                       | Path                                                         |
| -------------------------- | ------------------------------------------------------------ |
| Database schema            | `src/lib/db/schema/items.ts` (search for `workInstructions`) |
| Type definitions           | `src/lib/items/types/work-instruction.ts`                    |
| Item type registration     | `src/lib/items/registerItemTypes.server.ts`                  |
| Numbering scheme           | `src/lib/items/numbering/schemes.ts`                         |
| Inheritance service        | `src/lib/services/WorkInstructionInheritanceService.ts`      |
| Change alert service       | `src/lib/services/WorkInstructionChangeAlertService.ts`      |
| Execution service          | `src/lib/services/WorkInstructionExecutionService.ts`        |
| Parametric resolution      | `src/lib/services/ParametricResolutionService.ts`            |
| Background job definitions | `src/lib/jobs/definitions/workinstruction/`                  |
| API routes                 | `src/routes/api/work-instructions/`                          |
| Parts reverse-lookup       | `src/routes/api/parts/$id/work-instructions.ts`              |
| UI components              | `src/components/work-instructions/`                          |
