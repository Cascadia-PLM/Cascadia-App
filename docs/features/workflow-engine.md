# Workflow and Lifecycle Engine

Cascadia's workflow and lifecycle engine provides configurable state machines that govern how items move through their lifecycle and how change orders progress through approval processes. The engine is built around a unified lifecycle model with three behavior types: **Free**, **Driven**, and **Driving**.

## Table of Contents

- [Overview](#overview)
- [Unified Lifecycle Model](#unified-lifecycle-model)
- [Lifecycle Management](#lifecycle-management)
- [Per-Item-Type Lifecycles](#per-item-type-lifecycles)
- [Lifecycle Phases](#lifecycle-phases)
- [Revision Schemes](#revision-schemes)
- [Per-Phase Revision Reset](#per-phase-revision-reset)
- [Workflow Definitions](#workflow-definitions)
- [Workflow Instances](#workflow-instances)
- [Transition History](#transition-history)
- [Approval Voting](#approval-voting)
- [Comments on Transitions](#comments-on-transitions)
- [Auto-Start Workflows](#auto-start-workflows)
- [Default Workflows](#default-workflows)
- [API Reference](#api-reference)

---

## Overview

The engine serves two complementary purposes:

1. **Lifecycles** define the valid states an item can occupy and how ECO change actions move items between those states (e.g., Draft, Released, Superseded, Obsolete).

2. **Workflows** define the approval processes that change orders follow, with transitions, guards, actions, and approvals (e.g., Draft -> In Review -> Approved).

Both are stored in the same `workflow_definitions` table and share a common structure of states and transitions. The key difference is behavioral: lifecycles declare states that items occupy, while workflows actively drive items through an approval process.

### Key Principles

- **All item state changes go through ECOs.** Parts, Documents, and Requirements cannot transition directly. Their states change only when an ECO's workflow transitions execute `transition_driven_item` actions.
- **Workflow definitions are JSON-based.** States, transitions, guards, and actions are stored as JSONB in PostgreSQL. No code changes are required to create new workflows.
- **Guard evaluation is pluggable.** Three guard types are supported out of the box: `field_value`, `user_role`, and `approval_count`.
- **Flexible workflows** allow per-instance customization of states and transitions. The definition serves as a template that users can modify on each change order.

### Architecture

```
src/lib/workflows/
  WorkflowService.ts          # CRUD, transitions, validation, lifecycle effects
  WorkflowApprovalService.ts  # Approval voting and tracking
  GuardEvaluator.ts           # Guard condition evaluation
  constants.ts                # Standard state names, IDs, colors
  types.ts                    # TypeScript interfaces
  index.ts                    # Public exports

src/lib/services/
  LifecycleService.ts         # Lifecycle-specific operations (phases, revisions)

src/lib/types/
  lifecycle.ts                # Revision schemes, phases, change action mappings
```

---

## Unified Lifecycle Model

Every workflow/lifecycle definition has a `lifecycleType` that determines its behavior:

| Lifecycle Type | Behavior                                                                                                                                      | Examples                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Free**       | Self-controlled with manual transitions. Users can transition states directly without an ECO.                                                 | Issues, Tasks, Work Instructions |
| **Driven**     | ECO-controlled. Declares valid states only. State changes happen when a Driving lifecycle executes `transition_driven_item` actions.          | Parts, Documents, Requirements   |
| **Driving**    | Controls Driven lifecycles. Has `transition_driven_item` actions on its transitions that move affected items through their Driven lifecycles. | ECO Workflow, Flexible ECO       |

### Relationship Between Types

```
  Driving (ECO Workflow)                    Driven (Part Lifecycle)
  ========================                  ========================
  Draft ──> In Review ──> Approved          Draft ──> Released ──> Superseded
                           │                            ^
                           │                            |
                           └── transition_driven_item ──┘
                               (Draft → Released)
```

When an ECO transitions to "Approved", the `transition_driven_item` action on that transition automatically moves all affected parts from "Draft" to "Released".

### Drivers Configuration

Driven lifecycles have a `drivers` array that lists which Driving lifecycle IDs are permitted to act on them. This allows different ECO types to control different item types:

```typescript
// Part lifecycle allows both standard and flexible ECO workflows
drivers: [LIFECYCLE_IDS.changeOrder, LIFECYCLE_IDS.flexibleChangeOrder]
```

If no drivers are configured, any Driving lifecycle can act (permissive default).

---

## Lifecycle Management

### State Definitions

Each state in a lifecycle has these properties:

| Property      | Type      | Description                                                             |
| ------------- | --------- | ----------------------------------------------------------------------- |
| `id`          | `string`  | Unique identifier within the definition (e.g., `"Draft"`, `"InReview"`) |
| `name`        | `string`  | Display name (e.g., `"In Review"`)                                      |
| `color`       | `string`  | Visual indicator color (e.g., `"gray"`, `"green"`, `"red"`)             |
| `description` | `string`  | Human-readable description of this state                                |
| `isInitial`   | `boolean` | Whether this is the starting state (exactly one per definition)         |
| `isFinal`     | `boolean` | Whether this is a terminal state (zero or more per definition)          |
| `phaseId`     | `string`  | Optional lifecycle phase assignment                                     |
| `position`    | `{x, y}`  | Position for visual layout in the workflow editor                       |

### Standard State Colors

```
gray      Draft, Start states
yellow    In Review, Under Review
green     Released, Approved, Resolved
blue      Released (alternate), Open
orange    Pending, Under Review
red       Rejected, Obsolete, Cancelled
slate     Superseded, Closed
purple    Preliminary
emerald   Verified
```

### Transitions

Transitions connect states and define how an item moves between them:

| Property              | Type                  | Description                                |
| --------------------- | --------------------- | ------------------------------------------ |
| `id`                  | `string`              | Unique identifier                          |
| `name`                | `string`              | Display name (e.g., `"Submit for Review"`) |
| `fromStateId`         | `string`              | Source state ID                            |
| `toStateId`           | `string`              | Target state ID                            |
| `guards`              | `TransitionGuard[]`   | Conditions that must pass                  |
| `actions`             | `TransitionAction[]`  | Side effects to execute                    |
| `allowedRoles`        | `string[]`            | Role-based access control                  |
| `approvalRequirement` | `ApprovalRequirement` | Approval voting requirements               |
| `lifecycleEffects`    | `LifecycleEffect[]`   | ECO-to-item lifecycle coordination         |

### Initial and Final States

- Every definition must have exactly **one** initial state. New items start here.
- Final states are optional but recommended. When a workflow instance reaches a final state, the instance is marked as completed (`completedAt` is set).
- For ECO workflows, reaching a final state automatically triggers `ChangeOrderService.close()` which merges branches and assigns revisions.

### Validation Rules

The engine validates definitions to ensure structural integrity:

| Rule                                                      | Severity |
| --------------------------------------------------------- | -------- |
| Must have a name                                          | Error    |
| Must have at least one state                              | Error    |
| Must have exactly one initial state                       | Error    |
| No duplicate state IDs                                    | Error    |
| Transitions must reference valid states                   | Error    |
| Should have at least one final state                      | Warning  |
| States without incoming transitions (unreachable)         | Warning  |
| Non-final states without outgoing transitions (dead ends) | Warning  |

---

## Per-Item-Type Lifecycles

Each item type is assigned a lifecycle definition via the `item_type_configs` table. The `RuntimeItemTypeConfig.lifecycleDefinitionId` field links an item type to its lifecycle.

### Default Lifecycle Assignments

| Item Type       | Lifecycle                    | Type    | Lifecycle ID                    |
| --------------- | ---------------------------- | ------- | ------------------------------- |
| Part            | Part - Default Lifecycle     | Driven  | `LIFECYCLE_IDS.part`            |
| Document        | Document - Default Lifecycle | Driven  | `LIFECYCLE_IDS.document`        |
| Requirement     | (uses same pattern as Part)  | Driven  | `LIFECYCLE_IDS.requirement`     |
| ChangeOrder     | ECO - Default Workflow       | Driving | `LIFECYCLE_IDS.changeOrder`     |
| Issue           | Issue - Default Lifecycle    | Free    | `LIFECYCLE_IDS.issue`           |
| Task            | (Free lifecycle)             | Free    | `LIFECYCLE_IDS.task`            |
| WorkInstruction | (Free lifecycle)             | Free    | `LIFECYCLE_IDS.workInstruction` |

The `LIFECYCLE_IDS` constants are defined in `src/lib/items/lifecycle-ids.ts` as well-known UUIDs to ensure consistent linkage between seed scripts and code.

### Changing a Lifecycle Assignment

Lifecycle assignments can be changed at runtime through the Admin UI (`/admin/item-types/:itemType`). The system validates that:

- The new lifecycle includes all states that items are currently in.
- The old lifecycle is not deleted while item types reference it.
- States cannot be removed from a lifecycle if items are currently in those states.

---

## Lifecycle Phases

Phases group lifecycle states into logical stages, such as "Prototype" and "Production". Each phase can override the lifecycle-level revision scheme and optionally reset revision numbering.

### Phase Configuration

```typescript
interface LifecyclePhaseConfig {
  id: string // Unique identifier
  name: string // Display name (e.g., "Prototype", "Production")
  revisionScheme?: RevisionScheme // Override lifecycle-level revision scheme
  resetRevisionOnEntry?: boolean // Reset revision counter when entering this phase
  color?: string // Display color
  order: number // Display sort order
}
```

### Phase Assignment

States reference their phase via the `phaseId` property:

```typescript
// Example: A lifecycle with Prototype and Production phases
{
  phases: [
    { id: "proto", name: "Prototype", order: 1, revisionScheme: { type: "prefixed-numeric", prefix: "X" } },
    { id: "prod",  name: "Production", order: 2, revisionScheme: { type: "alpha" }, resetRevisionOnEntry: true },
  ],
  states: [
    { id: "Draft",      name: "Draft",      phaseId: "proto", isInitial: true },
    { id: "Released",   name: "Released",    phaseId: "prod" },
    { id: "Superseded", name: "Superseded",  phaseId: "prod", isFinal: true },
    { id: "Obsolete",   name: "Obsolete",    phaseId: "prod", isFinal: true },
  ]
}
```

### Phase Boundary Crossing

The `promote` change action is specifically designed for transitions that cross phase boundaries. The `LifecycleService.crossesPhase()` method checks whether a from/to state pair spans different phases.

Validation enforces that:

- The `promote` mapping's `fromState` and `toState` must be in different phases.
- Phases with no assigned states produce a warning.
- States without a phase assignment produce a warning when phases are defined.

---

## Revision Schemes

Revision schemes control how revision identifiers are generated when items are released or revised.

### Available Schemes

| Scheme             | Format                  | Example Sequence  | Use Case                        |
| ------------------ | ----------------------- | ----------------- | ------------------------------- |
| `alpha`            | A, B, C, ..., Z, AA, AB | A -> B -> C       | Traditional PLM (default)       |
| `numeric`          | 1, 2, 3, ...            | 1 -> 2 -> 3       | Prototype/pre-production        |
| `prefixed-numeric` | X1, X2, X3, ...         | X1 -> X2 -> X3    | Prototype revisions with prefix |
| `none`             | No change               | (stays unchanged) | Items without revision tracking |

### Type Definitions

```typescript
type RevisionScheme =
  | { type: 'alpha'; uppercase?: boolean }
  | { type: 'numeric' }
  | { type: 'prefixed-numeric'; prefix: string }
  | { type: 'none' }
```

### Resolution Order

The effective revision scheme for a state is resolved in this order:

1. **Phase-level override** -- If the state's phase defines a `revisionScheme`, use it.
2. **Lifecycle-level default** -- If the lifecycle definition has a `revisionScheme`, use it.
3. **System fallback** -- If neither is set, default to `alpha`.

This allows scenarios like prototype revisions using `X1, X2, X3` while production revisions use `A, B, C`.

---

## Per-Phase Revision Reset

When a lifecycle phase has `resetRevisionOnEntry: true`, the revision counter resets when an item enters that phase via the `promote` change action.

### Example

Consider a part moving from Prototype to Production:

```
Prototype Phase (prefixed-numeric, prefix "X"):
  X1 -> X2 -> X3  (three prototype revisions)

  ── promote ──>

Production Phase (alpha, resetRevisionOnEntry: true):
  A -> B -> C  (revision resets, starts fresh at A)
```

The `PromoteActionMapping` can also explicitly override this behavior via the `resetRevision` property.

---

## Workflow Definitions

Workflow definitions are JSON objects stored in the `workflow_definitions` table.

### Database Schema

```
workflow_definitions
  id                  UUID        Primary key
  name                VARCHAR     Unique name (e.g., "ECO - Default Workflow")
  version             INTEGER     Definition version number
  workflowType        VARCHAR     "strict" or "flexible"
  definition          JSONB       Full definition including states, transitions, etc.
  isActive            BOOLEAN     Whether this definition is available for use
  lifecycleType       ENUM        "Free", "Driven", or "Driving"
  drivers             JSONB       Array of Driving lifecycle IDs (for Driven lifecycles)
  createdAt           TIMESTAMP   Creation timestamp
```

### Definition JSONB Structure

The `definition` column stores the complete workflow configuration:

```typescript
{
  definitionType: "lifecycle" | "workflow",   // Legacy field
  lifecycleType: "Free" | "Driven" | "Driving",
  description: "Human-readable description",
  applicableItemTypes: ["Part", "Document"],
  states: [
    { id: "Draft", name: "Draft", color: "gray", isInitial: true, isFinal: false }
  ],
  transitions: [
    { id: "t1", name: "Submit", fromStateId: "Draft", toStateId: "InReview",
      guards: [...], actions: [...] }
  ],
  changeActionMappings: { release: {...}, revise: {...}, obsolete: {...} },
  revisionScheme: { type: "alpha" },
  phases: [...]
}
```

### Strict vs Flexible Workflows

| Property           | Strict                         | Flexible                                    |
| ------------------ | ------------------------------ | ------------------------------------------- |
| States/transitions | Fixed from definition          | Copied to instance, modifiable per-instance |
| Guard evaluation   | Full guards                    | Approval requirements only                  |
| Actions            | Before/after actions supported | Not supported                               |
| Use case           | Standard ECO approval          | Ad-hoc change orders with custom routing    |

### Guard Types

Guards are conditions evaluated before a transition is allowed:

**Field Value Guard** (`field_value`)

```typescript
{
  type: "field_value",
  config: {
    fieldName: "part.material",
    operator: "is_not_empty",     // equals, not_equals, contains, is_empty,
                                  // is_not_empty, greater_than, less_than,
                                  // greater_or_equal, less_or_equal
    value: "Aluminum"             // Optional, depends on operator
  }
}
```

**User Role Guard** (`user_role`)

```typescript
{
  type: "user_role",
  config: {
    requiredRoles: ["Engineer", "Manager"],
    requireAll: false              // true = AND, false = OR
  }
}
```

**Approval Count Guard** (`approval_count`)

```typescript
{
  type: "approval_count",
  config: {
    requiredCount: 2,
    requiredRoles: ["Reviewer"]    // Optional role filter
  }
}
```

### Guard Presets

The `GuardPresets` utility provides factory functions for common guard patterns:

```typescript
import { GuardPresets } from '@/lib/workflows'

GuardPresets.requiredField('reasonForChange') // Field must not be empty
GuardPresets.fieldEquals('priority', 'High') // Field must equal value
GuardPresets.hasRole(['Engineer', 'Manager']) // User must have role
GuardPresets.minApprovals(2, ['Reviewer']) // Minimum approval count
```

### Action Types

Actions execute side effects during a transition:

| Type                     | Execute On   | Description                                          |
| ------------------------ | ------------ | ---------------------------------------------------- |
| `update_field`           | before/after | Update a field on the item                           |
| `send_notification`      | before/after | Send notification to users or roles                  |
| `create_task`            | before/after | Create a task (not yet implemented)                  |
| `transition_driven_item` | after        | Transition affected items on their Driven lifecycles |

The `transition_driven_item` action is the key mechanism by which ECO workflows drive item state changes:

```typescript
{
  type: "transition_driven_item",
  executeOn: "after",
  config: {
    drivenLifecycleId: "00000000-0000-4000-8000-000000000100",  // Part lifecycle
    fromStateId: "Draft",
    targetStateId: "Released",
    validateGates: true
  }
}
```

---

## Workflow Instances

When a workflow is started for an item, a `workflow_instances` record is created to track runtime state.

### Database Schema

```
workflow_instances
  id                      UUID        Primary key
  workflowDefinitionId    UUID        FK to workflow_definitions
  itemId                  UUID        FK to items (the item this workflow is attached to)
  currentState            VARCHAR     Current state ID
  startedAt               TIMESTAMP   When the instance was created
  completedAt             TIMESTAMP   When a final state was reached (null if active)
  context                 JSONB       Arbitrary context data
  instanceStates          JSONB       Instance-level state overrides (flexible workflows)
  instanceTransitions     JSONB       Instance-level transition overrides (flexible workflows)
  scopeLocked             BOOLEAN     Whether the ECO scope is locked
  scopeLockedAt           TIMESTAMP   When scope was locked
```

### Instance Lifecycle

```
  ┌──────────────────────────────────┐
  │  WorkflowService.startInstance() │
  │  Creates instance at initial     │
  │  state, records "started" in     │
  │  history                         │
  └───────────────┬──────────────────┘
                  │
                  v
  ┌──────────────────────────────────┐
  │  Active Instance                 │
  │  - Guards evaluated on each      │
  │    transition attempt            │
  │  - Before actions executed       │
  │  - State updated                 │
  │  - History recorded              │
  │  - After actions executed        │
  └───────────────┬──────────────────┘
                  │ (reaches final state)
                  v
  ┌──────────────────────────────────┐
  │  Completed Instance              │
  │  - completedAt is set            │
  │  - For ECOs: close() is called   │
  │    to merge branches and assign  │
  │    revisions                     │
  └──────────────────────────────────┘
```

### Scope Locking

For Driving lifecycles (ECO workflows), the scope is locked when the workflow transitions out of its initial state for the first time. Once locked:

- No more affected items can be added to the ECO.
- This prevents scope creep during the review/approval process.
- The lock is indicated by `scopeLocked = true` and a `scopeLockedAt` timestamp.

### Flexible Workflow Instance Editing

For flexible (`workflowType: 'flexible'`) workflows, the definition's states and transitions are copied to the instance at creation time. Users can then modify the instance structure:

```typescript
// Update instance structure
WorkflowService.updateInstanceStructure(
  instanceId,
  newStates,
  newTransitions,
  actorId,
)
```

Validation ensures:

- Current state must still exist in the new structure.
- Exactly one initial state and at least one final state.
- All transitions reference valid states.
- Current state has at least one outgoing transition (unless it is final).
- Cannot modify a completed workflow.

### Effective Structure Resolution

`WorkflowService.getEffectiveStructure()` resolves the actual states and transitions for an instance:

- **Strict workflows**: Returns the definition's states and transitions.
- **Flexible workflows with overrides**: Returns the instance-level states and transitions.
- **Flexible workflows without overrides**: Returns the definition's states and transitions.

---

## Transition History

Every state change is recorded in the `workflow_history` table, providing a complete audit trail.

### Database Schema

```
workflow_history
  id            UUID        Primary key
  instanceId    UUID        FK to workflow_instances
  fromState     VARCHAR     Previous state (null for initial "started" entry)
  toState       VARCHAR     New state
  action        VARCHAR     Transition name or special action (e.g., "started")
  actorId       UUID        FK to users (who performed the transition)
  timestamp     TIMESTAMP   When the transition occurred
  comments      TEXT        User-provided comments
  data          JSONB       Additional metadata (guard results, action results, etc.)
```

### History Entry Types

| Action                        | Description                                           |
| ----------------------------- | ----------------------------------------------------- |
| `started`                     | Initial entry when workflow instance is created       |
| (transition name)             | Normal state transition (e.g., `"Submit for Review"`) |
| `workflow_structure_modified` | Flexible workflow structure was updated               |

### Querying History

```typescript
const history = await WorkflowService.getHistory(instanceId)
// Returns WorkflowHistoryEntry[] ordered by timestamp descending
```

Each entry in `data` may contain:

- `guardResults`: Array of guard evaluation outcomes.
- `beforeActionResults`: Results of before-actions.
- `isInstanceLevel`: Whether the transition used instance-level structure.
- `definitionName`: Name of the definition (on "started" entries).
- `isFlexible`: Whether the definition is flexible (on "started" entries).

---

## Approval Voting

The approval system operates at two levels:

### 1. Definition-Level Approvers

Approvers are assigned to workflow states via the `workflow_state_approvers` table. Each approver can be a **user** or a **role**:

```
workflow_state_approvers
  id                      UUID
  workflowDefinitionId    UUID        FK to workflow_definitions
  stateId                 VARCHAR     The state this approver is for
  approverType            VARCHAR     "user" or "role"
  approverId              UUID        References users.id or roles.id
  isRequired              BOOLEAN     Whether this approval is mandatory
  createdBy               UUID        FK to users
  createdAt               TIMESTAMP
```

### 2. Instance-Level Votes

Actual votes are tracked per workflow instance in the `workflow_approval_votes` table:

```
workflow_approval_votes
  id                    UUID
  workflowInstanceId    UUID        FK to workflow_instances
  stateId               VARCHAR     The state being voted on
  userId                UUID        FK to users (who voted)
  roleId                UUID        If voting on behalf of a role
  vote                  VARCHAR     "approved" or "rejected"
  comments              TEXT        Vote comments
  votedAt               TIMESTAMP
```

### Approval Flow

1. Approvers are configured on workflow definition states (Admin UI).
2. When a workflow instance enters a state with approvers, they can submit votes.
3. The system checks `WorkflowApprovalService.canUserApprove()` before accepting votes.
4. When all required approvers have approved, `areApprovalsComplete()` returns `met: true`.
5. Transitions check approval status as part of guard evaluation.

### Approval Status Checking

```typescript
// Check if approvals are complete for a state
const status = await WorkflowApprovalService.areApprovalsComplete(
  instanceId,
  stateId,
)
// Returns: { met: boolean, required: number, current: number, pending: [...] }
```

### Voting Rules

- A user can only vote once per state per instance.
- If no approvers are defined for a state, anyone can approve.
- When a workflow transitions backward, approvals for forward states are cleared.
- Users can approve as themselves (direct approver) or on behalf of a role they hold.

---

## Comments on Transitions

Every transition supports an optional `comments` field. When a user triggers a transition, they can provide a comment that is stored in the `workflow_history` record.

### Usage

```typescript
// Via the API
POST /api/change-orders/:id/workflow/transition
{
  "toStateId": "InReview",
  "comments": "Ready for engineering review. All BOM changes validated."
}
```

```typescript
// Via the service layer
await WorkflowService.transition(
  instanceId,
  'InReview',
  userId,
  'Ready for engineering review', // comments parameter
)
```

Comments appear in the transition history alongside the actor, timestamp, and from/to states.

---

## Auto-Start Workflows

When a Change Order is created, the system automatically starts the appropriate workflow based on the change order's type.

### Configuration

The `workflowsByChangeType` mapping in `RuntimeItemTypeConfig` determines which workflow definition to use for each change type:

```typescript
// In item_type_configs for ChangeOrder
{
  workflowsByChangeType: {
    ECO: "00000000-0000-4000-8000-000000000102",   // ECO - Default Workflow
    ECN: "00000000-0000-4000-8000-000000000102",   // Same default for ECN
    Deviation: "00000000-0000-4000-8000-000000000102",
    MCO: "00000000-0000-4000-8000-000000000102",
    XCO: "00000000-0000-4000-8000-000000000103",   // Dynamic Change Order (flexible)
  }
}
```

### Auto-Start Behavior

```typescript
// Called during change order creation
await ChangeOrderService.autoStartWorkflow(changeOrderId, changeType, userId)
```

1. Looks up `workflowsByChangeType[changeType]` from the runtime config.
2. Calls `WorkflowService.startInstance()` with the resolved workflow definition ID.
3. The workflow begins at its initial state.

If no workflow is configured for the change type, an error is thrown.

---

## Default Workflows

Cascadia ships with the following default workflow/lifecycle definitions.

### Part - Default Lifecycle (Driven)

A standard PLM lifecycle for parts. All state changes go through ECOs.

```
                                    ┌────────────┐
                               ┌───>│ Superseded │
  ┌───────┐     ┌──────────┐  │    │  (slate)   ���
  │ Draft │────>│ Released  │──┤    │  [final]   │
  │ (gray)│     │ (green)   │  │    └────────────┘
  │[init] │     │           │  │
  └───────┘     └──────────-┘  │    ┌────────────┐
                               └───>│  Obsolete  │
                                    │   (red)    │
                                    │  [final]   │
                                    └────────────┘
```

**Change Action Mappings:**

| Action     | From State | To State                         | Assigns Revision |
| ---------- | ---------- | -------------------------------- | ---------------- |
| `release`  | Draft      | Released                         | Yes              |
| `revise`   | Released   | Released (new), Superseded (old) | Yes              |
| `obsolete` | Released   | Obsolete                         | No               |

**Drivers:** ECO - Default Workflow, Dynamic Change Order

### Document - Default Lifecycle (Driven)

Identical structure to the Part lifecycle but assigned to Documents. Same states, same change action mappings.

### ECO - Default Workflow (Driving, Strict)

A simple three-state approval workflow for Engineering Change Orders.

```
  ┌───────┐     ┌───────────┐     ┌──────────┐
  │ Draft │────>│ In Review │────>│ Approved │
  │ (gray)│     │ (yellow)  │     │ (green)  │
  │[init] │     │           │     │ [final]  │
  └───────┘     └───────────┘     └──────────┘
     Submit         Approve
   for Review
```

**Transitions:**

| Transition        | From     | To       | Actions                                                              |
| ----------------- | -------- | -------- | -------------------------------------------------------------------- |
| Submit for Review | Draft    | InReview | (none)                                                               |
| Approve           | InReview | Approved | Release Parts (Draft->Released), Release Documents (Draft->Released) |

When "Approve" is executed:

1. The workflow transitions to the "Approved" final state.
2. `transition_driven_item` actions release all affected Parts and Documents from Draft to Released.
3. Because "Approved" is a final state, `ChangeOrderService.close()` runs automatically, merging the ECO branch to main and assigning revision letters.

### Dynamic Change Order (Driving, Flexible)

A minimal two-state template for ad-hoc change orders. Users customize the workflow per instance.

```
  ┌───────┐     ┌──────────┐
  │ Start │────>│ Complete │
  │ (gray)│     │ (green)  │
  │[init] │     │ [final]  │
  └───────┘     └──────────┘
    Complete
```

Users can add intermediate states (e.g., "Engineering Review", "Quality Review") and transitions on each instance. The "Complete" transition includes the same `transition_driven_item` actions as the default ECO workflow.

### Issue - Default Lifecycle (Free)

A self-controlled lifecycle for issue tracking. Users can transition states directly without ECO approval.

```
  ┌──────┐      ┌─────────────┐      ┌──────────┐      ┌──────────┐      ┌────────┐
  │ Open │─────>│ In Progress │─────>│ Resolved │─────>│ Verified │─────>│ Closed │
  │(blue)│      │  (yellow)   │      │ (green)  │      │(emerald) │      │(slate) │
  │[init]│      │             │      │          │      │          │      │[final] │
  └──┬───┘      └──────┬──────┘      └────┬─────┘      └──────────┘      └─��──────┘
     │                 │                   │
     │          ┌──────┴──────┐            │
     │          │   Pending   │<───────────┘ (Reopen)
     │          │  (orange)   │
     │          └─────────────┘
     │                 │
     v                 v
  ┌───────────────────────┐
  │      Cancelled        │
  │        (red)          │
  │       [final]         │
  └───────────────────────┘
```

**Transitions:**

| Transition             | From                         | To          |
| ---------------------- | ---------------------------- | ----------- |
| Start Work             | Open                         | In Progress |
| Put on Hold            | In Progress                  | Pending     |
| Resume                 | Pending                      | In Progress |
| Resolve                | In Progress                  | Resolved    |
| Resolve from Pending   | Pending                      | Resolved    |
| Verify                 | Resolved                     | Verified    |
| Reopen                 | Resolved                     | In Progress |
| Close                  | Verified                     | Closed      |
| Cancel (3 transitions) | Open / In Progress / Pending | Cancelled   |

---

## API Reference

### Workflow Definitions

| Method   | Endpoint                      | Description                                                                  |
| -------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `GET`    | `/api/v1/workflows`              | List all definitions (supports `?isActive=true&type=lifecycle`)              |
| `POST`   | `/api/v1/workflows`              | Create a new definition                                                      |
| `GET`    | `/api/v1/workflows/:id`          | Get a definition by ID                                                       |
| `PUT`    | `/api/v1/workflows/:id`          | Update a definition                                                          |
| `DELETE` | `/api/v1/workflows/:id`          | Delete a definition (blocked if active instances or item types reference it) |
| `POST`   | `/api/v1/workflows/:id/validate` | Validate a definition's structure                                            |

### Workflow Approvers

| Method   | Endpoint                                                   | Description                              |
| -------- | ---------------------------------------------------------- | ---------------------------------------- |
| `GET`    | `/api/v1/workflows/:id/approvers`                             | Get all state approvers for a definition |
| `GET`    | `/api/v1/workflows/:id/states/:stateId/approvers`             | Get approvers for a specific state       |
| `PUT`    | `/api/v1/workflows/:id/states/:stateId/approvers`             | Replace all approvers for a state        |
| `POST`   | `/api/v1/workflows/:id/states/:stateId/approvers`             | Add a single approver                    |
| `PATCH`  | `/api/v1/workflows/:id/states/:stateId/approvers/:approverId` | Update approver required status          |
| `DELETE` | `/api/v1/workflows/:id/states/:stateId/approvers/:approverId` | Remove an approver                       |

### Change Order Workflow

| Method | Endpoint                                              | Description                              |
| ------ | ----------------------------------------------------- | ---------------------------------------- |
| `GET`  | `/api/v1/change-orders/:id/workflow`                     | Get workflow instance for a change order |
| `POST` | `/api/v1/change-orders/:id/workflow`                     | Start a workflow for a change order      |
| `GET`  | `/api/v1/change-orders/:id/workflow/transition`          | Get available transitions                |
| `POST` | `/api/v1/change-orders/:id/workflow/transition`          | Execute a transition                     |
| `POST` | `/api/v1/change-orders/:id/workflow/validate-transition` | Validate a transition before executing   |

### Service Layer

```typescript
import {
  WorkflowService,
  WorkflowApprovalService,
  GuardEvaluator,
} from '@/lib/workflows'
import { LifecycleService } from '@/lib/services/LifecycleService'

// CRUD
const definition = await WorkflowService.create(input)
const definition = await WorkflowService.getById(id)
const definitions = await WorkflowService.list({ isActive: true })
const updated = await WorkflowService.update(id, changes)
await WorkflowService.delete(id)

// Instances
const instance = await WorkflowService.startInstance(
  definitionId,
  itemId,
  context,
)
const instance = await WorkflowService.getInstanceByItemId(itemId)
const history = await WorkflowService.getHistory(instanceId)

// Transitions
const available = await WorkflowService.getAvailableTransitions(
  instanceId,
  guardContext,
)
const { allowed, reasons } = await WorkflowService.canTransition(
  instanceId,
  toStateId,
  context,
)
const result = await WorkflowService.transition(
  instanceId,
  toStateId,
  actorId,
  comments,
)

// Approvals
const status = await WorkflowApprovalService.areApprovalsComplete(
  instanceId,
  stateId,
)
const canApprove = await WorkflowApprovalService.canUserApprove(
  instanceId,
  stateId,
  userId,
)
const vote = await WorkflowApprovalService.submitApproval(
  instanceId,
  stateId,
  userId,
  'approved',
)

// Lifecycles
const lifecycle = await LifecycleService.getLifecycleForItemType('Part')
const initialState = await LifecycleService.getInitialState('Part')
const validActions = await LifecycleService.getValidActions('Part', 'Draft')
const scheme = await LifecycleService.getRevisionSchemeForState(
  lifecycle,
  'Released',
)
```
