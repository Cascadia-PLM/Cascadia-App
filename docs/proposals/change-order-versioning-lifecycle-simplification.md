# Assessment: Can the Change-Order / Versioning / Lifecycle Code Be Condensed?

Companion to
[`change-order-versioning-lifecycle-assessment.md`](./change-order-versioning-lifecycle-assessment.md),
which covers intent vs execution. This document is **quality only** — volume, duplication,
structure, and idiom. It does not hunt for defects; where a simplification also removes a defect
that is noted, but correctness findings live in the other document.

**The short answer: yes, substantially — and most of it without redesigning anything.** Roughly
2,700 lines can be deleted and another 1,500 relocated, almost all of it with no behaviour change,
and the two largest files in the domain each have a clear seam. The domain is not over-engineered;
it is under-factored. Logic that should live in one place lives in three, and logic that should
live in a service lives in a route handler.

**Status**: §2 (delete outright) is **done** — see §10 for the as-built record, including two
dead components this document missed and one deletion that turned out not to be safe as written.
§§3–7 are open.

---

## 1. Where the volume is

| File                                                           | Lines   |
| -------------------------------------------------------------- | ------- |
| `packages/core/src/server/routes/change-orders.ts`             | 3,786   |
| `packages/core/src/lib/services/ChangeOrderMergeService.ts`    | 2,320   |
| `packages/core/src/lib/items/services/ChangeOrderService.ts`   | 2,279   |
| `packages/core/src/lib/workflows/WorkflowService.ts`           | 2,038   |
| `packages/core/src/lib/services/VersionResolver.ts`            | 1,140   |
| `packages/core/src/lib/services/ConflictDetectionService.ts`   | 1,138   |
| `packages/core/src/lib/services/CheckoutService.ts`            | 1,120   |
| `packages/core/src/lib/services/CommitService.ts`              | 798     |
| `packages/core/src/lib/services/LifecycleService.ts`           | 699     |
| `packages/core/src/lib/services/BranchService.ts`              | 690     |
| `packages/core/src/lib/items/services/ItemVersioningFacade.ts` | 548     |
| `packages/core/src/lib/services/RevisionService.ts`            | 177     |
| change-order + versioning UI                                   | ~11,900 |

`RevisionService` is the model the rest should aim at: one responsibility, one authority for the
working-revision marker, a matching SQL predicate in `db/filters.ts`, and 177 lines. Nothing in
this document asks for more abstraction than that.

---

## 2. Delete outright — ~1,650 lines, essentially zero behaviour change

### 2a. Dead UI components (1,192 lines)

| File                                                  | Lines | Status                                                                          |
| ----------------------------------------------------- | ----- | ------------------------------------------------------------------------------- |
| `components/change-orders/AffectedItemsManager.tsx`   | 551   | No importer. Superseded by `EcoAffectedItemsPanel`                              |
| `components/items/VersionContextSelector.tsx`         | 233   | No importer. Both call sites use `components/versioning/VersionContextSelector` |
| `components/change-orders/EcoCheckoutDialog.tsx`      | 228   | No importer                                                                     |
| `components/change-orders/EcoAffectedDesignsView.tsx` | 180   | No importer                                                                     |

Two of these carry their own `useEffect` + `fetch` data layers and their own copies of the
change-action literals, so they are also a source of future copy-paste.

While there: `components/change-orders/index.ts` is a stale barrel. It exports three of the four
dead components and **none** of the live ones (`ChangeOrderDetail`, `EcoAffectedItemsPanel`,
`EcoSummaryDashboard`, `ConflictsList`, `ApprovalStatusPanel`, …), which import by direct path. Its
only consumer needs two symbols (`registerItemTypes.tsx`). It is currently the sole reason the dead
files stay in the module graph. Reduce it to what is actually consumed, or delete it and import
directly.

### 2b. Dead service methods (~340 lines)

Verified: no production callers.

| Symbol                                                                                             | Lines | Note                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| `ChangeOrderService.submit()`                                                                      | 24    | Superseded by `executeWorkflowTransition`                                                                            |
| `ChangeOrderService.approve()`                                                                     | 32    | Ditto. Its gates were extracted into `assertReleaseGates()`, which is live                                           |
| `ChangeOrderService.reject()`                                                                      | 16    | Ditto                                                                                                                |
| `ChangeOrderService.validateRelease()`                                                             | 49    | Never wired to a route. Hardcodes `'Released'`                                                                       |
| `ChangeOrderService.validateObsolescence()`                                                        | 54    | Never wired. Raw SQL where-used, hardcodes `'Released'`, duplicates `ImpactAssessmentService`                        |
| `ChangeOrderService.updateAffectedItem()`                                                          | 12    | No route, no validation. Flagged in the routing remediation's as-built note 7 as "delete or validate"; still neither |
| `ChangeOrderMergeService.getNextRevision()`                                                        | 6     | `@deprecated` shim delegating to `RevisionService`                                                                   |
| `RevisionService.getResetRevision()`                                                               | 4     | No callers                                                                                                           |
| `ItemVersioningFacade.requiresCheckout()` / `.canEditItemDirectly()` + the `ItemService` delegates | ~20   | Tests only. Both hold hardcoded state lists                                                                          |
| `LifecycleService.getValidTargetStates()`                                                          | 25    | No callers                                                                                                           |

`approve()`/`reject()`/`submit()` are the highest-value deletions: they are plausible-looking
alternative entry points to the release path that bypass `executeWorkflowTransition`'s claim
protocol. Keeping them is an invitation to reintroduce the stranded-ECO bug that Phase 1 of the
workflow remediation closed. Delete them and their tests.

### 2c. Dead lifecycle helpers in `eco-helpers.ts` (~110 lines)

`incrementRevision`, `getTargetInfo`, `getAvailableActions`, `getDefaultChangeAction` are a
client-side reimplementation of `RevisionService` + `LifecycleService.getValidActions`. They are
_used_, so this is not a pure deletion — but replacing them with a server call (see F1/F2 in the
companion document) removes the file and its four consumers' local action-override state. Listed
here because the volume reduction is real and the duplication is the reason the defect exists.

---

## 3. Three copies of one idea — the merge service

`ChangeOrderMergeService.merge()` has **two** release paths (branch merge, affected-items) plus a
**third** reconciliation pass ("whatever the branch merge did not handle"). The three-path shape is
correct — the routing remediation's as-built note 3 reasoned it out properly, and keying the third
pass structurally rather than on an action allow-list is what stopped `promote` being dropped. The
problem is that each path resolves the _same lifecycle facts_ independently.

**`revise` is implemented three times:**

| Location | Lines | Resolves |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- | --- | -------------------- |
| Branchless path | `:639-789` | `newVersionState`, `oldVersionState`, scheme, working-copy lookup, supersede, ` |     | 'Released'` fallback |
| Post-branch pass | `:1064-1104` | `newVersionState`, `oldVersionState`, scheme, `ItemService.revise`, `           |     | 'Released'` fallback |
| Branch merge | `:1413-1533` (via `lifecycleStateCache` at `:1258-1309`) | `reviseState`, `supersededState`, scheme, supersede |

`release`, `obsolete`, and `promote` are each implemented twice (branchless at `:585-637`,
`:791-818`, `:820-859`; post-branch at `:1042-1136`). `promote` is the one that was already
factored — `resolvePromote()` at `:268` — and it is visibly the cleanest of the six, precisely
because it exists once.

The `|| 'Released'` / `|| 'Obsolete'` / `|| 'Superseded'` fallbacks appear **nine times** across
these blocks. Each is a separate opportunity for the paths to diverge, and history says they will:
the whole C-2/C-3 cluster in the routing remediation was exactly two of these blocks having drifted
apart.

**The refactor the previous plan specified and never shipped.** The routing remediation's §2
Phase 2/3 named three helpers:

- `resolveActionStates(itemType, action)` → the from/to/new/old states and scheme, once
- `supersedePriorVersions(masterId, keepItemId, oldVersionState)` → the scoped `isCurrent` clear
- `applyStateOnlyAction(item, action)` → release / obsolete / promote

None of them exist in the code today (`grep` finds no definition). The behaviour they were meant to
guarantee _was_ achieved — by editing each site — which is why the as-built notes read as
successes. But the shape the plan chose to prevent recurrence was skipped, and the duplication it
was meant to remove is still there. Introducing the three helpers now is a pure refactor with the
test suite already in place to protect it (`ChangeOrderMergeService.test.ts` is 2,834 lines and
asserts invariants, not call shapes — exactly the coverage that makes this safe).

Estimated reduction: **~350 lines** from `ChangeOrderMergeService`, and the nine literal fallbacks
collapse to one.

`lifecycleStateCache` (`:1258-1309`) should become the general mechanism rather than a
branch-path-local optimisation — see §5.

---

## 4. Two route handlers are services in disguise

`packages/core/src/server/routes/change-orders.ts` is 3,786 lines. Two handlers account for 41% of it:

| Handler                                  | Lines |
| ---------------------------------------- | ----- |
| `GET /:id/designs/:designId/structure`   | 878   |
| `GET /:id/branch-history`                | 675   |
| `POST /:id/resolve-conflicts`            | 173   |
| `POST` + `DELETE /:id/bom-changes`       | 329   |
| `POST /:id/workflow/validate-transition` | 160   |

The structure handler builds a multi-design BOM tree: it resolves a per-design `VersionContext` map
from merge status, walks relationships breadth-first with a `childrenMap`/`hasParent`/`localItemById`
/`externalItemById` working set, defers and back-fills cross-design targets, and assembles orphan
lists. That is `VersionResolver`/`ItemRelationshipService` work living behind an HTTP verb. Nothing
about it is HTTP-shaped.

Consequences today, all of them ordinary rather than dramatic:

- **Not reusable.** The same tree is wanted by the ECO structure tree, the impact panel, and the
  BOM comparison views; each has its own partial version.
- **Not unit-testable.** There is no seam. `change-orders.ts` has no test file, and per the
  three-gate rule this logic _does_ qualify (graph traversal + version resolution), so the absence
  is a coverage gap caused by placement, not by policy.
- **The route file does its own data access** — 37 direct `db` calls — so the service layer is not
  actually the boundary the architecture docs describe.
- **Error handling drifted.** Five hand-built `new Response(JSON.stringify({ error: ... }))` sites
  (e.g. `:987`, `:1662`) bypass `handleApiError`, so two endpoints in this file return
  `{ error: string }` while every other endpoint in the app returns the standard error envelope.
  Throwing `NotFoundError` is a one-line change per site and deletes ~40 lines.

**Recommended**: `EcoStructureService` (or a method on `VersionResolver`) for the first,
`EcoBranchHistoryService` for the second. Both are lift-and-shift; the handlers become ~20 lines
each. Reduction in the route file: **~1,500 lines relocated**, and the route file drops to roughly
2,200 — still large, but legibly a routing layer.

---

## 5. Efficiency: the lifecycle row is re-read dozens of times per release

`LifecycleService` has no cache. Every call chains through
`ItemTypeRegistry.getLifecycleForType()` → `WorkflowService.getById()`
(`WorkflowService.ts:161`) → a fresh `SELECT` of the workflow-definition row.

`ChangeOrderMergeService` makes **32** `LifecycleService.*` calls. In the branchless release loop,
each affected item triggers `getTargetState`, `getRevisionScheme`, `getOldVersionState`, and
`canApplyAction` — four to six round-trips per item, all reading the _same_ row for items of the
same type. A 50-item ECO does on the order of 250 redundant queries inside a transaction that is
holding locks.

Two signals that this is felt rather than theoretical: the branch path builds its own
`lifecycleStateCache` keyed by `itemType` before opening its transaction (with the comment
_"Pre-fetch outside transaction to avoid async issues"_), and `previewMerge` calls
`getRevisionScheme` once per preview item.

**Fix**: a request-scoped memo on `getLifecycleForItemType(itemType)` — the definition cannot change
mid-request, and lifecycle edits already go through `WorkflowService.update`, which is the natural
invalidation point. `ThreadCacheService` and the `cache` schema exist as precedent for a repo-native
pattern. Doing this lets `lifecycleStateCache` be deleted (~50 lines) and lets §3's
`resolveActionStates()` be called freely without a per-call query, which is what makes that refactor
cheap.

Secondary N+1s in the same neighbourhood, each a small batch fix:

- `mergeBranchToMain:1776-1805` — per-`itemChange` `SELECT` to build the MBOM notification payload;
  one `inArray` would do.
- `assertDriverAuthorized:158-186` and `assertScopeMatchesBranchContent:242-247` — per-item
  `ItemService.findById` inside a loop.
- `CheckoutService.listUserCheckouts` / `.listBranchCheckouts` — per-row item fetch inside a loop.
- `VersionResolver.getBranchItems` — per-branch-item `SELECT` in two loops, on the list path.

---

## 6. Idiom drift in the UI

`CLAUDE.md` states the data-fetching rule explicitly: one TanStack Query cache, route loaders prime
it with `ensureQueryData`, components read the same factory with `useQuery`, mutations invalidate by
resource — and _"Do not … fetch in `useEffect` + `useState`"_ is named as one of the five idioms the
layer replaced.

**Eleven live components in this domain still fetch inside `useEffect`:**

`ChangeOrderDetail`, `ConflictsList`, `ImpactAssessmentPanel`, `AddPartFromDesignDialog`,
`AddBomChildToEcoDialog`, `WorkflowTransitionDialog`, `WorkflowStatusPanel`, `StateApproversPanel`,
`TransitionPropertiesPanel`, `DriverSelector` — plus the dead `AffectedItemsManager` and
`EcoCheckoutDialog`.

`ChangeOrderDetail.tsx` is the clearest case: one `useQuery` alongside **three** effect-fetches
(available designs at `:233`, main branch id at `:253`, item-at-context at `:274`), two of them using
raw `fetch` rather than `apiFetch`, each with its own loading flag and its own silent `catch {}`.
`WorkflowTransitionDialog.tsx:99` does the same for the release preview with a manual `cancelled`
flag standing in for query cancellation.

Nine query factories already exist (`query/options/change-orders.ts`,
`query/options/workflows.ts`), and `ecoDesignStructureQuery` shows the pattern working for the
hardest endpoint in the domain. This is not a design gap — it is unfinished migration.

Converting the eleven removes roughly **20 `useState` pairs, 11 `useEffect` blocks, and 11 silent
catch blocks (~400 lines)**, and — the reason it matters beyond volume — it puts these views on the
`RESOURCE_DEPENDENTS` graph, so a release actually refreshes them. Today a component that fetched in
an effect does not respond to `invalidate('workflows')` at all, which is why several of these views
need a manual reload after an ECO releases.

Smaller items in the same layer:

- **`EcoTreeTable` is imported by seven components** with per-consumer prop shims. It is the right
  shared component; the shims suggest its prop surface wants one pass.
- **Two `VersionContextSelector` files.** One is dead (§2a); the duplicate name is itself the
  hazard.
- **`stateVariant` / `getStateColor` / `priorityVariant` / `riskVariant`** are re-declared per
  component (`ChangeOrderDetail:76`, `WorkflowTransitionDialog:157`, and others), with different
  and now-stale mappings. `StateBadge` already exists from the workflow remediation's Phase 6 and
  resolves state IDs to display names through the lifecycle cache; these sites should use it.

---

## 7. Smaller cleanups

- **`ChangeOrderService.addAffectedItemsBatch()`** (`:308`) opens `db.transaction(async () => …)`
  and ignores the `tx`, so every nested call runs on the global handle. The wrapper is pure
  overhead — it promises atomicity it cannot deliver (documented as such in
  `change-management.md`). Either thread `tx` or drop the wrapper; keeping it is worse than either.
  Its dedup also keys on `affectedItemId` while `addAffectedItem` keys on `masterId`, so the two
  disagree about what "already present" means.
- **`ChangeOrderMergeService.merge()` is ~850 lines in one method.** Splitting it into
  `mergeBranches()`, `applyAffectedItems()`, `applyRemainingActions()`, and `createBaselineTags()`
  — the four phases already delimited by its own numbered comments — is mechanical and makes §3's
  helpers obvious.
- **`copyTypeSpecificDataTx`** (`ChangeOrderService.ts:480`) is a 190-line hand-written switch over
  six item types, while `getTypeHandler(itemType)` + `copyExtensionRow()`
  (`ChangeOrderMergeService.ts:105`) already do this generically. The WorkInstruction case has real
  extra work (operations, steps, attachments with id remapping) that belongs on that type's handler;
  the other five cases are pure field-list duplication that will silently go stale when a column is
  added. Moving the sub-table copy into the type handler and deleting the switch removes ~150 lines
  and one whole class of "new column missing on revision" bug.
- **`ChangeOrderService.getEcoSummary()`** duplicates the branch-item counting that
  `EcoDesignStructureTree` and the structure endpoint also do. One derived-counts helper serves all
  three (and removes the need for the stored `itemsAffected` column — see F9 in the companion
  document).
- **`ItemVersioningFacade` (548 lines) is a pass-through for `ItemService` (976 lines)**, which
  re-exports ~12 of its methods as one-line `@see` delegates. The split is defensible, but the
  delegate layer earns nothing: callers could import the facade. Removing the delegates trims ~80
  lines and one indirection when reading a stack trace.
- **`ChangeOrderService.acknowledgeRisk` / `acknowledgeRiskForChangeOrder`** — the unscoped variant
  exists only to be called by the scoped one. Inline it so there is no unscoped version to reach
  for.

---

## 8. What should _not_ be changed

Restraint matters as much as reduction here.

- **The three-path merge shape.** Branch content, affected items, and the reconciliation pass are
  genuinely three different jobs. Collapsing them would recreate the bugs the structural keying was
  introduced to fix. Factor the shared _resolution_, keep the three paths.
- **The claim/`beforeFinalize` interlock.** It reads as elaborate and every part of it earns its
  place. Do not simplify it.
- **`VersionResolver`'s fallback ladder.** Each rung has a documented reason (pre-commit data, seed
  data, branch-draft exclusion). It looks redundant and is not.
- **`RevisionService` + `notWorkingRevision()`.** The apparent duplication between the TS predicate
  and the SQL filter is deliberate and commented. Leave it.
- **The comments.** This domain's comments explain _why_, name the bug the current shape prevents,
  and record decisions. They are the reason both of these documents could be specific. Any
  refactor should carry them forward, not tidy them away.

---

## 9. Sequenced plan

Ordered by value per unit of risk. Steps 1–3 are safe in any order and unlock the rest.

| #   | Work                                                                                                            | Removed / moved                 | Risk                                   |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------- |
| 1   | Delete dead UI components; trim the stale barrel                                                                | −1,192                          | None                                   |
| 2   | Delete dead service methods (esp. `submit`/`approve`/`reject`) and their tests                                  | −340                            | None                                   |
| 3   | Throw typed errors instead of hand-built `Response`s in `change-orders.ts`                                      | −40                             | None                                   |
| 4   | Request-scoped lifecycle memo; delete `lifecycleStateCache`                                                     | −50, ~250 fewer queries/release | Low                                    |
| 5   | `resolveActionStates` / `supersedePriorVersions` / `applyStateOnlyAction`; split `merge()` into its four phases | −350                            | Low — invariant tests already cover it |
| 6   | Extract `EcoStructureService` and `EcoBranchHistoryService` from the two large handlers                         | 1,500 relocated                 | Low                                    |
| 7   | Move sub-table copying into type handlers; delete `copyTypeSpecificDataTx`                                      | −150                            | Low                                    |
| 8   | Migrate the eleven effect-fetch components onto query factories                                                 | −400                            | Low, mechanical                        |
| 9   | Replace `eco-helpers` prediction with server-authoritative values                                               | −110                            | Low — also fixes F1/F2                 |
| 10  | Batch the five N+1 loops in §5                                                                                  | ~0                              | Low                                    |
| 11  | Drop the `ItemService` → facade delegate layer; inline `acknowledgeRisk`                                        | −90                             | Low                                    |

**Net: roughly 2,700 lines deleted and 1,500 relocated**, with the merge service losing its
triplicated action resolution, the route file becoming a routing layer, and the UI joining the cache
it is supposed to share.

Nothing here requires a design decision except step 6's service boundaries. Steps 1–3 alone remove
1,572 lines in an afternoon, including three dead entry points to the release path — which is the
single best reason to start there.

---

## 10. As-built: §2 (delete outright)

**~2,050 lines removed**, verified with lint (0 warnings), `tsc --noEmit`, and the full unit suite
(1,450 passing).

### Deleted

| What                                                                                                                                           | Lines |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `AffectedItemsManager.tsx`, `EcoCheckoutDialog.tsx`, `EcoAffectedDesignsView.tsx`, `items/VersionContextSelector.tsx`                          | 1,192 |
| `items/ItemHistory.tsx` — **not in this document**, found by sweeping; superseded by `ItemHistoryTab` and reachable only through a dead barrel | 235   |
| `workflows/WorkflowTable.tsx` — **not in this document**, found by the same sweep; zero references                                             | 199   |
| `components/items/index.ts` — entirely unreferenced barrel                                                                                     | 12    |
| `ChangeOrderService.submit/approve/reject/validateRelease/validateObsolescence/updateAffectedItem`                                             | ~190  |
| `ChangeOrderService.acknowledgeRisk` (unscoped variant, folded into the scoped one)                                                            | 10    |
| `ChangeOrderMergeService.getNextRevision` deprecated shim                                                                                      | 9     |
| `RevisionService.getResetRevision`                                                                                                             | 9     |
| `LifecycleService.getValidTargetStates`                                                                                                        | 25    |
| Tests for all of the above, including a `getNextRevision` block duplicating `RevisionService.test.ts` case for case                            | ~380  |

`components/change-orders/index.ts` was reduced from `export *` over the whole directory to the
two symbols its single consumer imports.

### One deletion was not safe as written

`submit()` and `approve()` were the **only** writers of `change_orders.submittedAt`,
`approvedAt` and `approvedBy` — and those three are displayed on the change-order detail page and
the design's ECO list. Deleting the methods as this document proposed would have blanked three
user-visible fields silently.

The stamping moved to `executeWorkflowTransition` first: `submittedAt` on the first transition out
of the initial state (written once, so a rework round trip through Draft keeps the original date),
`approvedAt`/`approvedBy` when a releasing transition succeeds. Both are defined for any workflow
rather than for one workflow's state names. Two tests pin them — in the shipped product these
fields were always blank, because only the dead wrappers ever wrote them.

### Coverage kept rather than dropped

The `approve()` tests included one real invariant: an unacknowledged critical risk must block a
release. That gate is live in `assertReleaseGates`, reachable from `executeWorkflowTransition`, so
the test was re-pointed there rather than deleted, and a companion added for the acknowledged case.
The remaining tests in the deleted blocks asserted the wrappers' own bookkeeping and went with
them. Tests that used `submit()`/`approve()` as setup now drive the real entry point through a
`transitionTo()` helper.

### Why the wrappers mattered

They were not merely unused. `submit()`/`approve()`/`reject()` called `WorkflowService.transition`
directly, skipping `executeWorkflowTransition`'s release claim — the interlock that keeps a failed
merge retryable and stops a change order stranding in a final state. Deleting them removes a
plausible-looking alternative entry point to the release path, which is worth more than the ~70
lines.

---

## 11. As-built: §5 (lifecycle memo) and §3 (merge de-duplication)

Shipped together, as §9 steps 4 and 5 — the memo is what makes the shared resolver cheap enough to
call per item, so splitting them would have traded one duplication for a pile of queries.

### The memo

`ItemTypeRegistry` now memoizes `getLifecycleForType()` in a module-level `Map`, caching the
`undefined` answer as well as the hit so an unassigned type does not re-query on every call.
Invalidation is at every point that can change the answer:

| Site                                   | Why                                        |
| -------------------------------------- | ------------------------------------------ |
| `register()` / `unregister()`          | the type's `lifecycleDefinitionId` changes |
| `loadRuntimeConfigs()` / `clear()`     | wholesale reload, every entry is suspect   |
| `WorkflowService.create/update/delete` | the definition row itself changes          |

`ConfigService`'s mutators are covered transitively: both call sites in `admin.ts` already follow
`saveConfig`/`deleteConfig` with `ItemTypeRegistry.reload()`, which clears the cache. That was
checked rather than assumed.

**Scope caveat, deliberately accepted.** The memo is per process, so a lifecycle edit on one app
instance does not invalidate another instance's copy. This is not a new class of staleness: runtime
item-type configs were already cached per process and only refreshed by the instance that served
the admin request. The memo extends the existing window to lifecycle definitions rather than opening
a new one. Making it cross-instance means a real invalidation channel, which is out of scope here.

### The shared resolver

`LifecycleService.resolveActionStates(itemType)` returns `ResolvedActionStates` — `releaseState`,
`obsoleteState`, `reviseState`, `supersededState`, `revisionScheme` — as the single authority for
the five values every merge path was working out for itself. `ChangeOrderMergeService` dropped
**177 lines against 63 added**; the branchless path, the post-branch pass, and the branch merge now
each call it once per affected item.

**All nine `|| 'Released'` / `|| 'Obsolete'` / `|| 'Superseded'` literals are gone** (`grep` count
0), and so is the tenth — a fallback object literal inside the branch-merge loop that the original
`||` grep did not match. Where that one stood, a miss is now an `InternalError`: the map is
pre-resolved from exactly the item set the loop walks, so a miss means the item's type changed
under the merge, which is an invariant break and not something to answer with hardcoded state
names.

`lifecycleStateCache` survives as a pre-resolve pass rather than being deleted outright, contrary to
what §5 predicted. Deleting it would move the first cold-cache read for each item type _inside_ the
serializable transaction, on the global `db` proxy rather than `tx` — precisely the "async issues"
the original comment warned about, while the transaction holds locks. It is now four lines over a
distinct-`itemType` set feeding the memo, not a fifty-line bespoke cache.

### A real divergence the de-duplication surfaced

The two `revise` paths did not agree. The branchless path forced the superseded prior version to the
literal state `'Superseded'`; the branch path omits the state change entirely when the lifecycle
configures no `oldVersionState`. Same action, same lifecycle, different outcome depending on whether
the change order had a branch. Routing both through `resolveActionStates` settles it on the branch
path's behaviour — an unconfigured `oldVersionState` means the prior version keeps its state, which
is the answer that respects the lifecycle rather than overriding it.

### Verification

Lint 0 warnings, `tsc --noEmit` clean, `openapi:check` up to date, full unit suite green
(1,451 tests) across ten consecutive runs.

The memo has a discriminating test — `LifecycleService.test.ts`, `describe('lifecycle definition
memoization')` — confirmed to fail when the invalidation calls are removed. `ChangeOrderMergeService`
already asserts merge invariants rather than call shapes, which is what made this refactor safe to
do at all; those tests were left alone except for one that edits a workflow definition by raw SQL,
bypassing `WorkflowService.update` and therefore its invalidation. That test, and the two lifecycle
fixtures that seed definitions the same way, now invalidate explicitly.

**An earlier suspicion, recorded because it was wrong.** A one-off failure in two unrelated suites
was initially read as the memo leaking module state across test files. It cannot: vitest's default
`isolate: true` with `pool: 'forks'` gives each test file a fresh module registry. Ten clean
consecutive full-suite runs settled it; the failures were the local PostgreSQL service dropping,
which it did repeatedly during this work.

---

## 12. As-built: §4 (route handlers as services) and §9 step 3 (typed errors)

`change-orders.ts` went from **3,884 to 2,139 lines** — 1,767 removed, 22 added. Two services took
the weight, and one of them finally got the tests §4 said it was owed.

### The two services

| New file                     | Lines | Replaces                                                      |
| ---------------------------- | ----- | ------------------------------------------------------------- |
| `EcoStructureService.ts`     | 856   | `GET /:id/designs/:designId/structure` (878-line handler)     |
| `EcoBranchHistoryService.ts` | 788   | `GET /:id/branch-history` and `.../graph`, plus their helpers |

`EcoStructureService.getDesignStructure(changeOrderId, designId, { expandExternal })` is the whole
tree build: per-design version contexts, local items at context, external-target resolution,
cross-design reference roots, orphans, and the Library-design filter. `EcoBranchHistoryService`
exposes `getTimeline()` and `getGraph()`, and privately owns `buildGraph` and the commit-consolidation
helpers that were loose module functions in the route file.

All three handlers are now four to twelve lines and do nothing but read query params and delegate.
The route file's direct `db` calls dropped from **37 to 19**; both remaining large handlers are gone,
so no single handler is over ~170 lines.

### Tests, which were the point

`EcoStructureService.test.ts` — 8 tests, the first coverage this logic has ever had, because until
now there was no seam to call. It qualifies on gate 3 (graph traversal over version-resolved items).
The tests assert invariants, not call shapes: a cyclic BOM terminates, children nest with their
quantity and find number, non-structural items become orphans rather than roots, an affected item is
matched by masterId alone, a Library design shows only touched subtrees, and the version context
follows the change order's branch state.

Each was checked against a mutant rather than assumed to discriminate:

| Mutation                                | Test that failed            |
| --------------------------------------- | --------------------------- |
| drop the `visited` cycle guard          | cyclic BOM (stack overflow) |
| drop the masterId fallback in `isInEco` | masterId matching           |
| make the Library root filter a no-op    | Library subtree filter      |

Two of the eight were rewritten after being caught as _vacuous_: the cycle test originally built a
loop where neither part was a root, so it asserted over an empty tree and passed against every
mutant; and the masterId test recorded the affected item by both id and masterId, so it never
exercised the masterId path it was named for. Both now fail against the mutant.

### Typed errors (§9 step 3)

Of the five hand-built `new Response(JSON.stringify({ error }))` sites, two disappeared with the
extraction — both were `{ error: 'Change order not found' }` 404s, now `NotFoundError` thrown from
the services. Of the remaining three:

- The `vote` validation became `ValidationError`, so it returns the standard error envelope like
  every other endpoint.
- The 201 on approval became `created({ vote, approvalStatus })` — byte-identical body.
- The 207 multi-status became `jsonResponse(..., 207)`.

The last two matter for more than tidiness: both hand-built responses bypassed `applySecurityHeaders`,
so two endpoints were shipping responses without the security headers everything else carries. That
was not in §4's list of consequences; it turned up while doing the work.

### One deliberate behaviour change

`getGraph` used to return early when the selected design had no branch, and that early return built
its `affectedDesigns` list inline with `branchName: ''` for _every_ design — including designs that
do have branches. The extracted version resolves branch names once, before the check, so the design
switcher shows real names on that path too. It costs a few extra lookups on a rare path and fixes
blank labels in the switcher. Flagged here because it is a behaviour change inside what is otherwise
a lift-and-shift.

### Not done

§4 also observed that `BOMTreeNode` and `OrphanItem` are declared three times — now in
`EcoStructureService`, in `designs.ts`, and in `components/bom/types.ts`. Consolidating them touches
the designs route and the BOM components, which is its own change; the change-order copies are at
least now exported from a service rather than trapped in a route file.

### Verification

Lint 0 warnings, `tsc --noEmit` clean, `openapi:check` up to date, full suite green — 1,459 tests
across 56 files, up from 1,451 across 55.

---

## 13. As-built: §7 — `copyTypeSpecificDataTx`

One `copyTypeSpecificData()` replaces both hand-written copies. **196 lines of switch deleted**,
plus the 22-line `copyExtensionRow` in the merge service; the shared function is 60.

### The switch was already stale, in both directions

§7 predicted field-list duplication "will silently go stale when a column is added." It already had,
and worse than predicted — the two copies had drifted _apart_, so which fields survived depended on
which path you took:

| Path                                             | Dropped                                           |
| ------------------------------------------------ | ------------------------------------------------- |
| `copyTypeSpecificDataTx` (revision working copy) | Part `trackingMode`                               |
| `copyExtensionRow` (merge, via `handler.insert`) | Part `quantityOnHand`, `reorderPoint`, `location` |

`trackingMode` is the engineering-owned serial/lot policy that drives what work-order consumption
requires. Revising a serialized part through an ECO silently reset it to `'none'` on the working
copy. That was live.

### Row copy, not field list

The replacement copies **the whole extension row** — every column except `itemId` and an explicit
`NEVER_COPIED` set. That is what removes the bug class rather than resetting its clock: a column
added tomorrow is carried forward the day it exists, with nobody having to remember two call sites.

It is possible because every extension table is keyed one-to-one on `itemId` as its sole primary
key — verified across all thirteen before relying on it. `TypeHandler` gained a `table` field so the
copy can work off columns generically; the handlers' own `insert` is a create-from-form-data path
with `|| null` coercions and defaults, which is precisely why using it as a row copier lost fields.

`NEVER_COPIED` holds one column, `draftManifestId` — a software item's uncommitted editor state. Both
old paths already excluded it, one by omission and one by an explicit destructure; it is now one
named rule with a stated reason.

### Child tables became the type's own business

`TypeHandler` gained an optional `copyChildren`, declared only by WorkInstruction, which owns
operations, steps (remapped onto the copied operations) and part attachments.

**This fixed a live bug in the merge path.** `copyExtensionRow` copied only the extension row, so
merge paths that INSERT a fresh released item — rather than promoting a working copy in place — left
a work instruction's operations and steps behind on the working copy's id. A released WI came out
with its content gone. The revision path had the sub-table copy; the merge path never did. Routing
both through one function gives the merge path the children for free.

### Tests

`copy.test.ts` — 4 tests, gate 1 (silently losing engineering data across versions). The Part test
asserts **whole-row equality** against the source rather than naming fields, so a column added later
is covered without anyone editing the test. Each was checked against a mutant:

| Mutation                                    | Test that failed         |
| ------------------------------------------- | ------------------------ |
| skip one column in the copy loop            | whole-row equality       |
| empty the `NEVER_COPIED` set                | draft manifest exclusion |
| stop remapping steps onto copied operations | WorkInstruction children |

One test was written and deleted rather than shipped: "copies children when there is no extension
row". The child tables carry an `ON DELETE CASCADE` foreign key to `work_instructions.item_id`, so
that state is unreachable — the test would have asserted a fiction. The code still runs
`copyChildren` unconditionally, matching the original switch, but nothing claims to test it.

### One bug found while wiring it

`copy.ts` initially had no `import './init'`, so `getTypeHandler` returned `undefined` and the copy
silently did nothing — no error, no row. Every other consumer of the handler registry carries that
side-effect import; the module now does too. Worth noting because the failure mode is silence: had
the tests not existed, this would have shipped as "revisions come out empty."

### Verification

Lint 0 warnings, `tsc --noEmit` clean, `openapi:check` up to date, full suite green — 1,463 tests
across 57 files, up from 1,459 across 56.

---

## 14. As-built: §6 — the effect-fetch migration

**505 net lines removed** (544 added, 1,049 deleted) across 20 files. Every `useEffect` that fetched
in `packages/core/src/components/change-orders/` and `packages/core/src/components/workflows/` is gone — verified by walking each
effect body for a fetch call rather than by eye.

### The list was eleven; it was actually eleven, but not the same eleven

Two of §6's named components (`AffectedItemsManager`, `EcoCheckoutDialog`) were already deleted in
§2. Two it did not name were doing the same thing: `EcoHistoryGraphView` and
`InstanceStatePropertiesPanel`. One more, `WorkflowStatusPanel`, turned out to be **dead** — exported
from a barrel nothing imports, rendered nowhere — so it was deleted rather than migrated.

Nine components converted, one deleted:

| Component                      | Was                                                           |
| ------------------------------ | ------------------------------------------------------------- |
| `ChangeOrderDetail`            | three effect-fetches, two on raw `fetch`                      |
| `AddPartFromDesignDialog`      | four fetches, a hand-rolled debounce, a `useRef` result cache |
| `ConflictsList`                | fetch + manual retry/refresh wiring                           |
| `ImpactAssessmentPanel`        | GET on mount, POST re-fetch, duplicated loading flags         |
| `AddBomChildToEcoDialog`       | debounced search in an effect                                 |
| `EcoHistoryGraphView`          | fetch + auto-select-first-design via a second render          |
| `InstanceStatePropertiesPanel` | approvers fetch + users/roles fetch                           |
| `WorkflowTransitionDialog`     | release preview with a manual `cancelled` flag                |
| `TransitionPropertiesPanel`    | users + roles fetch                                           |
| `StateApproversPanel`          | approvers + users/roles fetch                                 |

### Three live bugs, all the same shape

Each was a component reading the wrong level of the response envelope — invisible because every one
of them swallowed its own failure:

| Site                            | Read                     | Should have read     | Effect                            |
| ------------------------------- | ------------------------ | -------------------- | --------------------------------- |
| `ChangeOrderDetail`             | `design.defaultBranchId` | `data.design.…`      | `mainBranchId` always `undefined` |
| `TransitionPropertiesPanel`     | `data.roles`             | `data.data.roles`    | role picker always empty          |
| `WorkflowStatusPanel` (deleted) | `data.instance`          | `data.data.instance` | always rendered "no workflow"     |

Routing through factories that own the unwrap fixes all three by construction. This is the argument
for the layer stated better than the volume figures do: eleven hand-written unwraps produced three
wrong ones, and silent `catch {}` meant nobody found out.

### New shared pieces

Six factories (`stateApproversQuery`, `activeUserListQuery`, `changeOrderReleasePreviewQuery`,
`changeOrderConflictsQuery`, `changeOrderImpactReportQuery`, `changeOrderBranchGraphQuery`,
`instanceStateApproversQuery`, `itemTextSearchQuery`, `itemAtContextQuery`), plus
`useDebouncedValue` — search boxes now debounce the _query key_ rather than a fetch, so a repeated
term resolves from cache instead of re-requesting. `designListQuery` and `designItemsGridQuery`
gained a type parameter and an `itemType` filter respectively rather than being duplicated.

### What was deliberately left

`itemAtContextQuery` replaces a copy of the same effect in `ChangeOrderDetail`; **six more detail
pages carry that identical effect** — Requirement, Task, Issue, TestPlan, TestCase, Part. The factory
now exists for them, but converting six components outside this domain is its own change, not
something to slip into this one.

Effects that remain in these files are state synchronisation, not fetching: resetting a dialog on
open, re-seeding a selection when props change, returning to page 1 when a search term settles.

### A pre-existing test flake, correctly diagnosed this time

The full suite fails roughly **1 run in 4**, always in `QualificationService` and
`materialize`. Running just those two files together reproduces it every time — on this branch and
on the stashed baseline alike, so it predates this work:

```
PostgresError: deadlock detected
  while inserting index tuple in relation "number_sequences"
  Process A waits for ShareLock on transaction T1; blocked by process B.
  Process B waits for ShareLock on transaction T2; blocked by process A.
```

Two test files run in separate worker processes, each holding a gate transaction open for the whole
file, and both upsert the same `number_sequences` row to allocate a `Requirement` number. Whichever
interleaving happens second deadlocks. It only shows up in the full suite when the scheduler happens
to co-schedule those two files.

**This corrects §11.** That section recorded the same two suites failing and attributed it to the
local PostgreSQL service dropping. That was wrong. The ten clean runs which "settled it" were luck
at roughly 3-in-4 per run. The memo conclusion in §11 still holds — `isolate: true` with
`pool: 'forks'` does give each file its own module registry, so module state cannot leak — but the
failures had a real cause, and it is this.

Fixing it means per-worker database isolation in `TestDatabase`; allocating numbers outside the gate
transaction would break the tests that assert on `REQ-000001`-style numbers. That is a
test-infrastructure change and belongs in its own commit, not bundled into a UI migration.

### Verification

Lint 0 warnings, `tsc --noEmit` clean, Prettier clean, full suite 1,463 passing on runs where the two
files above do not collide.

---

## 15. As-built: the test flake

Fixed, and it was not a test-infrastructure problem after all — §14 mis-scoped it too.

### It was production code behaving differently under test

`NumberingService.getNextSequence` allocated on `db`. In production that is already an autonomous
write: a service calling `db` from inside `db.transaction(tx => …)` gets a _different_ pooled
connection, so the sequence upsert commits and releases its row lock at once.

Under test it does not. `TestDatabase.setTestDb` points `db` at the test's gate transaction, so the
allocation joined it and held the `number_sequences` row lock for the whole test file. Two files
allocating `Requirement` and `Part` in opposite orders then form a lock cycle — the deadlock.

So the flake was not "tests are too parallel". It was the harness silently changing where a write
commits, on the one table every test touches.

### The fix

`autonomousDb` in `packages/core/src/lib/db/index.ts`: a handle that always runs on its own pooled connection and
never joins a caller's transaction. `NumberingService` uses it. `TestDatabase` points it at the pool
behind the gate transaction via `setTestAutonomousDb`, and its pool went from one connection to two —
with one, the allocation would queue behind the very transaction it is serving.

**Production behaviour is unchanged.** `autonomousDb` resolves to the same instance `db` already did
there; the handle only makes explicit what was already true, so the test harness can stop breaking it.

### Why this is the right fix rather than the one §14 proposed

§14 said this needed per-worker database isolation. That would have worked, but it treats the symptom:
it makes cross-file contention impossible instead of removing the reason these files contend. It also
costs a `CREATE DATABASE` per worker per run, and templating from the dev database fails outright
while a dev server holds a connection to it. The narrow fix is both smaller and more faithful — it
makes the test path match production rather than working around the mismatch.

### Verification

The reproducer is deterministic in both directions, which is what makes this more than a run count:

|                          | `QualificationService` + `materialize` together |
| ------------------------ | ----------------------------------------------- |
| before (branch and base) | deadlock **3 of 3** runs                        |
| after                    | pass **4 of 4** runs                            |
| fix reverted             | deadlock returns immediately                    |

Full suite: **8 of 8 clean**, 1,466 tests. Previously ~1 run in 4 failed.

`NumberingService.test.ts` adds 3 tests pinning the property that makes it work — a reserved number is
not handed back when the caller rolls back. Reverting the fix fails that test and reproduces the
deadlock in the same run, so the test and the flake are demonstrably the same defect.

### A real bug this covers beyond the flake

Allocation riding the caller's transaction was not only a test artifact waiting to happen. Any code
path that allocated a number on a handle that later rolled back would hand the same number to the
next caller. Item numbers are an identity guarantee; the second test now pins it.

---

## 16. As-built: §7 — `addAffectedItemsBatch`

Both halves of §7's complaint were real, and the second one was a live bug rather than a smell.

### The dedup disagreement was breaking the batch's whole purpose

`addAffectedItem` keyed "already present" on **masterId**; `addAffectedItemsBatch` keyed it on
**`affectedItemId`**. The same logical item has more than one `items.id` — its released version and a
branch working copy are different rows — so an id-keyed lookup reports _absent_ for an item that is
present.

The consequence is exactly backwards from what the batch is for. It exists for parent propagation,
where parents are routinely already on the change order and should be skipped. Instead, a parent
present under a different version id slipped past the batch's check, reached `addAffectedItem`, and
threw `"… is already an affected item of this change order"` — **failing the entire batch on the one
item it was supposed to skip over**.

The fix is one `findExistingAffectedItem(changeOrderId, masterId)` used by both, with the two policies
kept at the call sites: `addAffectedItem` raises, the batch skips and returns the existing row. Same
question asked once.

A test pins it — add an item, create a second version sharing its masterId, batch-add that version,
expect a skip. Reverting the masterId resolution reproduces the original `ValidationError` verbatim,
which is the same message that had been showing up in unrelated suites' logs all along.

### The transaction was decorative, and worse under test

`db.transaction(async () => …)` took the transaction handle and ignored it, so every call in the body
ran on the global `db` — a _different_ pooled connection — and the transaction wrapped nothing but its
own BEGIN and COMMIT.

The part that makes this more than dead weight: under test the harness points `db` at the test's
transaction, so the wrapper _did_ nest as a savepoint and the batch _did_ look atomic. The guarantee
held everywhere except production. That is the same class of divergence as §15's deadlock — the
harness silently changing where writes land — and it is worth noting that the two were found within a
day of each other in the same file's neighbourhood.

Removed rather than repaired, per §7's "either thread `tx` or drop the wrapper; keeping it is worse
than either." Real atomicity needs a transaction threaded through
`BranchService.getOrCreateEcoBranch`, `CommitService.create` and `createRevisionWorkingCopy`; that is
its own change. The method now documents that a mid-batch failure leaves earlier items added, which
is what production has always done.

### Verification

Lint 0 warnings, `tsc --noEmit` clean, Prettier clean, `openapi:check` up to date, full suite green —
1,467 tests, three consecutive runs.

---

## 17. As-built: §7 — splitting `merge()`, and §3's remaining helpers

`merge()` goes from **856 lines to 73**. It is now an orchestrator: load the change order, check the
driver allow-list and the review scope, then call four named phases.

| Phase | Method                  | Was                |
| ----- | ----------------------- | ------------------ |
| 1     | `mergeBranches`         | `// 3a`, 114 lines |
| 2     | `applyAffectedItems`    | `// 3b`, 431 lines |
| 3     | `applyRemainingActions` | `// 3c`, 178 lines |
| 4     | `createBaselineTags`    | 29 lines           |

The `if (branchesMerged === 0)` / `if (branchesMerged > 0)` pair becomes a plain if/else, which is
what it always was — the two conditions are exclusive and exhaustive.

### Two of §3's three helpers, shipped

`supersedePriorVersions(masterId, keepItemId, supersededState, tx)` replaces two byte-identical
blocks — one in the branchless revise path, one in the branch merge. Both carried the same hard-won
scoping (`isCurrent = true` only, so historical Obsolete revisions are not rewritten and parallel
ECOs' in-flight working copies are not clobbered) in two separate comments. Now one.

A local `trackReleased(designId, entry)` replaces **six** near-identical inline blocks that each
fetched the design's entry from a map, pushed to it and put it back. Writing it six times is how four
of them came to guard `item.designId && item.id` while two guarded only `item.designId` — a
difference with no meaning, since `items.id` is not nullable.

### The third helper is not shipped, deliberately

§3 also named `applyStateOnlyAction(item, action)`. The state _resolution_ those paths share is
already `resolveActionStates` (§11); what is left is not actually common. Phase 2 records every item
it releases so it can build a release commit per design; phase 3 does not, because the branch merge
already made that commit. A shared helper would need a mode flag to switch between the two — which is
worse than the two call sites, not better. Left alone rather than shipped as a helper that has to be
told which caller it has.

### Verifying a refactor of the release path

Tests passing is necessary and not sufficient for a 780-line move through the most consequential
method in the system, so two more checks:

- **Every removed-only line accounted for.** A whitespace-insensitive diff, split into
  added-vs-removed line sets, leaves only the six tracker blocks, the two supersede blocks, the three
  `if` wrappers that became guards or moved into the orchestrator, and lines Prettier rejoined. No
  logic went missing.
- **Operation counts unchanged.** `resolveActionStates` 4, `ItemService.update` 11,
  `ItemService.revise` 2, `CommitService.create` 2, `archiveBranch` 2, `canApplyAction` 3,
  `resolvePromote` 3, `totalRevisionsAssigned++` 8, `createTag` 1, `notifyDerivedMboms` 1 — identical
  before and after.

The comments came with the code rather than being tidied away, per §8. One that had been an inline
block inside phase 3 — the explanation of why that pass is keyed structurally rather than on an action
allow-list, and the `promote` bug that taught it — is now the method's doc comment, which is where a
reader looks first.

### Verification

Lint 0 warnings, `tsc --noEmit` clean, Prettier clean, `openapi:check` up to date, full suite green —
1,467 tests, three consecutive runs.

---

## 18. As-built: §5's five N+1 loops

All five batched. No behaviour change and almost no line-count change — the point is the queries.

| Site                                             | Was                          | Now         |
| ------------------------------------------------ | ---------------------------- | ----------- |
| `VersionResolver.getBranchItems` (two loops)     | one `SELECT` per branch item | one for all |
| `CheckoutService.listUserCheckouts`              | one per checked-out item     | one for all |
| `CheckoutService.listBranchCheckouts`            | one per checked-out item     | one for all |
| `ChangeOrderMergeService.assertDriverAuthorized` | one per affected item        | one for all |
| `assertScopeMatchesBranchContent`                | one per unlisted item        | one for all |
| `mergeBranchToMain`'s MBOM payload               | **two** per item change      | two for all |

### Measured, not assumed

`getBranchItems` counted at the driver, with a `debug` hook on the postgres client:

| Branch items | Before     | After |
| ------------ | ---------- | ----- |
| 25           | 28 queries | **4** |
| 50           | 53 queries | **4** |

`n + 3` to a constant, with identical results either way (25 and 50 items resolved in both). The two
`CheckoutService` listings share one `loadItemsById` helper and follow the same shape.

### The one that matters most

`mergeBranchToMain`'s payload loop ran **two** queries per changed item _inside the serializable
transaction_, so on a 50-item release that was 100 round trips of lock-holding — on the path where
lock duration is the thing most worth minimising. It is now two queries regardless of size.

`assertDriverAuthorized` keeps iterating the affected items in order even though it now reads them up
front, because the error message names the first offending item and reordering would change which one
a user sees.

### Verification

Lint 0 warnings, `tsc --noEmit` clean, Prettier clean, `openapi:check` up to date, full suite green —
1,467 tests, three consecutive runs.

---

## 19. As-built: §7 — `getEcoSummary`

### One counter, shared

`countAffectedItemsByDesign(affectedItems)` is now the single place a change order's per-design
affected-item count is worked out. It is **pure**, over rows the caller already holds, which matters:
`EcoStructureService` was running its own `COUNT`-shaped query joining `change_order_affected_items`
to `items` for a number it had already loaded the data to compute. That query is gone, and the two
views can no longer drift on what "N items affected" means.

Neither reads a stored counter. The `itemsAffected` column was only ever incremented, so removing an
affected item left the figure permanently too high and a failed add inflated it (F9 in the companion
document). The comment recording that now lives on the shared function instead of on one of its
callers.

### Three queries per design became two, total

`getEcoSummary` ran, for each design: a branch fetch, a `SELECT` of the branch's items to tally
change types, and a second `SELECT` of the same table to look for held checkouts. Three round trips
per design, and two of them asking the same table two questions.

It now reads all branches in one query and all their branch items in one more, then tallies in
memory — 2 queries whatever the design count, and the checkout check falls out of the rows already
fetched.

### Tests, because everything here was untested

`getEcoSummary` had two tests: the empty case and the not-found case. Every number it computes was
uncovered, which is a poor position from which to rewrite how all of them are computed. Two tests
added, both checked against mutants:

| Mutation                                  | Test that failed            |
| ----------------------------------------- | --------------------------- |
| stop letting a held checkout block submit | held-checkout / `canSubmit` |
| tally `added` into the `modified` bucket  | per-type branch tally       |

The second pins something the batching rewrite could plausibly have broken silently: the three change
types are now counted in one pass over mixed rows rather than by three separate filtered queries.

### Verification

Lint 0 warnings, `tsc --noEmit` clean, Prettier clean, `openapi:check` up to date, full suite green —
1,469 tests, three consecutive runs.

---

## 20. As-built: §7's last two items, and the plan's close

### `acknowledgeRisk` — already done

§7 asked for the unscoped `acknowledgeRisk` to be inlined so there is no unscoped version to reach
for. §2's deletion pass had already removed it; only `acknowledgeRiskForChangeOrder` remains, and it
is the only one anything calls. Nothing to do.

### The `ItemVersioningFacade` delegates — deliberately kept

§7 proposed deleting `ItemService`'s ~80 lines of one-line delegates on the grounds that "callers
could import the facade." They could, and **none do.**

`ItemVersioningFacade` is referenced from exactly one file — `ItemService.ts` — and is re-exported
from no barrel. It is already a private split of `ItemService`, not a second service. All **38**
versioning call sites in the codebase go through `ItemService`, which is where `CLAUDE.md`'s service
table and the architecture docs send people.

Deleting the delegates would therefore not remove an indirection callers see. It would edit 38 call
sites, add a facade import to roughly twenty files, and promote an internal class into a public
dependency of all of them — trading 80 lines in one file for a wider public surface and more code at
the call sites. That is a worse codebase for a better line count.

Kept, with the boundary made explicit instead: the facade's doc comment now says it is internal and
why, and the delegate block says what it buys. The premise was worth testing rather than executing —
§7 asserted a state of the code that turned out not to hold.

---

## 21. The sequenced plan, closed

Every step in §9 is done or consciously declined. Across thirteen commits: **98 files changed,
+9,144 / −7,042**.

| #   | Work                                           | Outcome                                      |
| --- | ---------------------------------------------- | -------------------------------------------- |
| 1   | Delete dead UI components                      | §10                                          |
| 2   | Delete dead service methods                    | §10 — and saved `submittedAt`/`approvedAt`   |
| 3   | Typed errors instead of hand-built `Response`s | §12 — also restored missing security headers |
| 4   | Lifecycle memo                                 | §11                                          |
| 5   | Shared action resolution                       | §11 — found a live revise-path divergence    |
| 6   | Extract the two route-handler services         | §12 — first tests for the BOM tree           |
| 7   | Sub-table copying into type handlers           | §13 — found a live `trackingMode` data loss  |
| 8   | Effect-fetch migration                         | §14 — found three live envelope bugs         |
| 9   | Server-authoritative revision prediction       | done in the first remediation round (F1/F2)  |
| 10  | Batch the N+1 loops                            | §18 — measured 53 → 4 queries                |
| 11  | Drop the facade delegates                      | §20 — **declined**, premise did not hold     |

Plus two items the plan did not contain, found while doing the rest: the `number_sequences` deadlock
(§15) and the affected-item batch's dedup mismatch (§16).

### What this exercise actually produced

The line counts were never the interesting part. Nine of the eleven steps turned up a live defect,
and in most cases the defect was invisible precisely because of the duplication the step removed —
two copies of a field list that had drifted, eleven hand-written response unwraps of which three were
wrong, a decorative transaction that made a batch look atomic in tests and not in production.

Three of my own conclusions had to be corrected mid-flight and are marked as such: the test flake
blamed on a flapping database (§14 → §15), the memo's supposed cross-file leakage (§11 → §15), and
this section's facade premise. They are left in the record rather than tidied, because a document
that only shows the conclusions that survived is not much use for judging the ones that did.

### Not done, and knowingly so

- Whole-change-order (cross-design) transaction atomicity — one transaction per design, by design.
- `addAffectedItemsBatch` atomicity — needs a transaction threaded through three services (§16).
- `applyStateOnlyAction` — the third §3 helper; the two paths differ in what they record (§17).
- `BOMTreeNode`/`OrphanItem` declared three times — consolidating touches the designs route and the
  BOM components (§12).
- `itemAtContextQuery` for the other six detail pages — the factory exists; they are outside this
  domain (§14).
- Per-worker test database isolation — no longer needed for the flake it was proposed for (§15), but
  still the only thing that would make cross-file contention structurally impossible.

---

## 22. As-built: the two follow-ons worth doing

Both taken from §21's "not done" list after weighing them; the other four stay declined.

### One declaration for the BOM tree types

`BOMTreeNode` and `OrphanItem` were declared **four** times — `EcoStructureService`, the designs
route, `components/bom/types.ts`, and a local copy inside `EcoDesignStructureTree` — and had drifted
in three separate directions:

|                           | `masterId` | `isInEco` / `changeAction` | `isBranchChanged` | `name`           |
| ------------------------- | ---------- | -------------------------- | ----------------- | ---------------- |
| `EcoStructureService`     | required   | yes                        | **yes**           | `string \| null` |
| designs route             | **absent** | **absent**                 | **absent**        | `string \| null` |
| `components/bom/types.ts` | optional   | yes                        | **absent**        | **`string`**     |

They now come from `packages/core/src/lib/types/bom.ts`. Fields only one producer emits are optional and say so,
which is the honest encoding: a consumer holding a tree cannot tell from the type which endpoint
built it, so anything not universal has to be treated as possibly absent.

**Unifying on the server's nullable `name` found a live crash.** `items.name` is nullable in the
schema, and the client type asserted `string`, so three sites called string methods on it
unguarded — `StructureTab`'s search (`node.name.toLowerCase()`), `EcoDesignStructureTree`'s column
filter, and the BOM export, which wrote the literal `"null"` into the name column. The first two
throw for any design containing an unnamed item, reachable by typing in the filter box. All three now
coalesce.

That is the fourth time on this branch that a duplicated declaration turned out to be hiding a real
defect, which is the argument for doing this one rather than the line count.

### Five of the six detail pages onto `itemAtContextQuery`

Requirement, Task, Issue, TestPlan and TestCase carried byte-for-byte the same effect-fetch that
`ChangeOrderDetail` did — build a query string from the version context, fetch, fall back to the
prop on failure, all inside a silent `catch`. All five now use the factory §14 introduced, so they
join the invalidation graph instead of holding whatever their effect last loaded.

Two behaviours were checked rather than assumed to survive: `main` context still issues no request
(the factory disables itself when the context addresses nothing), and a failed fetch still falls back
to the caller's copy (the query's `undefined` and the old `catch` produce the same
`versionAtContext ?? item`). `TestCaseDetail` additionally pushed a freshly-fetched test case into the
displayed copy after recording an execution; that setter is gone, and the derived value now follows
the base item — which also stops an execution refresh from overwriting a historical snapshot the user
is looking at.

**`PartDetail` was deliberately left alone.** It looks like the same effect and is not: it asks for
`released=true` on `main` context, reads a `resolvedItemId` the other five ignore, and **navigates to
a different route** when the resolved version has a different id. Converting it needs the factory
extended and a decision about where that navigation belongs — on the most-used detail page in the
product, that is its own change, not a sixth line in a mechanical sweep.

Unlike §14, this sweep surfaced no new bug in the five. That is a fair outcome to record: the
expectation was one or two, and one of two follow-ons paying out is what the estimate actually
justified.

### Verification

Lint 0 warnings, `tsc --noEmit` clean, Prettier clean, `openapi:check` up to date, full suite green —
1,469 tests. No test covers these components directly; the null-handling fixes are backed by the
type system now asserting what the schema always said.
