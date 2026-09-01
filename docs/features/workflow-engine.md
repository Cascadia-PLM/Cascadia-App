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

- **No state name appears in application logic.** A state has exactly three machine-readable properties — `isInitial`, `isFinal` (+ `finalKind`), and the roles it plays in change-action mappings (`release`/`revise`/`obsolete`/`promote`). Everything else about a state, including its name, belongs to whoever configures the lifecycle. Services derive "is this released lineage", "is this the initial state", "has the flow ended" from those flags and mappings through `LifecycleService` (see [Deriving from flags and mappings](#deriving-from-flags-and-mappings)); the UI renders names and colours from the lifecycle definition (`StateBadge`). The shipped defaults in `packages/core/src/lib/items/default-lifecycles.ts` are configuration, not logic.
- **Item state changes are lifecycle-enforced by the server.** Released lineage (the states the release mappings produce) is entered and left only through ECO release. Everything else moves through `POST /api/v1/items/:id/transition`, validated against the lifecycle's declared transitions: all of a Free lifecycle's edges, and a Driven lifecycle's declared pre-release edges (review progress such as Draft → Proposed → Approved on the default Requirement lifecycle). The generic item-update API rejects attempts to change `state`, `revision`, or `isCurrent` outright.
- **Workflow definitions are JSON-based.** States, transitions, guards, and actions are stored as JSONB in PostgreSQL. No code changes are required to create new workflows.
- **Guard evaluation is pluggable.** Two guard types are supported out of the box: `field_value` and `user_role`. (Approval gating is not a guard — the transition path enforces it directly, from state approvers and the transition's `requiredCount`.)
- **Flexible workflows** allow per-instance customization of states and transitions. The definition serves as a template that users can modify on each change order.

### Architecture

```
packages/core/src/lib/workflows/
  WorkflowService.ts          # CRUD, transitions, validation, lifecycle effects
  WorkflowApprovalService.ts  # Approval voting and tracking
  GuardEvaluator.ts           # Guard condition evaluation
  constants.ts                # Standard state names, IDs, colors
  types.ts                    # TypeScript interfaces
  index.ts                    # Public exports

packages/core/src/lib/services/
  LifecycleService.ts         # Lifecycle-specific operations (phases, revisions)

packages/core/src/lib/types/
  lifecycle.ts                # Revision schemes, phases, change action mappings
```

---

## Unified Lifecycle Model

Every workflow/lifecycle definition has a `lifecycleType` that determines its behavior:

| Lifecycle Type | Behavior                                                                                                                      | Examples                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Free**       | Self-controlled with manual transitions. Users can transition states directly without an ECO.                                 | Issues, Tasks, Work Instructions |
| **Driven**     | ECO-controlled. Declares valid states plus `changeActionMappings` that the merge applies at change-order release.             | Parts, Documents, Requirements   |
| **Driving**    | Change-order approval workflows. Completing one with a release runs the merge, which applies the Driven lifecycles' mappings. | ECO Workflow, Flexible ECO       |

### Relationship Between Types

```
  Driving (ECO Workflow)                    Driven (Part Lifecycle)
  ========================                  ========================
  Draft ──> In Review ──> Approved          Draft ──> Released ──> Superseded
                           │                            ^
                           │                            |
                           └── release merge applies ───┘
                               changeActionMappings
                               (release: Draft → Released)
```

When an ECO completes in a `finalKind: 'release'` state, the merge applies each affected item's change action through its Driven lifecycle's `changeActionMappings` (release: Draft → Released, revise: old → Superseded / new → Released, obsolete: Released → Obsolete) and assigns revision letters. This is the **single mechanism** for ECO-driven state change — there are no per-transition item actions.

### Drivers Configuration

Driven lifecycles have a `drivers` array that lists which Driving lifecycle IDs are permitted to act on them. This allows different ECO types to control different item types:

```typescript
// Part lifecycle allows both standard and flexible ECO workflows
drivers: [LIFECYCLE_IDS.changeOrder, LIFECYCLE_IDS.flexibleChangeOrder]
```

If no drivers are configured, any Driving lifecycle can act (permissive default).

The allow-list is **enforced** (remediation WI-4.4):

- `ChangeOrderService.addAffectedItem` rejects state-changing actions from an
  unauthorized ECO at scope entry.
- `ChangeOrderMergeService.merge` re-checks every state-changing affected item
  before releasing, on both the branch and affected-items paths.
- The transition-validation preview reports driver violations up front.
- Saving a definition validates that every listed driver ID references an
  existing **Driving** definition.

---

## Lifecycle Management

### State Definitions

**State identity is the `id`, everywhere** (remediation WI-5.1/5.2): it is
what the engine matches on, what `items.state`, `workflow_instances.
current_state`, and `workflow_history` store, and what
`changeActionMappings` reference — definition save rejects a mapping that
references anything else (`MAPPING_UNKNOWN_STATE`). The `name` is display
only and may differ from the `id` freely.

Each state in a lifecycle has these properties:

| Property      | Type                    | Description                                                                                                                                                                                                                                                                                                  |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | `string`                | **The state's identity** — unique within the definition, stored and matched by the engine (e.g., `"Draft"`, `"InReview"`)                                                                                                                                                                                    |
| `name`        | `string`                | Display name, never load-bearing (e.g., `"In Review"`)                                                                                                                                                                                                                                                       |
| `color`       | `string`                | Visual indicator color (e.g., `"gray"`, `"green"`, `"red"`)                                                                                                                                                                                                                                                  |
| `description` | `string`                | Human-readable description of this state                                                                                                                                                                                                                                                                     |
| `isInitial`   | `boolean`               | Whether this is the starting state (exactly one per definition)                                                                                                                                                                                                                                              |
| `isFinal`     | `boolean`               | Whether this is a terminal state (zero or more per definition)                                                                                                                                                                                                                                               |
| `finalKind`   | `'release' \| 'cancel'` | **Required on final states of Driving lifecycles.** Declares what completing the workflow here means: `release` merges ECO branches and assigns revisions; `cancel` archives branches without merging. The engine fails closed if it is missing — release-vs-cancel is never inferred from the state's name. |
| `phaseId`     | `string`                | Optional lifecycle phase assignment                                                                                                                                                                                                                                                                          |
| `position`    | `{x, y}`                | Position for visual layout in the workflow editor                                                                                                                                                                                                                                                            |

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

| Property              | Type                 | Description                                    |
| --------------------- | -------------------- | ---------------------------------------------- |
| `id`                  | `string`             | Unique identifier                              |
| `name`                | `string`             | Display name (e.g., `"Submit for Review"`)     |
| `fromStateId`         | `string`             | Source state ID                                |
| `toStateId`           | `string`             | Target state ID                                |
| `guards`              | `TransitionGuard[]`  | Conditions that must pass                      |
| `actions`             | `TransitionAction[]` | Side effects to execute                        |
| `approvalRequirement` | `{ requiredCount }`  | Minimum distinct approvals at the source state |

Approvals gate a transition two ways, and both must pass:

- **Named state approvers** — the users or roles configured on the source state
  (see Approval System below). Every _required_ approver needs an active
  approved vote.
- **`approvalRequirement.requiredCount`** — a minimum number of distinct active
  approved votes at the source state, from anyone. Set it in the lifecycle
  editor's transition panel ("Required approvals"). `0` (the default) means
  named approvers alone decide; with no named approvers either, anyone holding
  the permission may transition.

The formerly-stored `allowedRoles` field was removed in remediation WI-4.3 and
has not returned — role gating is a `user_role` guard. `requiredCount` was
removed at the same time and restored afterwards: it had only ever been
enforced on flexible instance transitions, which left "require two approvals"
unanswerable for the fixed ECO workflow most change orders use.

### Initial and Final States

- Every definition must have exactly **one** initial state. New items start here — `ItemService.create` resolves it from the flag; there is no literal default anywhere.
- Final states are optional but recommended. When a workflow instance reaches a final state, the instance is marked as completed (`completedAt` is set). Completed instances are terminal — they cannot be transitioned again.
- `isInitial` and `isFinal` are **not** mutually exclusive. The degenerate Free lifecycle — one state carrying both flags, zero transitions (e.g. `Current`) — is the right default for an item type with no meaningful flow, and the reachability rules (non-initial states need an incoming transition, non-final states an outgoing one) are satisfiable by a zero-transition machine only in that configuration.
- `finalKind` says what finishing in a final state means. On Driving lifecycles every final state must declare `release` or `cancel`; definitions and flexible-instance edits are rejected without it, and a transition into a final state that somehow lacks it fails closed. On Free lifecycles a final may declare `complete` or `cancel`: work orders gate their traveler on transitions into a `complete` final and stamp `completedAt`, cancel-kind finals abort ungated, and a final declaring neither simply ends the flow.
- For change-order workflows, transitioning into a final state runs the release orchestration in `ChangeOrderService.executeWorkflowTransition()` — the single entry point shared by the API route, the AI tools, and `submit`/`approve`/`reject`:
  1. An exclusive **release claim** is taken on the instance (compare-and-swap). While held, all other transitions are blocked, so a release cannot double-fire. The claim is not a lock but a lease of `WorkflowService.RELEASE_CLAIM_TIMEOUT_MS` (15 minutes): a claim older than that is treated as abandoned and can be taken over by the next caller's own compare-and-swap. That is what keeps a process that dies mid-merge from stranding the ECO forever — but the timeout has no way to tell a dead claimant from one that is just slow, so a release still running past 15 minutes can lose its claim to a second caller. The refusal error ("A release of this workflow is already in progress...") names the expiry so an operator hitting it does not have to read source to learn the block is temporary.
  2. The release (`close()` → merge, assign revisions) or cancellation (archive branches) runs **before** any workflow state is written.
  3. Only if that work succeeds does the workflow actually enter the final state, in a compare-and-swap write that also clears the claim.

  If the merge fails, the claim is released and the ECO remains in its pre-final state with the error surfaced — retrying the same transition after fixing the problem just works. The workflow can never be "Approved" without the merge having happened.

### Manual Transitions

Items transition through a dedicated endpoint — the only sanctioned write path for manual state changes. Free-lifecycle items (Issues, Tools, ...) use it for every edge; Driven-lifecycle items use it for the pre-release edges their lifecycle declares (the default Requirement lifecycle's Draft → Proposed → Approved review progress, with Rejected and Rework edges), never to enter or leave released lineage:

```
GET  /api/v1/items/:id/transitions   # transitions valid from the current state
POST /api/v1/items/:id/transition    # { toState, comments? } — id or display name
```

Handled by `LifecycleService.transitionFreeItem()`:

- **Lazy workflow instance.** The item gets a workflow instance on its first transition, so history, guards, approvals, and the hardened transition engine all apply. If the item's stored state predates the endpoint and diverges from the fresh instance, the instance **adopts** it first (recorded in history as `state_adopted`).
- **Released lineage is refused in both directions** with a clear error — a Driven item enters its release targets only at change-order release, and once it is released lineage nothing moves it by hand (revise it through a change order). A Driven lifecycle that declares no transitions (the default Part/Document lifecycles) therefore offers nothing here. Change orders are refused too (they have their own workflow endpoint).
- **Type-specific completion semantics ride this path, not the caller's.** A work order entering a `finalKind: 'complete'` state is gated on its traveler (every non-skipped line complete or explicitly skipped) and has `completedAt` stamped on the way in — here, so `PUT /api/v1/work-orders/:id/status`, this endpoint and the `transition_item_state` tool all give the same answer. Both halves used to live in `WorkOrderService.updateStatus`, where the other two doors walked past them into a Complete order with an open traveler that no route could repair.
- **Reopening is allowed.** Completed-instance terminality applies to Driving lifecycles only; a Free lifecycle that defines a transition out of a final state (Closed → Open) can reopen, clearing the workflow instance's own `completedAt` (a distinct column from the work order's, above).

The Issue detail page's transition buttons and the AI `transition_item_state` tool both go through this path.

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

**Every item type must have a lifecycle.** "No lifecycle" was once the reason for every literal fallback in the services (`?? 'Released'`, `|| 'Draft'`, a per-type `defaultState`); all of those are gone, and `ConfigService` refuses to save a registered type's config without a lifecycle or to delete one that carries it. `LifecycleService.getInitialStateId` throws on a type with none — a configuration error, not a runtime state.

### Default Lifecycle Assignments

The shipped defaults live in `packages/core/src/lib/items/default-lifecycles.ts` as data, seeded by `scripts/seed-minimal.ts`, by the test global-setup (once per run) and by the test fixtures, with version-gated upgrade-only upserts: a default that changes shape bumps its `version`, and an existing row is replaced only when its stored version is lower — so admin edits (which bump the version through `WorkflowService`) and suite overrides are left alone. `scripts/seed-minimal.ts` writes no lifecycle of its own: it calls the module and then sets the shipped Driven lifecycles' `drivers` allow-list to the two change-order workflows, only where nothing has chosen yet. The module also ships each state's editor position and the descriptions the lifecycle editor shows, so a fresh database opens every default laid out.

| Item Type       | Lifecycle                            | Type    | Lifecycle ID                    |
| --------------- | ------------------------------------ | ------- | ------------------------------- |
| Part            | Part - Default Lifecycle             | Driven  | `LIFECYCLE_IDS.part`            |
| Document        | Document - Default Lifecycle         | Driven  | `LIFECYCLE_IDS.document`        |
| Requirement     | Requirement - Default Lifecycle      | Driven  | `LIFECYCLE_IDS.requirement`     |
| Software        | Part - Default Lifecycle (shared)    | Driven  | `LIFECYCLE_IDS.part`            |
| ChangeOrder     | ECO - Default Workflow               | Driving | `LIFECYCLE_IDS.changeOrder`     |
| Issue           | Issue - Default Lifecycle            | Free    | `LIFECYCLE_IDS.issue`           |
| Task            | Task - Default Lifecycle             | Free    | `LIFECYCLE_IDS.task`            |
| TestPlan        | Test Plan - Default Lifecycle        | Free    | `LIFECYCLE_IDS.testPlan`        |
| TestCase        | Test Case - Default Lifecycle        | Free    | `LIFECYCLE_IDS.testCase`        |
| WorkInstruction | Work Instruction - Default Lifecycle | Free    | `LIFECYCLE_IDS.workInstruction` |
| Tool            | Tool - Default Lifecycle             | Free    | `LIFECYCLE_IDS.tool`            |
| PhysicalPart    | Physical Part - Default Lifecycle    | Free    | `LIFECYCLE_IDS.physicalPart`    |
| WorkOrder       | Work Order - Default Lifecycle       | Free    | `LIFECYCLE_IDS.workOrder`       |

The `LIFECYCLE_IDS` constants are defined in `packages/core/src/lib/items/lifecycle-ids.ts` as well-known UUIDs to ensure consistent linkage between seed scripts and code.

### Deriving from flags and mappings

Nothing in the services compares a state to a name. The questions code asks, and where they are answered:

| Question                                           | `LifecycleService`                                               | Derived from                                             |
| -------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| Where does a new item start?                       | `getInitialStateId(type)`                                        | `isInitial` (a ChangeOrder reads its Driving definition) |
| Is this state immutable released lineage?          | `isReleasedFamilyState(type, state)` / `getReleasedFamilyStates` | release target, revise new/old states, obsolete target   |
| Which states does a release stamp on new versions? | `getReleaseTargetStates(type)`                                   | `release.toState`, `revise.newVersionState`              |
| Has the flow ended, and what does that mean?       | `getFinalStateIds(type)` / `getFinalKind(type, state)`           | `isFinal`, `finalKind`                                   |
| Which action does this item's state imply?         | `ChangeOrderService.inferChangeAction(type, state)`              | the revise/release mappings' `fromState`                 |
| Everything a release needs for one type            | `resolveActionStates(type)`                                      | the mappings; `null` means the action is not defined     |
| Is this type outside ECO control?                  | `isBranchProtectionExempt(type)`                                 | `lifecycleType !== 'Driven'`                             |

`resolveActionStates` fields are nullable: a Free lifecycle defines no release actions, so its items merge without a lifecycle stamp, never count as released, and never protect main. The released family is closed by construction — when a lifecycle names no superseded state the merge leaves prior versions in their own state — so nothing the machinery writes falls outside it.

On the client, `/api/v1/lifecycles/by-item-type/:type` serves the governing definition (states with names, colours and flags; transitions; mappings), resolving Driving-governed types too. `StateBadge` / `useLifecycleState` render a state by its configured name and colour; `FreeTransitionControl` offers the transitions the lifecycle allows from the current state (finalKind-aware styling); `LifecycleStateCards` draws a list page's summary cards, one per state; `useReleasedFamily` is the presentation twin of `isReleasedFamilyState`; `lifecycleByItemTypeQuery` is the loader-safe query behind them. The Kanban board's columns are the Task lifecycle's states, and dragging between them is a lifecycle transition.

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

| Scheme             | Format                  | Example Sequence | Use Case                        |
| ------------------ | ----------------------- | ---------------- | ------------------------------- |
| `alpha`            | A, B, C, ..., Z, AA, AB | A -> B -> C      | Traditional PLM (default)       |
| `numeric`          | 1, 2, 3, ...            | 1 -> 2 -> 3      | Prototype/pre-production        |
| `prefixed-numeric` | X1, X2, X3, ...         | X1 -> X2 -> X3   | Prototype revisions with prefix |
| `none`             | Fixed marker `N/A`      | N/A -> N/A       | Items without revision tracking |

### `none` is a released revision, not the absence of one

A released item still carries a revision under `none` -- the fixed marker
`N/A` (`NO_REVISION_MARKER` in `lib/types/lifecycle.ts`, re-exported as
`RevisionService.NO_REVISION`). It simply never advances.

The marker has to be non-empty. `''` is a working marker to both
`RevisionService.isWorkingRevision` and its SQL counterpart
`notWorkingRevision()`, so an item released at `''` is filtered out of every
released-item query -- released in name and unreleased to `VersionResolver`
and to design baselines alike. Its shape is pinned by the database:
`items.revision` is `varchar(10)` and `ck_items_revision_working_marker`
rejects anything starting with `-` that is not `-` or `-{8 hex}`.

**`none` is only valid where releasing does not create a new version.** A
Driven lifecycle mints a new `items` row per release, and
`(item_number, revision, design_id, item_type)` is unique across rows -- so a
revision that never changes makes the second release of any item a unique
violation inside the merge transaction. `WorkflowService.validateDefinition`
therefore rejects a lifecycle-level `none` on a Driven definition
(`NONE_SCHEME_ON_DRIVEN`). Free lifecycles and phase-level `promote`
overrides update the item in place and are unaffected.

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
  // (Rows written before the unified lifecycle model may still carry a
  // legacy definitionType key; only normalize.ts reads it. Nothing writes
  // it anymore.)
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

(An `approval_count` guard type used to exist; it was removed in remediation
WI-4.3 because it was dead three independent ways. Approval gating is state
approvers plus the transition's `requiredCount`.)

### Guard Presets

The `GuardPresets` utility provides factory functions for common guard patterns:

```typescript
import { GuardPresets } from '@/lib/workflows'

GuardPresets.requiredField('reasonForChange') // Field must not be empty
GuardPresets.fieldEquals('priority', 'High') // Field must equal value
GuardPresets.hasRole(['Engineer', 'Manager']) // User must have role
```

### Action Types

Actions execute side effects during a transition:

| Type                | Execute On   | Description                                                                                                                                                                     |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update_field`      | before/after | Update an allowlisted field on the item (`name` only — lifecycle-controlled and type-specific columns are not writable from configuration; enforced at save and execution time) |
| `send_notification` | before/after | Send notification to users or roles                                                                                                                                             |

(A `create_task` action type used to be offered; it only ever threw
`NotImplementedError` and was removed in remediation WI-4.3. Saving a
definition with an unknown guard or action type is rejected.)

Actions are side effects of the workflow itself (notifications, item renames). They never write affected-item state: ECO-driven state change happens exclusively through `changeActionMappings` at release, applied by the merge. (The former `transition_driven_item` action type and `lifecycleEffects` were removed in remediation Phase 3.)

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

### Instance-Level Approvals (WI-4.2)

Custom states added on a flexible instance carry real, enforced approvals:

- **Instance approvers** live in `workflow_instance_approvers`, managed via
  `GET/PUT /api/v1/change-orders/:id/workflow/states/:stateId/approvers`
  (editable while the workflow is flexible and not completed — the same gate
  as structure edits). Gating uses the union of definition-level and
  instance-level approvers.
- **Per-transition minimum count**: instance transitions carry
  `approvalRequirement: { requiredCount: n }`, exactly as definition-level
  transitions do — the transition is blocked until `n` distinct users have an
  active approved vote at the source state. With no named approvers, anyone may
  vote (once). Both gates compose.

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
  supersededAt          TIMESTAMP   Set when a rework transition invalidated this vote

workflow_instance_approvers
  id                    UUID
  workflowInstanceId    UUID        FK to workflow_instances
  stateId               VARCHAR     State on the instance's effective structure
  approverType          VARCHAR     "user" or "role"
  approverId            UUID        FK to users.id or roles.id
  isRequired            BOOLEAN     Required approvers gate transitions
  createdAt             TIMESTAMP
  createdBy             UUID        FK to users
```

### Approval Flow

1. Approvers are configured on workflow definition states (Admin UI), and — for
   flexible workflows — on the instance's own states, including custom ones
   (`PUT /api/v1/change-orders/:id/workflow/states/:stateId/approvers`).
2. Gating always reads the **union** of definition-level and instance-level
   approvers; duplicate entries collapse, with required winning.
3. When a workflow instance enters a state with approvers, they can submit votes.
4. The system checks `WorkflowApprovalService.canUserApprove()` before accepting votes.
5. When all required approvers have approved, `areApprovalsComplete()` returns `met: true`.
6. Transitions check approval status as part of guard evaluation. Instance-level
   transitions additionally enforce their own `approvalRequirement.requiredCount`
   — a minimum number of distinct active approved votes at the source state,
   from anyone; it composes with named approvers.

### Approval Status Checking

```typescript
// Check if approvals are complete for a state
const status = await WorkflowApprovalService.areApprovalsComplete(
  instanceId,
  stateId,
)
// Returns: { met, required, current, pending: [...], totalApproved }
// totalApproved = distinct users with an active approved vote (feeds the
// instance-transition requiredCount gate)
```

### Voting Rules

- A user can only vote once per state per instance — counting **active** votes;
  a superseded vote means they may, and must, vote again.
- If no approvers are defined for a state, anyone can approve (once). This is
  how the `requiredCount`-only gate collects votes.
- When a workflow transitions **backward** (the target state can reach the
  source again), all active votes on the re-traversable segment are
  **superseded** (`supersededAt` set) — the second pass requires fresh
  approvals. Votes are never deleted: the [Advanced
  Auditing](./advanced-auditing.md) trail must show they existed and were
  superseded.
- Users can approve as themselves (direct approver) or on behalf of a role they hold.

### Digital Signatures (Advanced Auditing package)

On instances licensed for the [Advanced Auditing](./advanced-auditing.md)
package, **every approval vote must be digitally signed**. The requirement is
enforced inside `WorkflowApprovalService.submitApproval()` — the single path all
approval routes take — so there is no unsigned route to an approval, and the
vote and its signature are written in one transaction.

What changes when the package is enabled:

| Behavior          | Without the package         | With the package                                                                         |
| ----------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| Submitting a vote | Session authentication only | Requires a CAC/PIV certificate on the connection, or account password re-authentication  |
| Vote record       | `workflow_approval_votes`   | Same, plus a `digital_signatures` row hash-chained to the previous signature             |
| Approval history  | Votes and comments          | Plus a signature manifest: printed name, meaning, credential, certificate evidence, time |

Approval endpoints accept two extra body fields in this mode — `password` (only
on the password path) and an optional `signatureMeaning` override. The signature
snapshot binds to the item as it stood at signing time, so an auditor sees the
number, revision, and state the signer actually saw.

Unlicensed instances are unaffected: `submitApproval()` writes the vote exactly
as documented above.

---

## Comments on Transitions

Every transition supports an optional `comments` field. When a user triggers a transition, they can provide a comment that is stored in the `workflow_history` record.

### Usage

```typescript
// Via the API
POST /api/v1/change-orders/:id/workflow/transition
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

### Requirement - Default Lifecycle (Driven)

Driven like Part, with review progress as pre-release states reached by manual transition: Draft → Proposed → Approved (Reject to Rejected, Rework back to Draft). Release maps Approved → Released; revise and obsolete are as for Part. Requirements are versioned items that live on Designs, are checked out to ECO branches, and receive revision letters at merge.

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

| Transition        | From             | To        |
| ----------------- | ---------------- | --------- |
| Submit for Review | Draft            | InReview  |
| Approve           | InReview         | Approved  |
| Return to Draft   | InReview         | Draft     |
| Cancel            | Draft / InReview | Cancelled |

Cancelled is a final state with `finalKind: 'cancel'`: branches are archived unmerged and no revisions are consumed. Return to Draft reopens the change order's scope.

When "Approve" is executed, "Approved" is a final state with `finalKind: 'release'`, so the release orchestration runs: the merge processes the ECO (branch merge or affected-items implementation), applying each item's `changeActionMappings` (Draft → Released) and assigning revision letters — and only then does the workflow actually enter Approved.

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

Users can add intermediate states (e.g., "Engineering Review", "Quality Review") and transitions on each instance. "Complete" is a final state with `finalKind: 'release'`, so completing it runs the same merge-driven release as the default ECO workflow.

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

| Method   | Endpoint                         | Description                                                                  |
| -------- | -------------------------------- | ---------------------------------------------------------------------------- |
| `GET`    | `/api/v1/workflows`              | List all definitions (supports `?isActive=true&type=lifecycle`)              |
| `POST`   | `/api/v1/workflows`              | Create a new definition                                                      |
| `GET`    | `/api/v1/workflows/:id`          | Get a definition by ID                                                       |
| `PUT`    | `/api/v1/workflows/:id`          | Update a definition                                                          |
| `DELETE` | `/api/v1/workflows/:id`          | Delete a definition (blocked if active instances or item types reference it) |
| `POST`   | `/api/v1/workflows/:id/validate` | Validate a definition's structure                                            |

### Workflow Approvers

| Method   | Endpoint                                                      | Description                              |
| -------- | ------------------------------------------------------------- | ---------------------------------------- |
| `GET`    | `/api/v1/workflows/:id/approvers`                             | Get all state approvers for a definition |
| `GET`    | `/api/v1/workflows/:id/states/:stateId/approvers`             | Get approvers for a specific state       |
| `PUT`    | `/api/v1/workflows/:id/states/:stateId/approvers`             | Replace all approvers for a state        |
| `POST`   | `/api/v1/workflows/:id/states/:stateId/approvers`             | Add a single approver                    |
| `PATCH`  | `/api/v1/workflows/:id/states/:stateId/approvers/:approverId` | Update approver required status          |
| `DELETE` | `/api/v1/workflows/:id/states/:stateId/approvers/:approverId` | Remove an approver                       |

### Change Order Workflow

| Method | Endpoint                                                 | Description                              |
| ------ | -------------------------------------------------------- | ---------------------------------------- |
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
