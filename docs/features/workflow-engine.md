# Lifecycle Engine

Cascadia's lifecycle engine provides configurable state machines that govern how items move through their states and how change orders progress through review and release. Every definition is a lifecycle; the engine is built around a unified model with three kinds: **Free**, **Driven**, and **Driving**.

### Coming from Aras or Windchill

In most PLM products a **lifecycle** is the set of states an object occupies and a **workflow** is a routed process — a separate object with activities, assignments and a runtime of its own. Cascadia unified them. One definition names the states, the transitions between them, the guards and approvals on each transition, and the change actions a release applies; what other systems call a workflow is a lifecycle definition of the Driving kind, stored beside every other lifecycle and served under `/api/v1/lifecycles`. A change order runs an **instance** of one, and instance, **transition** and **approval** are the only runtime nouns. The table names (`workflow_definitions`, `workflow_instances`), the `workflowType` property and the `/api/v1/workflows` alias keep their older spelling because the v1 API is frozen; they mean lifecycle definitions and their instances.

## Table of Contents

- [Coming from Aras or Windchill](#coming-from-aras-or-windchill)
- [Overview](#overview)
- [Unified Lifecycle Model](#unified-lifecycle-model)
- [Lifecycle Management](#lifecycle-management)
- [Per-Item-Type Lifecycles](#per-item-type-lifecycles)
- [Lifecycle Phases](#lifecycle-phases)
- [Revision Schemes](#revision-schemes)
- [Per-Phase Revision Reset](#per-phase-revision-reset)
- [Lifecycle Definitions](#lifecycle-definitions)
- [Lifecycle Instances](#lifecycle-instances)
- [Transition History](#transition-history)
- [Approval Voting](#approval-voting)
- [Comments on Transitions](#comments-on-transitions)
- [Starting a Change Order's Lifecycle](#starting-a-change-orders-lifecycle)
- [Shipped Lifecycles](#shipped-lifecycles)
- [API Reference](#api-reference)

---

## Overview

The engine serves two complementary purposes with one kind of definition:

1. **Item lifecycles** (Driven and Free) define the states an item can occupy and how change actions move items between them (e.g., Draft, Released, Superseded, Obsolete).

2. **Change-order lifecycles** (Driving) define the review and release process a change order follows, with transitions, guards, actions, and approvals (e.g., Draft -> In Review -> Approved).

All of them are lifecycle definitions in the `workflow_definitions` table, with the same structure of states and transitions. The difference is behavioural: Driven and Free lifecycles declare states that items occupy, while a Driving lifecycle actively drives a change order through review and, on release, applies the Driven lifecycles' change actions.

### Key Principles

- **No state name appears in application logic.** A state has exactly three machine-readable properties — `isInitial`, `isFinal` (+ `finalKind`), and the roles it plays in change-action mappings (`release`/`revise`/`obsolete`/`promote`). Everything else about a state, including its name, belongs to whoever configures the lifecycle. Services derive "is this released lineage", "is this the initial state", "has the flow ended" from those flags and mappings through `LifecycleService` (see [Deriving from flags and mappings](#deriving-from-flags-and-mappings)); the UI renders names and colours from the lifecycle definition (`StateBadge`). The shipped defaults in `cascadia-api/src/lib/items/default-lifecycles.ts` are configuration, not logic.
- **Item state changes are lifecycle-enforced by the server.** Released lineage (the states the release mappings produce) is entered and left only through change-order release. Everything else moves through `POST /api/v1/items/:id/transition`, validated against the lifecycle's declared transitions: all of a Free lifecycle's edges, and a Driven lifecycle's declared pre-release edges (review progress such as Draft → Proposed → Approved on the default Requirement lifecycle). The generic item-update API rejects attempts to change `state`, `revision`, or `isCurrent` outright.
- **Lifecycle definitions are JSON-based.** States, transitions, guards, and actions are stored as JSONB in PostgreSQL. No code changes are required to create new lifecycles.
- **Guard evaluation is pluggable.** Two guard types are supported out of the box: `field_value` and `user_role`. (Approval gating is not a guard — the transition path enforces it directly, from state approvers and the transition's `requiredCount`.)
- **Flexible definitions** allow per-instance customization of states and transitions. The definition serves as a template that users can modify on each change order.

### Architecture

```
cascadia-api/src/lib/lifecycles/
  LifecycleDefinitionService.ts  # Definition CRUD and validation
  LifecycleInstanceService.ts    # Instances, transitions, claims, history
  ApprovalService.ts             # Approval voting and tracking
  GuardEvaluator.ts           # Guard condition evaluation
  types.ts                    # TypeScript interfaces
  index.ts                    # Public exports

cascadia-api/src/lib/services/
  LifecycleService.ts         # Lifecycle-specific operations (phases, revisions)

cascadia-commons/src/lib/types/
  lifecycle.ts                # Revision schemes, phases, change action mappings
```

---

## Unified Lifecycle Model

Every lifecycle definition has a `lifecycleType` that determines its behavior:

| Lifecycle Type | Behavior                                                                                                                                      | Examples                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Free**       | Self-controlled with manual transitions. Users can transition states directly without a change order.                                         | Issues, Tasks, Work Instructions                     |
| **Driven**     | change-order-controlled. Declares valid states plus `changeActionMappings` that the merge applies at change-order release.                    | Parts, Documents, Requirements                       |
| **Driving**    | A change order's own review and release process. Completing one with a release runs the merge, which applies the Driven lifecycles' mappings. | Change Order - Standard, XCO - Flexible Change Order |

### Relationship Between Types

```
  Driving (change order)                    Driven (Part Lifecycle)
  ========================                  ========================
  Draft ──> In Review ──> Approved          Draft ──> Released ──> Superseded
                           │                            ^
                           │                            |
                           └── release merge applies ───┘
                               changeActionMappings
                               (release: Draft → Released)
```

When a change order completes in a `finalKind: 'release'` state, the merge applies each affected item's change action through its Driven lifecycle's `changeActionMappings` (release: Draft → Released, revise: old → Superseded / new → Released, obsolete: Released → Obsolete) and assigns revision letters. This is the **single mechanism** for change-order-driven state change — there are no per-transition item actions.

### Drivers Configuration

Driven lifecycles have a `drivers` array that lists which Driving lifecycle IDs are permitted to act on them. This allows different change types to control different item types:

```typescript
// Part lifecycle allows both shipped change-order lifecycles
drivers: [LIFECYCLE_IDS.changeOrder, LIFECYCLE_IDS.flexibleChangeOrder]
```

If no drivers are configured, any Driving lifecycle can act (permissive default).

The allow-list is **enforced** (remediation WI-4.4):

- `ChangeOrderService.addAffectedItem` rejects state-changing actions from an
  unauthorized change order at scope entry.
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

| Property      | Type                    | Description                                                                                                                                                                                                                                                                                                            |
| ------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | `string`                | **The state's identity** — unique within the definition, stored and matched by the engine (e.g., `"Draft"`, `"InReview"`)                                                                                                                                                                                              |
| `name`        | `string`                | Display name, never load-bearing (e.g., `"In Review"`)                                                                                                                                                                                                                                                                 |
| `color`       | `string`                | Visual indicator color (e.g., `"gray"`, `"green"`, `"red"`)                                                                                                                                                                                                                                                            |
| `description` | `string`                | Human-readable description of this state                                                                                                                                                                                                                                                                               |
| `isInitial`   | `boolean`               | Whether this is the starting state (exactly one per definition)                                                                                                                                                                                                                                                        |
| `isFinal`     | `boolean`               | Whether this is a terminal state (zero or more per definition)                                                                                                                                                                                                                                                         |
| `finalKind`   | `'release' \| 'cancel'` | **Required on final states of Driving lifecycles.** Declares what completing the lifecycle here means: `release` merges change-order branches and assigns revisions; `cancel` archives branches without merging. The engine fails closed if it is missing — release-vs-cancel is never inferred from the state's name. |
| `phaseId`     | `string`                | Optional lifecycle phase assignment                                                                                                                                                                                                                                                                                    |
| `position`    | `{x, y}`                | Position for visual layout in the lifecycle editor                                                                                                                                                                                                                                                                     |

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
unanswerable for the fixed change-order lifecycle most change orders use.

### Initial and Final States

- Every definition must have exactly **one** initial state. New items start here — `ItemService.create` resolves it from the flag; there is no literal default anywhere.
- Final states are optional but recommended. When a lifecycle instance reaches a final state, the instance is marked as completed (`completedAt` is set). Completed instances are terminal — they cannot be transitioned again.
- `isInitial` and `isFinal` are **not** mutually exclusive. The degenerate Free lifecycle — one state carrying both flags, zero transitions (e.g. `Current`) — is the right default for an item type with no meaningful flow, and the reachability rules (non-initial states need an incoming transition, non-final states an outgoing one) are satisfiable by a zero-transition machine only in that configuration.
- `finalKind` says what finishing in a final state means. On Driving lifecycles every final state must declare `release` or `cancel`; definitions and flexible-instance edits are rejected without it, and a transition into a final state that somehow lacks it fails closed. On Free lifecycles a final may declare `complete` or `cancel`: work orders gate their traveler on transitions into a `complete` final and stamp `completedAt`, cancel-kind finals abort ungated, and a final declaring neither simply ends the flow.
- For change-order lifecycles, transitioning into a final state runs the release orchestration in `ChangeOrderService.executeWorkflowTransition()` — the single entry point shared by the API route and the AI tools:
  1. An exclusive **release claim** is taken on the instance (compare-and-swap). While held, all other transitions are blocked, so a release cannot double-fire. The claim is not a lock but a lease of `LifecycleInstanceService.RELEASE_CLAIM_TIMEOUT_MS` (15 minutes): a claim older than that is treated as abandoned and can be taken over by the next caller's own compare-and-swap. That is what keeps a process that dies mid-merge from stranding the change order forever — but the timeout has no way to tell a dead claimant from one that is just slow, so a release still running past 15 minutes can lose its claim to a second caller. The refusal error ("A release of this workflow is already in progress...") names the expiry so an operator hitting it does not have to read source to learn the block is temporary.
  2. The release (`close()` → merge, assign revisions) or cancellation (archive branches) runs **before** any lifecycle state is written.
  3. Only if that work succeeds does the instance actually enter the final state, in one transaction: the compare-and-swap write that also clears the claim, the votes it supersedes, the change order's own `state`, the history row, and the `submittedAt`/`approvedAt` milestones (`afterFinalize`). They commit together or not at all.

  If the merge fails, the claim is released and the change order remains in its pre-final state with the error surfaced — retrying the same transition after fixing the problem just works. The instance can never be "Approved" without the merge having happened.

  If the merge succeeds and the state write after it fails, the merge stays committed (it cannot be undone) and the change order is still pre-final; retrying the same transition completes it without releasing anything twice. `merge()` finds its own completion record (`implementedAt`, stamped inside the affected-item pass; `mergeStatus` per design) and skips straight to the state write, and the release gate ignores archived branches — before it did not, and the archived branch's base compared against the row the merge had promoted onto main read as a blocking concurrent modification of the release against itself.

### Manual Transitions

Items transition through a dedicated endpoint — the only sanctioned write path for manual state changes. Free-lifecycle items (Issues, Tools, ...) use it for every edge; Driven-lifecycle items use it for the pre-release edges their lifecycle declares (the default Requirement lifecycle's Draft → Proposed → Approved review progress, with Rejected and Rework edges), never to enter or leave released lineage:

```
GET  /api/v1/items/:id/transitions   # transitions valid from the current state
POST /api/v1/items/:id/transition    # { toState, comments? } — id or display name
```

Handled by `LifecycleInstanceService.transitionFreeItem()`:

- **Lazy lifecycle instance.** The item gets a lifecycle instance on its first transition, so history, guards, approvals, and the hardened transition engine all apply. If the item's stored state predates the endpoint and diverges from the fresh instance, the instance **adopts** it first (recorded in history as `state_adopted`).
- **Released lineage is refused in both directions** with a clear error — a Driven item enters its release targets only at change-order release, and once it is released lineage nothing moves it by hand (revise it through a change order). A Driven lifecycle that declares no transitions (the default Part/Document lifecycles) therefore offers nothing here. Change orders are refused too (they transition through their own instance endpoint).
- **Type-specific completion semantics ride this path, not the caller's.** A work order entering a `finalKind: 'complete'` state is gated on its traveler (every non-skipped line complete or explicitly skipped) and has `completedAt` stamped on the way in — here, so `PUT /api/v1/work-orders/:id/status`, this endpoint and the `transition_item_state` tool all give the same answer. Both halves used to live in `WorkOrderService.updateStatus`, where the other two doors walked past them into a Complete order with an open traveler that no route could repair.
- **Reopening is allowed.** Completed-instance terminality applies to Driving lifecycles only; a Free lifecycle that defines a transition out of a final state (Closed → Open) can reopen, clearing the lifecycle instance's own `completedAt` (a distinct column from the work order's, above).

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

The shipped defaults live in `cascadia-api/src/lib/items/default-lifecycles.ts` as data, seeded by `scripts/seed-minimal.ts`, by the test global-setup (once per run) and by the test fixtures, with version-gated upgrade-only upserts: a default that changes shape bumps its `version`, and an existing row is replaced only when its stored version is lower — so admin edits (which bump the version through `LifecycleDefinitionService`) and suite overrides are left alone. `scripts/seed-minimal.ts` writes no lifecycle of its own: it calls the module and then sets the shipped Driven lifecycles' `drivers` allow-list to the two shipped change-order lifecycles, only where nothing has chosen yet. The module also ships each state's editor position and the descriptions the lifecycle editor shows, so a fresh database opens every default laid out.

| Item Type       | Lifecycle                            | Type    | Lifecycle ID                    |
| --------------- | ------------------------------------ | ------- | ------------------------------- |
| Part            | Part - Default Lifecycle             | Driven  | `LIFECYCLE_IDS.part`            |
| Document        | Document - Default Lifecycle         | Driven  | `LIFECYCLE_IDS.document`        |
| Requirement     | Requirement - Default Lifecycle      | Driven  | `LIFECYCLE_IDS.requirement`     |
| Software        | Part - Default Lifecycle (shared)    | Driven  | `LIFECYCLE_IDS.part`            |
| ChangeOrder     | Change Order - Standard              | Driving | `LIFECYCLE_IDS.changeOrder`     |
| Issue           | Issue - Default Lifecycle            | Free    | `LIFECYCLE_IDS.issue`           |
| Task            | Task - Default Lifecycle             | Free    | `LIFECYCLE_IDS.task`            |
| TestPlan        | Test Plan - Default Lifecycle        | Free    | `LIFECYCLE_IDS.testPlan`        |
| TestCase        | Test Case - Default Lifecycle        | Free    | `LIFECYCLE_IDS.testCase`        |
| WorkInstruction | Work Instruction - Default Lifecycle | Free    | `LIFECYCLE_IDS.workInstruction` |
| Tool            | Tool - Default Lifecycle             | Free    | `LIFECYCLE_IDS.tool`            |
| PhysicalPart    | Physical Part - Default Lifecycle    | Free    | `LIFECYCLE_IDS.physicalPart`    |
| WorkOrder       | Work Order - Default Lifecycle       | Free    | `LIFECYCLE_IDS.workOrder`       |

The `LIFECYCLE_IDS` constants are defined in `cascadia-commons/src/lib/items/lifecycle-ids.ts` as well-known UUIDs to ensure consistent linkage between seed scripts and code.

### Deriving from flags and mappings

Nothing in the services compares a state to a name. The questions code asks, and where they are answered:

| Question                                           | `LifecycleService`                                               | Derived from                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Where does a new item start?                       | `getInitialStateId(type)`                                        | `isInitial` (a ChangeOrder reads its Driving definition)                  |
| Is this state immutable released lineage?          | `isReleasedFamilyState(type, state)` / `getReleasedFamilyStates` | release target, revise new/old states, obsolete target                    |
| Which states does a release stamp on new versions? | `getReleaseTargetStates(type)`                                   | `release.toState`, `revise.newVersionState`                               |
| Has the flow ended, and what does that mean?       | `getFinalStateIds(type)` / `getFinalKind(type, state)`           | `isFinal`, `finalKind`                                                    |
| Which action does this item's state imply?         | `ChangeOrderService.inferChangeAction(type, state)`              | the revise/release mappings' `fromState`                                  |
| Everything a release needs for one type            | `resolveActionStates(type)`                                      | the mappings; `null` means the action is not defined                      |
| Is this type outside change-order control?         | `isBranchProtectionExempt(type)`                                 | `lifecycleType` is `Free` or `Driving`; an unresolvable kind is protected |

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
violation inside the merge transaction. `LifecycleDefinitionService.validateDefinition`
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

## Lifecycle Definitions

Lifecycle definitions are JSON objects stored in the `workflow_definitions` table.

### Database Schema

```
workflow_definitions
  id                  UUID        Primary key
  name                VARCHAR     Unique name (e.g., "Change Order - Standard")
  version             INTEGER     Definition version number
  workflowType        VARCHAR     "strict" or "flexible"
  definition          JSONB       Full definition including states, transitions, etc.
  isActive            BOOLEAN     Whether this definition is available for use
  lifecycleType       ENUM        "Free", "Driven", or "Driving"
  drivers             JSONB       Array of Driving lifecycle IDs (for Driven lifecycles)
  createdAt           TIMESTAMP   Creation timestamp
```

### Definition JSONB Structure

The `definition` column stores the complete lifecycle configuration:

```typescript
{
  // The kind (lifecycleType) and the structure (workflowType) are columns,
  // not JSONB keys: migration 0006 removed the JSONB copy of the kind.
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

### Strict vs Flexible Definitions

| Property           | Strict                         | Flexible                                    |
| ------------------ | ------------------------------ | ------------------------------------------- |
| States/transitions | Fixed from definition          | Copied to instance, modifiable per-instance |
| Guard evaluation   | Full guards                    | Approval requirements only                  |
| Actions            | Before/after actions supported | Not supported                               |
| Use case           | Standard change-order review   | Ad-hoc change orders with custom routing    |

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
import { GuardPresets } from '@/lib/lifecycles'

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

Actions are side effects of the transition itself (notifications, item renames). They never write affected-item state: change-order-driven state change happens exclusively through `changeActionMappings` at release, applied by the merge. (The former `transition_driven_item` action type and `lifecycleEffects` were removed in remediation Phase 3.)

---

## Lifecycle Instances

When a lifecycle instance is started for an item, a `workflow_instances` row is created to track runtime state.

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
  │  startInstance()                 │
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
  │  - Change orders: close() runs   │
  │    to merge branches and assign  │
  │    revisions                     │
  └──────────────────────────────────┘
```

### Scope Locking

For Driving lifecycles (change-order lifecycles), the scope is locked when the instance leaves its initial state for the first time. Once locked:

- No more affected items can be added to the change order.
- This prevents scope creep during the review/approval process.
- The lock is indicated by `scopeLocked = true` and a `scopeLockedAt` timestamp.

### Flexible Lifecycle Instance Editing

For flexible definitions (`workflowType: 'flexible'`), the definition's states and transitions are copied to the instance at creation time. Users can then modify the instance structure:

```typescript
// Update instance structure
LifecycleInstanceService.updateInstanceStructure(
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
- Cannot modify a completed instance.

### Instance-Level Approvals (WI-4.2)

Custom states added on a flexible instance carry real, enforced approvals:

- **Instance approvers** live in `workflow_instance_approvers`, managed via
  `GET/PUT /api/v1/change-orders/:id/workflow/states/:stateId/approvers`
  (editable while the instance is flexible and not completed — the same gate
  as structure edits). Gating uses the union of definition-level and
  instance-level approvers.
- **Per-transition minimum count**: instance transitions carry
  `approvalRequirement: { requiredCount: n }`, exactly as definition-level
  transitions do — the transition is blocked until `n` distinct users have an
  active approved vote at the source state. With no named approvers, anyone may
  vote (once). Both gates compose.

### Effective Structure Resolution

`LifecycleInstanceService.getEffectiveStructure()` resolves the actual states and transitions for an instance:

- **Strict definitions**: Returns the definition's states and transitions.
- **Flexible definitions with overrides**: Returns the instance-level states and transitions.
- **Flexible definitions without overrides**: Returns the definition's states and transitions.

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
| `started`                     | Initial entry when lifecycle instance is created      |
| (transition name)             | Normal state transition (e.g., `"Submit for Review"`) |
| `workflow_structure_modified` | The flexible instance's structure was updated         |

### Querying History

```typescript
const history = await LifecycleInstanceService.getHistory(instanceId)
// Returns LifecycleHistoryEntry[] ordered by timestamp descending
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

Approvers are assigned to lifecycle states via the `workflow_state_approvers` table. Each approver can be a **user** or a **role**:

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

Actual votes are tracked per lifecycle instance in the `workflow_approval_votes` table:

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

1. Approvers are configured on lifecycle definition states (Admin UI), and — for
   flexible definitions — on the instance's own states, including custom ones
   (`PUT /api/v1/change-orders/:id/workflow/states/:stateId/approvers`).
2. Gating always reads the **union** of definition-level and instance-level
   approvers; duplicate entries collapse, with required winning.
3. When a lifecycle instance enters a state with approvers, they can submit votes.
4. The system checks `ApprovalService.canUserApprove()` before accepting votes.
5. When all required approvers have approved, `areApprovalsComplete()` returns `met: true`.
6. Transitions check approval status as part of guard evaluation. Instance-level
   transitions additionally enforce their own `approvalRequirement.requiredCount`
   — a minimum number of distinct active approved votes at the source state,
   from anyone; it composes with named approvers.

### Approval Status Checking

```typescript
// Check if approvals are complete for a state
const status = await ApprovalService.areApprovalsComplete(instanceId, stateId)
// Returns: { met, required, current, pending: [...], totalApproved }
// totalApproved = distinct users with an active approved vote (feeds the
// instance-transition requiredCount gate)
```

### Voting Rules

- A user can only vote once per state per instance — counting **active** votes;
  a superseded vote means they may, and must, vote again.
- If no approvers are defined for a state, anyone can approve (once). This is
  how the `requiredCount`-only gate collects votes.
- When an instance transitions **backward** (the target state can reach the
  source again), all active votes on the re-traversable segment are
  **superseded** (`supersededAt` set) — the second pass requires fresh
  approvals. Votes are never deleted: the [Advanced
  Auditing](./advanced-auditing.md) trail must show they existed and were
  superseded.
- Users can approve as themselves (direct approver) or on behalf of a role they hold.

### Digital Signatures (Advanced Auditing package)

On instances licensed for the [Advanced Auditing](./advanced-auditing.md)
package, **every approval vote must be digitally signed**. The requirement is
enforced inside `ApprovalService.submitApproval()` — the single path all
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
await LifecycleInstanceService.transition(
  instanceId,
  'InReview',
  userId,
  'Ready for engineering review', // comments parameter
)
```

Comments appear in the transition history alongside the actor, timestamp, and from/to states.

---

## Starting a Change Order's Lifecycle

When a change order is created, creation starts an instance of the Driving lifecycle its change type maps to.

### Configuration

The `lifecyclesByChangeType` mapping in `RuntimeItemTypeConfig` determines which lifecycle definition to use for each change type:

```typescript
// In item_type_configs for ChangeOrder
{
  lifecyclesByChangeType: {
    ECO: "00000000-0000-4000-8000-000000000102",   // Change Order - Standard
    ECN: "00000000-0000-4000-8000-000000000102",   // Same default for ECN
    Deviation: "00000000-0000-4000-8000-000000000102",
    MCO: "00000000-0000-4000-8000-000000000102",
    XCO: "00000000-0000-4000-8000-000000000103",   // XCO - Flexible Change Order
  }
}
```

### What creation does

```typescript
// Called during change order creation
await ChangeOrderService.autoStartWorkflow(changeOrderId, changeType, userId)
```

1. Looks up `lifecyclesByChangeType[changeType]` from the runtime config.
2. Calls `ChangeOrderService.startWorkflow()`, which refuses anything but a Driving definition and then, in one transaction, calls `LifecycleInstanceService.startInstance()` and stamps the change order's own `state` from the instance's initial state.
3. The instance begins at its initial state, and the change order's `state` mirrors it from the first moment.

If no lifecycle is configured for the change type, creation fails with a validation error.

The stamp matters because the type's `lifecycleDefinitionId` names only one of the definitions `lifecyclesByChangeType` can start. `ItemService.create` stamps that definition's initial state, which is right for every change type mapped to it and wrong for any other (XCO runs the flexible definition): before the stamp, such a change order showed the strict definition's initial state while its instance sat at its own, and after one transition carried a state id the strict definition does not contain. Two resolvers keep rendering honest: `LifecycleService.getGoverningDefinitionForItem(item)` answers with the definition an item actually runs (the instance's own states for a flexible definition), and `getRenderableStates(type)` — what `/api/v1/lifecycles/by-item-type/:type` reports as `states` — is the union across every definition the type's change types map to, so a list mixing change types can name any state in it.

---

## Shipped Lifecycles

Cascadia ships with the following default lifecycle definitions.

### Part - Default Lifecycle (Driven)

A standard PLM lifecycle for parts. All state changes go through change orders.

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

**Drivers:** Change Order - Standard, XCO - Flexible Change Order

### Document - Default Lifecycle (Driven)

Identical structure to the Part lifecycle but assigned to Documents. Same states, same change action mappings.

### Requirement - Default Lifecycle (Driven)

Driven like Part, with review progress as pre-release states reached by manual transition: Draft → Proposed → Approved (Reject to Rejected, Rework back to Draft). Release maps Approved → Released; revise and obsolete are as for Part. Requirements are versioned items that live on Designs, are checked out to change-order branches, and receive revision letters at merge.

### Change Order - Standard (Driving, Strict)

A strict three-state review for change orders of every change type (ECO, ECN, MCO, Deviation).

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

When "Approve" is executed, "Approved" is a final state with `finalKind: 'release'`, so the release orchestration runs: the merge processes the change order (branch merge or affected-items implementation), applying each item's `changeActionMappings` (Draft → Released) and assigning revision letters — and only then does the instance actually enter Approved.

### XCO - Flexible Change Order (Driving, Flexible)

A minimal two-state template for ad-hoc change orders. Users customize the structure per instance.

```
  ┌───────┐     ┌──────────┐
  │ Start │────>│ Complete │
  │ (gray)│     │ (green)  │
  │[init] │     │ [final]  │
  └───────┘     └──────────┘
    Complete
```

Users can add intermediate states (e.g., "Engineering Review", "Quality Review") and transitions on each instance. "Complete" is a final state with `finalKind: 'release'`, so completing it runs the same merge-driven release as `Change Order - Standard`.

### Issue - Default Lifecycle (Free)

A self-controlled lifecycle for issue tracking. Users can transition states directly without change-order approval.

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

### Lifecycle Definitions

Canonical paths. Each is also mounted at `/api/v1/lifecycles`, the path it shipped under, as a deprecated alias; the response keys keep their v1 spelling (`workflows`, `workflow`). The list takes `?lifecycleType=Free|Driven|Driving` beside `?type=`.

| Method   | Endpoint                          | Description                                                                  |
| -------- | --------------------------------- | ---------------------------------------------------------------------------- |
| `GET`    | `/api/v1/lifecycles`              | List all definitions (supports `?isActive=true&type=lifecycle`)              |
| `POST`   | `/api/v1/lifecycles`              | Create a new definition                                                      |
| `GET`    | `/api/v1/lifecycles/:id`          | Get a definition by ID                                                       |
| `PUT`    | `/api/v1/lifecycles/:id`          | Update a definition                                                          |
| `DELETE` | `/api/v1/lifecycles/:id`          | Delete a definition (blocked if active instances or item types reference it) |
| `POST`   | `/api/v1/lifecycles/:id/validate` | Validate a definition's structure                                            |

### State Approvers

| Method   | Endpoint                                                       | Description                              |
| -------- | -------------------------------------------------------------- | ---------------------------------------- |
| `GET`    | `/api/v1/lifecycles/:id/approvers`                             | Get all state approvers for a definition |
| `GET`    | `/api/v1/lifecycles/:id/states/:stateId/approvers`             | Get approvers for a specific state       |
| `PUT`    | `/api/v1/lifecycles/:id/states/:stateId/approvers`             | Replace all approvers for a state        |
| `POST`   | `/api/v1/lifecycles/:id/states/:stateId/approvers`             | Add a single approver                    |
| `PATCH`  | `/api/v1/lifecycles/:id/states/:stateId/approvers/:approverId` | Update approver required status          |
| `DELETE` | `/api/v1/lifecycles/:id/states/:stateId/approvers/:approverId` | Remove an approver                       |

### Change Order Lifecycle Instance

| Method | Endpoint                                                 | Description                                     |
| ------ | -------------------------------------------------------- | ----------------------------------------------- |
| `GET`  | `/api/v1/change-orders/:id/workflow`                     | Get lifecycle instance for a change order       |
| `POST` | `/api/v1/change-orders/:id/workflow`                     | Start an instance (repair; creation starts one) |
| `GET`  | `/api/v1/change-orders/:id/workflow/transition`          | Get available transitions                       |
| `POST` | `/api/v1/change-orders/:id/workflow/transition`          | Execute a transition                            |
| `POST` | `/api/v1/change-orders/:id/workflow/validate-transition` | Validate a transition before executing          |

### Service Layer

```typescript
import {
  LifecycleDefinitionService,
  LifecycleInstanceService,
  ApprovalService,
  GuardEvaluator,
} from '@/lib/lifecycles'
import { LifecycleService } from '@/lib/services/LifecycleService'

// CRUD
const definition = await LifecycleDefinitionService.create(input)
const definition = await LifecycleDefinitionService.getById(id)
const definitions = await LifecycleDefinitionService.list({ isActive: true })
const updated = await LifecycleDefinitionService.update(id, changes)
await LifecycleDefinitionService.delete(id)

// Instances
const instance = await LifecycleInstanceService.startInstance(
  definitionId,
  itemId,
  context,
)
const instance = await LifecycleInstanceService.getInstanceByItemId(itemId)
const history = await LifecycleInstanceService.getHistory(instanceId)

// Transitions
const available = await LifecycleInstanceService.getAvailableTransitions(
  instanceId,
  guardContext,
)
const { allowed, reasons } = await LifecycleInstanceService.canTransition(
  instanceId,
  toStateId,
  context,
)
const result = await LifecycleInstanceService.transition(
  instanceId,
  toStateId,
  actorId,
  comments,
)

// Approvals
const status = await ApprovalService.areApprovalsComplete(instanceId, stateId)
const canApprove = await ApprovalService.canUserApprove(
  instanceId,
  stateId,
  userId,
)
const vote = await ApprovalService.submitApproval(
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
