# Work Order Traveler: Instructions as Templates, Orders as Execution

**Status:** Implemented
**Date:** 2026-07-29
**Scope:** Refactor of the work-instruction execution model. Work Instructions become pure
templates; Work Orders carry **instances** of those templates (the traveler) and all
execution happens against the instances.

---

## 1. Motivation

Before this change, executions were owned by two masters at once:

- `work_instruction_executions` hung off the **Work Instruction**, with `workOrderId` as an
  optional tag-along column.
- The only UI path that started an execution was the WI detail page, and it never passed a
  work order — so in practice every execution was **standalone**, invisible to production
  planning, and could never reach sign-off (`requiresSignOff` lives on the WO).
- `quantityCompleted` on the WO incremented only when an execution was approved through
  sign-off — so orders that didn't require sign-off never counted anything, and one
  approved run of _any_ instruction counted as a whole finished unit.

That model conflates the **procedure** (authored, reusable, evolving) with the **event**
(a specific run, on a specific order, for a specific part, frozen in time). Real
manufacturing separates them: a released work order carries a **traveler** — the ordered,
frozen copy of every procedure that must be performed for that order — and the shop floor
executes the traveler, never the master document.

## 2. Concept model

```
WorkInstruction (item, template)          ← authored: operations → steps → blocks
      │  instantiate (snapshot)
      ▼
WorkOrderInstruction ("traveler line")    ← work_order_instructions row
      │  belongs to WorkOrder; pinned content snapshot; target part;
      │  requiredCount runs; sequence position; skippable
      ▼
InstructionExecution                      ← instruction_executions row
      │  a technician's run of one traveler line (step data, duration, unit label)
      ▼
ExecutionSignOff                          ← unchanged; per-execution supervisor review
```

- **Work Instruction = template.** Authoring only. It is never executed directly and no
  longer owns execution records. Its part attachments express _applicability_ ("this
  procedure applies to building this part").
- **Work Order = execution context.** Planning a WO builds its traveler by instantiating
  templates — one instance per (template × part) needed, potentially many when the order
  builds an assembly whose children each carry their own procedures.
- **Instance = frozen copy.** Instantiation snapshots the template's name, metadata,
  operations, and steps into `snapshot` JSONB on the instance. Later edits to the template
  never mutate a traveler that is already on the floor; a template deletion leaves the
  traveler intact (provenance FK goes null, snapshot stays). An instance can be re-synced
  from its template **only until execution begins** — after that the record is history.
- **Execution = run of an instance.** Step data is captured against the snapshot's block
  ids. `requiredCount` on the instance says how many completed runs the line needs
  (1 for a batch step, order quantity for per-unit steps). `unitLabel` optionally tags a
  run with the serial/unit it covered.

### Derived, not stored

Instance status is **derived** (same principle as the traceability work: quantity is a
query, not a field):

- `Skipped` — `skippedAt` set (requires reason; allowed until the line is complete)
- `Complete` — countable runs (`Complete` or `Approved`) ≥ `requiredCount`
- `In Progress` — at least one execution exists
- `Not Started` — otherwise

Work order completion is **gated on the traveler**: a transition into a final state the
lifecycle flags `finalKind: 'complete'` (`Complete` in the default) is rejected while any
non-skipped line is incomplete. Skipping (with a reason) is the audited escape hatch.
Cancel-kind finals abort ungated. Starting an execution on an order in its initial state
auto-transitions it along the initial state's unique transition to a non-final state
(`Not Started` → `In Progress` in the default; zero or several candidates means no
auto-start); any final state — however named — rejects new executions and freezes the
traveler. No state is named in the services; the flags decide.

### `quantityCompleted` decoupled from sign-off

The sign-off increment is gone. `quantityCompleted` is now:

- **derived from produced units** for serial-tracked built parts —
  `WorkOrderMaterialService.produce()` sets it to the count of `Produces` edges;
- **manually settable** via the WO update endpoint for lot/untracked parts.

An approved execution of one traveler line was never evidence that a unit left the line.

## 3. Schema

Replaced `work_instruction_executions` with two tables (`packages/core/src/lib/db/schema/work-orders.ts`;
the migration drops the old table):

```
work_order_instructions
  id uuid PK
  workOrderId uuid NOT NULL → work_orders.itemId  CASCADE
  workInstructionId uuid → work_instructions.itemId  SET NULL   -- provenance only
  partId uuid → items.id  SET NULL          -- which part this line applies to
  orderIndex integer NOT NULL               -- traveler sequence
  title varchar(500) NOT NULL               -- template name at snapshot
  instructionNumber varchar(64)             -- template itemNumber at snapshot
  instructionRevision varchar(10)
  snapshot jsonb NOT NULL                   -- InstructionSnapshot (metadata + operations + steps)
  snapshotAt timestamptz NOT NULL
  requiredCount integer NOT NULL DEFAULT 1  -- completed runs needed
  skippedAt / skippedBy / skipReason        -- audited not-applicable marker
  createdAt / createdBy

instruction_executions
  id uuid PK
  workOrderInstructionId uuid NOT NULL → work_order_instructions.id  CASCADE
  executedBy uuid NOT NULL → users.id
  unitLabel varchar(200)                    -- optional serial/unit tag for this run
  status varchar(30) NOT NULL DEFAULT 'In Progress'
      -- 'In Progress' | 'Complete' | 'Incomplete' | 'Pending Approval' | 'Approved' | 'Rejected'
  startedAt / completedAt / duration
  stepData jsonb                            -- captured values keyed by snapshot block id
  notes text
  currentStepIndex integer NOT NULL DEFAULT 0

execution_sign_offs                         -- unchanged shape; FK re-pointed
  executionId → instruction_executions.id  CASCADE
```

No unique constraint on (workOrderId, workInstructionId, partId): real travelers may
repeat a procedure at different sequence points. `populate` dedupes; manual adds are free.

## 4. Services

- **`WorkOrderInstructionService`** (new) — traveler management.
  `instantiate` (transactional snapshot; `perUnit: true` pins `requiredCount` to order
  quantity), `populate` (walk the order part's BOM depth-first, instantiate every
  attachment on every part in the tree, deepest first — children are built before the
  assembly; idempotent by (template, part)), `list` (+ derived status & execution
  counts), `get`, `reorder`, `updateRequiredCount`, `skip`/`unskip`,
  `refreshSnapshot` (rejected once executions exist), `remove` (rejected once executions
  exist — skip instead), `assertReadyForCompletion` (the WO completion gate),
  `listByTemplate` (author-side usage view).
- **`InstructionExecutionService`** (replaces `WorkInstructionExecutionService`) — run
  lifecycle against instances: `start` (resume-aware, validates WO/instance state,
  auto-starts the order), `updateStepData`, `updateProgress`, `complete` (sign-off
  routing via the instance's order), `abandon`, `submitSignOff`, `resubmitForApproval`,
  finders by instance / work order / template.
- **`LifecycleService.transitionFreeItem`** — the one write path for Free-lifecycle
  state, and where a work order's completion semantics live: entry into a
  `finalKind: 'complete'` state is gated on the traveler
  (`assertReadyForCompletion`) and stamps `completedAt` on the way in. Every door
  gets the same answer — `PUT /work-orders/:id/status`, the generic
  `POST /items/:id/transition`, and the `transition_item_state` AI tool all arrive
  here. It used to live in `WorkOrderService.updateStatus`, which left the other two
  able to mark an order Complete over an unfinished traveler and produce a row no
  route could repair.
- **`WorkOrderService.updateStatus`** — a thin caller of the above; returns the
  refreshed work order in its legacy shape.
- **`WorkOrderMaterialService.produce`** — syncs `quantityCompleted` from produced units.
- **`ParametricResolutionService.resolveBlocks`** — resolves parametric blocks from
  snapshot content (shared by the template path).

## 5. API

Work order routes (`/api/v1/work-orders/:id/…`) gain the traveler and absorb executions:

```
GET    /instructions                       list traveler (derived status, progress)
POST   /instructions                       instantiate a template  { workInstructionId, partId?, requiredCount?, perUnit? }
POST   /instructions/populate              instantiate from part-attachments across the order's BOM
PUT    /instructions                       reorder  { instructions: [{id, orderIndex}] }
GET    /instructions/:instructionId        instance detail (snapshot + executions)
PATCH  /instructions/:instructionId        { requiredCount }
POST   /instructions/:instructionId/skip   { reason }   /unskip   /refresh
DELETE /instructions/:instructionId        only while unexecuted
GET    /instructions/:instructionId/resolve-parametric
POST   /instructions/:instructionId/executions        start/resume  { unitLabel? }
GET    /instructions/:instructionId/executions
GET    /executions                         all runs for the order
GET    /executions/:executionId            (also PUT step-data/progress,
POST   /executions/:executionId/complete    abandon, resubmit, GET/POST sign-off)
```

Work instruction routes lose every `/executions` endpoint and gain
`GET /:id/usage` — where the template is instantiated, with execution stats.

Permissions: traveler management = `work_orders:update`; running executions =
`work_instructions:read` (technician seats, as before); sign-off = `work_orders:update`;
resubmit = `work_instructions:read` (service enforces original-executor).

## 6. UI

- **Work order page**: the read-only "Executions" tab became the **Instructions** tab —
  traveler list (sequence, part, progress, status), add-from-template dialog, populate
  button, reorder/skip/remove/refresh, per-line **Run**, plus the order-wide execution
  history. Runner lives at `/work-orders/$id/run/$instructionId` and reads the snapshot.
  Sign-off review moved to `/work-orders/$id/executions/$executionId`, with resubmit wired.
- **Work instruction page**: Execute button and Executions tab removed; a **Usage** tab
  shows the traveler lines instantiated from the template. `/present` remains the
  read-only template preview.

## 7. Tests

`WorkOrderInstructionService.test.ts` (data-integrity gate): snapshot immutability
against template edits/deletion, populate BOM-walk + idempotency, per-unit counts,
execution lifecycle → sign-off routing, requiredCount completion arithmetic, the WO
completion gate incl. skip, refresh/remove blocked after execution, no sign-off
increment of `quantityCompleted`.

## 8. Out of scope / later

- Linking executions to produced `PhysicalPart` units (unitLabel is free text today; a
  FK once per-unit genealogy precision lands).
- Template versioning beyond snapshot pinning (WIs are Free-lifecycle; if WIs ever move
  to revision control, `instructionRevision` already records the pin).
- Scheduling/time-tracking beyond per-run duration; work centers and routing resources.
