# Assessment: Change Orders, Item Versioning, and Lifecycle — Intent vs Execution

**Scope**: the end-user-facing behaviour of change management, Git-style versioning, and item
lifecycle. Read end to end: `ChangeOrderService`, `ChangeOrderMergeService`, `CheckoutService`,
`ConflictDetectionService`, `ConflictReviewService`, `VersionResolver`, `BranchService`,
`CommitService`, `RevisionService`, `LifecycleService`, `ItemVersioningFacade`,
`WorkflowService`, `packages/core/src/server/routes/change-orders.ts`, and the change-order/versioning UI
(~24k lines).

**What "intent" means here**: the product's own stated promise, taken from
[`docs/features/change-management.md`](../features/change-management.md),
[`docs/features/versioning.md`](../features/versioning.md),
[`docs/architecture/eco-as-branch.md`](../architecture/eco-as-branch.md),
[`docs/features/workflow-engine.md`](../features/workflow-engine.md), the code's own comments,
and the affordances the UI actually puts in front of a user. Where those four disagree, that
disagreement is itself a finding.

**Status**: **All ten findings and the documentation drift are fixed** — see §8 for
the as-built record. §§1–7 are preserved as the findings inventory that drove the
work, written in the present tense of the code as it was.

**Relationship to prior work**: this is a fresh, current-state read, not a re-run of the
change-action-routing assessment/remediation pair or the workflow-engine remediation (all
complete and since removed from `docs/proposals/`; see git history for
`change-action-routing-assessment.md`, `change-action-routing-remediation.md`, and
`workflow-engine-remediation.md`). All of those landed their phases, and the difference shows:
every finding they closed stayed closed. This
assessment deliberately looks at what a _user_ experiences rather than at routing internals, so
it surfaces a different class of problem — mostly presentation, prediction, and three
components giving three different answers to the same question.

---

## 1. Executive summary

The core engine is sound and, in the places that matter most, genuinely well built. Release is
atomic-at-the-claim, retryable, and cannot be entered by name-sniffing a state. Branch isolation
works. Revision assignment at merge time works, including the concurrent-ECO case. Supersession
maintains one current row per master. Scope and released content are reconciled before release.
These were the hard problems and they are solved.

What is _not_ solid is the layer the user actually touches. The system is honest at the moment of
commitment and unreliable at every moment before it:

- **The system predicts the wrong revision.** Four "add to ECO" dialogs compute the target
  revision in the browser with an algorithm that returns `[` for an item at Rev Z, and has never
  heard of the numeric or prefixed-numeric schemes. That prediction is displayed, persisted, and
  on one live release path becomes the actual revision letter.
- **Three components disagree on whether an ECO can be released.** The Conflicts tab says
  "warning, proceed"; the release preview says "cannot release"; the actual gate lets it through;
  the merge then hard-refuses. A user can be told three different things and then fail anyway.
- **A documented lifecycle stage does not exist.** Branch locking on submission — described in two
  docs, with a working `lockBranch()` behind it — is never invoked. Every real release emits a
  warning about it.
- **Configurability is advertised but skin-deep.** Custom lifecycles, custom state names, and four
  revision schemes are all offered in the admin UI. Roughly two dozen live code sites still
  compare against the literals `'Released'`, `'Draft'`, and `'Approved'` — including the
  main-branch protection boundary, which is the one-way gate the whole ECO model rests on.

None of this corrupts data. All of it makes the product feel like it is guessing, and one item
(F1) can write a wrong revision letter.

**Verdict by capability:**

| #   | Capability                                    | Intent honoured?                                                  |
| --- | --------------------------------------------- | ----------------------------------------------------------------- |
| A   | Create a change order, routed by type         | Yes                                                               |
| B   | Put items in scope with a change action       | Partly — action set and target revision are mispredicted (F1, F2) |
| C   | Isolated editing on the ECO branch            | Yes                                                               |
| D   | Scope locked during review                    | Yes, but not as either doc describes (F5)                         |
| E   | Impact analysis and risk gates                | Yes, with a stale-data caveat carried forward                     |
| F   | Conflict detection and resolution             | No — three engines, three verdicts (F3)                           |
| G   | Approve → release, assign revisions           | Yes for content; preview and retry are weak (F4, F8)              |
| H   | Cancel without consuming revisions            | Yes                                                               |
| I   | Time travel, history, baselines               | Yes                                                               |
| J   | Configurable lifecycles / schemes / workflows | Partly — literals defeat it (F6, F7)                              |

---

## 2. What the product promises

Stated plainly, from the docs and the UI:

> Every engineering change gets its own branch. You put the items you intend to change into the
> change order's scope, edit working copies in isolation, and nobody sees your work until the
> change order is approved. At approval, the system merges your branch to main, assigns the next
> revision letter to each item — computed against main _as it is at that moment_, so parallel
> change orders cannot collide — supersedes the old versions, and archives the branch. Abandoned
> change orders cost nothing: no revision letters are consumed and no cleanup is needed.
> Everything is configurable in code and in the admin UI: states, transitions, approvals,
> revision schemes, per-change-type workflow routing.

That is an accurate description of the merge. It is an optimistic description of everything
leading up to it.

---

## 3. Capability by capability

### A. Create a change order, routed by type — **honoured**

`ChangeOrderService.autoStartWorkflow()` reads `workflowsByChangeType` from the ChangeOrder
runtime config and starts the matching workflow instance; ECO/ECN/MCO/Deviation can each route to
a different workflow definition, or share one. Branches are created lazily, on first affected item
or first design association, so a change order that never gets scope never creates one.

One presentation defect: `ChangeOrderDetail.tsx:76-92` maps state names to badge colours using a
table left over from an older workflow — `Submitted`, `ImpactAssessment`, `Review`,
`Implementation`, `Implemented`, `Closed`. None of those exist in the shipped workflow. The two
states that _do_ exist and matter, `InReview` and `Cancelled`, are absent from the map and fall
through to the neutral default. A cancelled change order gets the same grey badge as a draft.

### B. Put items in scope with a change action — **partly honoured**

The server is careful here. `addAffectedItem()` rejects duplicates by `masterId`, validates the
action against the item's state with `LifecycleService.canApplyAction()`, checks the ECO
workflow's `drivers` allow-list, creates the revision working copy for `revise`, and computes the
target revision for `promote` from the target phase's scheme and reset flag. `checkoutItemToEco()`
infers the action from the lifecycle's own mappings rather than from a literal state name, and
refuses when no action is configured.

The client is not careful, and the client's answer wins. See **F1** and **F2**.

`add` and `remove` remain inert by design — recorded on the change order, no effect at merge.
That is a deliberate, documented decision (routing remediation as-built note 8), not a defect,
but it does mean the UI offers a change action that does nothing. Worth surfacing in the UI rather
than leaving users to discover it.

### C. Isolated editing on the ECO branch — **honoured**

This is the strongest part of the system.

- `branchItems` overlay + `VersionResolver` gives real isolation: branch versions overlay main,
  untouched items are inherited by fallback, deletions hide the item at branch context (both in
  the list and, since the resolution fixes, on the detail page).
- Working copies carry a branch-scoped revision `-{branchId8}`
  (`RevisionService.getWorkingRevision`), so two change orders can hold a working copy of the same
  item without colliding on `(item_number, revision, design_id, item_type)`.
- `saveChanges()` creates the working copy on first save and then edits it **in place** on
  subsequent saves, keyed on `branch_items.changeType` — which is both correct and the fix for a
  latent unique-constraint violation on the second save.
- Working copies inherit the source item's outgoing relationships, so an assembly's BOM is
  editable on the branch and branch deletions survive the merge.
- Lifecycle and identity fields (`state`, `revision`, `itemNumber`) are stripped from a save
  rather than rejected, so a form echoing the whole item back cannot smuggle a state change.
- Every save is a commit with field-level diffs, including extension-table fields and — for
  Software — per-file source changes.

### D. Scope locked during review — **honoured, but not as documented**

The behaviour in code: leaving the initial state sets `scopeLocked`; returning to the initial
state clears it (so "Return to Draft" is not a trap); a locked scope refuses **new** items by
every route — the change-order service methods, and `assertBranchAcceptsNewItems()` on the branch
layer, which covers `POST /items/:id/checkout`, batch checkout, create-on-branch, and the AI
tools. Existing working copies stay editable. That is a coherent, defensible design.

It is not what either doc says. See **F5**.

### E. Impact analysis and risk gates — **honoured, with a known caveat**

`ImpactAssessmentService` runs a recursive where-used CTE with configurable depth (default 15) and
cycle prevention via a path array, joins design context for cross-design visibility, follows the
definition/usage chain, deduplicates by `masterId:depth` with an `affectedByCount`, and generates
risk records. Critical risks flagged `requiresAcknowledgement` are enforced by
`assertReleaseGates()` — which now runs on the live release path, before the release claim is
taken, so a refusal leaves nothing to clean up.

Carried forward from the prior assessment and still open: the where-used traversal reads main
only, so impact analysis of an ECO's own in-flight BOM edits is blind to them. Fixing it means
teaching the CTE a branch context. Correctly scoped as a redesign, not a repair.

### F. Conflict detection and resolution — **not honoured**

There are three independent opinions about whether a change order is releasable, and they do not
agree. See **F3**. This is the finding most likely to be experienced as the product being broken.

The detection machinery itself is good: a genuine three-way base/ours/theirs comparison, Software
manifest conflicts sharpened to per-file granularity (with disjoint-file edits correctly
downgraded from error to warning), cross-ECO detection across active change orders, and `rebase` /
`pull from main` resolution paths under `REPEATABLE READ`. The problem is not detection. It is
that nothing reconciles detection's verdict with the merge's.

### G. Approve → release, assign revisions — **honoured for content; weak on preview and retry**

The release path is the most carefully built code in the domain:

- `executeWorkflowTransition()` is the single entry point. Final-state semantics come from an
  explicit `finalKind`, never from the state's name, and a final state that declares no
  `finalKind` fails closed.
- Business gates run _before_ the release claim. The claim is a compare-and-swap with a
  15-minute staleness window. The merge runs in `beforeFinalize`, i.e. before any state write, so
  a merge failure leaves the change order in its pre-final state, fully retryable, with the claim
  released. The workflow can only reach Approved if the merge actually happened.
- `assertScopeMatchesBranchContent()` refuses to release branch content that the change order does
  not list — one-directional, correctly, since state-only actions legitimately have no branch
  content.
- Revision assignment reads main's **current** revision, not the branch base, so a change order
  that releases second gets C rather than colliding on B.
- Supersession clears `isCurrent` for whatever is currently current for the master, scoped so
  other branches' in-flight working copies are not rewritten, and applies the configured
  `revise.oldVersionState`.
- A merged branch's structure _replaces_ the released item's structure, so a BOM line deleted on
  the branch does not come back.
- The post-branch pass is keyed structurally — "whatever the branch merge did not handle" — rather
  than on an action allow-list, which is what stopped `promote` being silently dropped.

Two weaknesses remain, both about what happens around the merge rather than in it: the release
preview is unreliable and not binding (**F4**), and a multi-design release is not idempotent on
retry (**F8**).

### H. Cancel without consuming revisions — **honoured**

`cancel()` releases checkout locks and archives branches without merging. Working copies are
orphaned in place as evidence of what was attempted. `assertReleaseGates` deliberately does not
run for `finalKind: 'cancel'` — an ECO being abandoned _because_ of its conflicts must not be
trapped by them. Correct, and correctly reasoned in the code comment.

One presentation defect: the transition dialog shows a **Release Preview** for cancellation. See
**F4**.

### I. Time travel, history, baselines — **honoured**

Four version contexts (released / branch / commit / tag) with a documented precedence, commit
ancestry via recursive CTE, batch resolution that avoids N+1 for list views, per-item history with
field-level diffs, a DAG graph view with branch-column layout and commit consolidation, tags
including auto-created `eco-release` baselines, and release branches from tags. The released-query
fallbacks are now scoped so a branch draft cannot answer a released query — the right fix, since
those fallbacks bypass the commit graph by design.

One edge: `notWorkingRevision()` excludes `revision = ''`, but `getInitialRevision()` returns `''`
for the `none` scheme. An item released under `none` is therefore invisible to the released-query
fallbacks. Low impact — no shipped lifecycle uses `none` — but it means the scheme does not work.

### J. Configurable lifecycles, schemes, workflows — **partly honoured**

Genuinely configurable: states and transitions per lifecycle, `changeActionMappings` as the single
mechanism for ECO-driven state change, revision schemes at lifecycle and phase level, phase
boundaries with reset-on-entry, per-change-type workflow routing, named state approvers, the
`drivers` allow-list (enforced at intake _and_ at merge), and flexible per-instance workflows with
user-added review steps. State identity is IDs throughout, and mappings that name a non-existent
state are rejected at save.

Undermined by roughly two dozen literal state comparisons in live code (**F6**) and by a UI action
menu that only knows the seeded state names (**F2**). And one advertised knob does not exist for
the workflow most users will use: **F7**.

---

## 4. Findings

Ranked by user impact. "Reachable" means a user can hit it through the shipped UI without
special configuration.

### F1 — The system predicts, persists, and can assign the wrong revision letter

**Severity: high. Reachable.**

`packages/core/src/components/change-orders/eco-helpers.ts` computes the target revision in the browser:

```ts
export function incrementRevision(rev: string): string {
  if (/^[A-Z]$/.test(rev)) {
    return String.fromCharCode(rev.charCodeAt(0) + 1)   // 'Z' -> '['
  }
  ...
  return `${rev}.1`                                      // '3' -> '3.1'
}
```

This has no idea about `Z -> AA`, and no idea that `numeric`, `prefixed-numeric`, and `none`
schemes exist. `RevisionService` — the server's single authority — handles all four correctly.

The wrong value does not stay in the browser. All four "add to ECO" dialogs
(`AddToEcoDialog:56`, `BatchAddToEcoDialog:71`, `AddPartFromDesignDialog:331`,
`ParentPropagationDialog:128`) POST it as `targetRevision`. The route
(`packages/core/src/server/routes/change-orders.ts:346`) passes the request body straight through with no
schema validation. `ChangeOrderService.addAffectedItem:253` then prefers the client's value over
its own computation:

```ts
targetRevision = item.targetRevision || RevisionService.getNextRevision(...)
```

It is stored on `change_order_affected_items` and displayed in the Affected Items list. On the
`revise`-without-a-working-copy path — a branchless change order, or an item listed as `revise`
but never checked out — it becomes the real revision:

```ts
// ChangeOrderMergeService.ts:751
const targetRevision =
  affected.targetRevision ||
  RevisionService.getNextRevision(item.revision, reviseFallbackScheme)
const newRev = await ItemService.revise(
  affected.affectedItemId,
  targetRevision,
  userId,
)
```

So: an item at Rev Z, added as `revise` and released without ever being checked out, is released
as **Rev `[`**. Under a numeric scheme, an item at `3` is released as `3.1`. The normal
working-copy path recomputes from main and is unaffected — but the _displayed_ prediction is wrong
in every case, on every scheme except single-letter alpha below Z.

**Fix**: delete `incrementRevision`/`getTargetInfo` from `eco-helpers.ts`; have the dialogs
display a server-computed preview; make `targetRevision` server-authoritative (drop the client
value, or validate it) and add a Zod schema to the affected-items route. The route accepting an
unvalidated body is the enabling defect and worth fixing on its own — `targetState`,
`currentState`, `newItemData`, and `newItemType` are equally unvalidated.

### F2 — The change-action menu only knows the seeded state names, and never offers `promote`

**Severity: medium. Reachable.**

`eco-helpers.getAvailableActions()` is a literal `if (state === 'Draft') / 'Released' / 'InReview'`
chain. Its header comment is honest about being presentation-only, and the server does validate —
so this can never _cause_ an invalid action. But the consequence is that a custom lifecycle whose
released state is named `Production` shows an **empty action list**, and the user cannot add the
item to a change order at all through this dialog.

Separately, `promote` is never offered by `getAvailableActions()` on any state, even when the
lifecycle configures it and `LifecycleService.getValidActions()` would return it. `getTargetInfo`
handles `promote`, so the omission looks like an oversight rather than a decision. Phase
promotion is a headline lifecycle feature that is unreachable from the primary UI.

**Fix**: both dialogs already talk to the server; call
`GET .../items/:id/valid-actions` (`ChangeOrderService.getValidActionsForItem` already exists and
is lifecycle-driven) instead of guessing client-side.

### F3 — Three components give three different answers about releasability

**Severity: high. Reachable.**

For a `concurrent_modification` — main advanced on an item this change order also changed:

| Component                  | Verdict                                                                  | Where                                |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| `ConflictDetectionService` | `severity: 'warning'` — Conflicts tab shows amber, suggests rebase       | `ConflictDetectionService.ts:379`    |
| `assertReleaseGates`       | **passes** — only blocks `severity === 'error'`                          | `ChangeOrderService.ts:1317`         |
| `previewMerge`             | `canRelease: false` — counts every non-`no_changes` conflict as blocking | `ChangeOrderMergeService.ts:2306`    |
| `merge` → `validateMerge`  | **hard refusal**, `MergeConflictError`                                   | `ChangeOrderMergeService.ts:376-390` |

The user journey: the Conflicts tab shows a yellow warning and a suggestion. The release gate lets
the transition start. The merge throws. The change order stays pre-final (correctly — the claim
protocol works), and the user is left with a hard error for something the UI called a warning.

`docs/features/versioning.md:358` states: _"Warning-severity conflicts can be acknowledged by an
authorized user to proceed."_ They cannot. `ConflictReviewService` exists, has routes and UI, and
records `conflictReviews` rows — but nothing in `merge()`, `assertReleaseGates()`, or
`validateMerge()` ever reads them. "Mark as reviewed" is a private annotation with no effect on
anything.

Compounding it, the two engines detect different things. `validateMerge` compares
extension-table fields **and BOM structure** (`hasExtensionOrStructureChanges`);
`detectConflictsForBranch` compares the item row and type-specific fields but **not BOM
structure**. So a BOM-only divergence on main is invisible in the Conflicts tab and fatal at
merge — the user gets no warning at all before the failure.

This is partly a consequence of a deliberate choice (routing remediation as-built note 2:
refusing sequential same-item ECOs is better than two current rows). The choice is right; it just
was not carried into the two layers that report to the user.

**Fix**: pick one authority. Either promote `concurrent_modification` to `error` in detection so
the Conflicts tab, the preview, and the gate all agree and the user is told to rebase before
approving; or make acknowledgement real by having `validateMerge` consult `conflictReviews` for a
matching signature. Also teach `detectConflictsForBranch` about BOM structure so both engines see
the same facts. The first option is smaller and matches what the merge already enforces.

### F4 — The release preview is wrong for cancellation and non-binding for release

**Severity: medium. Reachable.**

`WorkflowTransitionDialog.tsx` gates the preview on `isFinal`, not `finalKind`:

```ts
const isFinalStateTransition = selectedTargetState?.isFinal === true
```

`finalKind` is on `WorkflowState` and available in the component. So selecting **Cancel** — which
merges nothing by design — fetches and renders a "Release Preview" panel announcing
_"N design(s), N item(s) will be merged to main"_ with a list of revision assignments. Alarming
and false. One-line fix.

Second: when the preview reports `canRelease: false` and lists validation issues in red, the
Confirm button is still enabled (`WorkflowTransitionDialog.tsx:359` gates only on
`selectedTransition.canTransition`). The preview is decoration. Combined with F3, the user is shown
a red "cannot release", clicks Confirm anyway because nothing stops them, and gets an error.

### F5 — Branch locking on submission is documented in two places and implemented in none

**Severity: medium.**

`docs/architecture/eco-as-branch.md:141-147` describes an entire lifecycle phase:

> **Phase 3: Submission (Branch Locking)** — When the ECO transitions to "Submitted for Approval"
> via the workflow: `BranchService.lockBranch(branchId)` sets `branches.isLocked = true`;
> `CommitService.create()` checks the lock and rejects new commits; Users can still view changes
> but cannot edit.

`docs/features/versioning.md:283-290` repeats it as the branch lifecycle diagram
(`Created → Locked → Merged/Archived`) with _"Locked branches prevent further commits while the
ECO is in review."_

`BranchService.lockBranch()` exists and works. `CommitService:181` does check the lock.
`CheckoutService`, `createOnBranch`, `deleteOnBranch`, and `updateHead` all check it. Everything
is wired. Nothing calls it: the only caller in the codebase is a manual
`PATCH /api/v1/branches/:id { isLocked: true }`. No workflow transition, no submission, no
`ChangeOrderService` path ever locks an ECO branch.

The user-visible consequence is a warning on **every** real release, since `validateMerge` checks
for exactly this:

```ts
// ChangeOrderMergeService.ts:1970
if (!branch.isLocked) {
  warnings.push('Branch is not locked - consider locking before merge')
}
```

That warning surfaces in the release preview's `validationIssues` for every change order ever
released, training users to ignore the panel that also carries real problems.

Worse, the two docs contradict each other. The architecture doc says review freezes editing; the
change-management doc says _"Existing working copies can still be edited while scope is
locked... the lock freezes what the change is, not the work on it."_ The code implements the
second. That is the better design — but it means the architecture doc describes a product that
does not exist and the release path warns about not being that product.

**Fix**: decide. If scope-lock-only is the intent (it should be — it is the better design and it
is what shipped), delete Phase 3 from the architecture doc, correct the branch-lifecycle diagram
in `versioning.md`, and drop the `validateMerge` warning. If branch locking is wanted, wire it to
the scope-lock transition and reconcile with the "editing continues" promise.

### F6 — Configurable lifecycles are defeated by literal state names in live code

**Severity: medium.**

The prior remediation's Phase 6 (C-8) landed "partial", and this is the residue. The literals
are not evenly distributed — some are harmless fallbacks (`targetState || 'Released'`), but
several are load-bearing:

| Site                                                            | Consequence if the released state is named anything else                                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BranchService.ts:591` `isMainBranchProtected`                  | **Main never becomes protected.** The one-way gate that forces all changes through ECOs never closes; released items stay directly editable on main. |
| `ChangeOrderService.ts:246`                                     | No revision working copy is created for `revise`, so the change order silently falls back to the legacy no-working-copy path at merge.               |
| `CheckoutService.ts:744`                                        | First save on a branch does not reset the working copy to the lifecycle's initial state.                                                             |
| `VersionResolver.ts:210`                                        | The released-version fallback cannot find the item.                                                                                                  |
| `ChangeOrderMergeService.ts:2310`, `ChangeOrderService.ts:2109` | `canRelease` is false forever, so the preview and the ECO dashboard never say the change order is releasable.                                        |
| `ChangeOrderService.ts:1152`, `:1163`, `:1225`                  | `validateRelease` / `validateObsolescence` mis-validate. (Both are also dead code — see the companion document.)                                     |
| `ai/tools/write-handlers.ts:374`, `:844`                        | The AI assistant infers the wrong change action.                                                                                                     |
| `server/routes/items.ts:582`, `:1851`                           | Checkout-required signalling is wrong.                                                                                                               |

`isMainBranchProtected` is the serious one: it is the boundary the entire ECO-as-branch model
rests on, and it is keyed to a string. It should read the lifecycle's `release`/`revise` mappings
to learn which states count as released, the way `inferChangeAction` already does.

`ItemVersioningFacade.ts:533` and `:545` hold `['Approved','Released']` and `['Draft','InReview']`
lists, but both methods are dead in production (tests only) — delete rather than fix.

### F7 — "N approvals required" is not configurable on the workflow most users will use

**Severity: low-medium.**

`ApprovalRequirement.requiredCount` is enforced for **instance-level** (flexible) workflows only
(`WorkflowService.ts:1428`). For definition-level workflows — including the shipped ECO workflow —
the transition path passes a hard-coded `{ requiredCount: 0 }` (`WorkflowService.ts:1485`), and
the per-transition knob was deliberately removed from `WorkflowTransition`
(`types.ts:138`). Gating therefore comes only from named state approvers, and when a state has no
named approvers, `areApprovalsComplete` returns complete — anyone with `change_orders:update` can
approve.

This is a coherent design (named approvers for fixed workflows, counts for flexible ones) and it
does not fail open in the old dangerous sense — `checkApprovalRequirement` fails **closed** on a
verification error, which is right. But "require two approvals on this transition" is a normal PLM
expectation, and the answer for the standard ECO workflow is "configure named approvers or switch
to a flexible workflow." That should be stated in `workflow-engine.md`, or the knob should be
restored for definition-level transitions.

### F8 — A multi-design release is not idempotent on retry

**Severity: medium, low likelihood. Carried forward.**

`ChangeOrderMergeService.merge():362` loops over every `changeOrderDesigns` row with a branch and
merges each, with no guard on `mergeStatus`:

```ts
const designsWithBranches = ecoDesigns.filter((d) => d.branchId)
for (const ecoDesign of designsWithBranches) { ... await this.mergeBranchToMain(...) }
```

If design A merges and design B then fails, the claim protocol correctly leaves the change order
pre-final and retryable — and the retry re-merges design A, bumping its revisions a second time.
`mergeStatus` is written to `'merged'` per design but never read on entry.

A one-line guard (`if (ecoDesign.mergeStatus === 'merged') continue`) closes the common case
cheaply and is worth doing now even though the deeper fix is transaction threading. Known and
documented as open in the routing remediation (§5, B9 sibling); calling it out again because it is
the one open item with a genuinely cheap partial mitigation.

Related and still open: the branchless release path's `db.transaction` at
`ChangeOrderMergeService.ts:495` carries a comment promising all-or-nothing semantics, but its
nested `ItemService.update()`, `CommitService.create()`, and `BranchService.archiveBranch()` calls
go through the global `db` handle and open their own pooled transactions. The comment is a claim
the code does not honour; at minimum it should be corrected to say so, as `addAffectedItemsBatch`'s
was in `change-management.md`.

### F9 — The `itemsAffected` counter only ever goes up

**Severity: low. Reachable.**

`ensureDesignAssociation()` and `checkoutItemToEco()` increment
`changeOrderDesigns.itemsAffected` (`ChangeOrderService.ts:382`, `:2006`). `removeAffectedItem()`
never decrements it. The count is displayed as "N items affected" in `EcoSummaryDashboard:205` and
`EcoDesignStructureTree:398`, so add-then-remove leaves a permanently inflated number. The counter
is also incremented outside any transaction covering the insert that follows it, so a failed add
inflates it too.

The value is derivable — `getEcoSummary` already counts `branchItems` by `changeType` in the same
loop. Deriving it and dropping the column removes the class of bug.

### F10 — Presentation defects that misinform

**Severity: low. Reachable.**

- **Stale state-colour map** — `ChangeOrderDetail.tsx:76-92`, described in §3A. `InReview` and
  `Cancelled` render neutral.
- **Edit and Delete gated on the literal `'Draft'`** — `ChangeOrderDetail.tsx:482`. A workflow
  whose initial state is named `Proposed` yields a change order that cannot be edited or deleted
  through the UI at all.
- **Transition buttons styled by substring-matching the transition name** —
  `WorkflowTransitionActions.tsx:118-165` (`name.includes('approve')`,
  `toStateId.includes('cancel')`). Purely cosmetic — the dangerous version of this pattern was
  removed from the release path — but it is the same reflex, and `finalKind` is right there. A
  transition named "Accept" gets a neutral grey button; one named "Cancel review" gets a
  destructive red one.
- **All transition buttons open the same dialog** — every button calls
  `setIsDialogOpen(true)` without preselecting its own transition, so with more than one available
  transition the user picks again inside the dialog. Clicking "Approve" does not preselect
  Approve.

---

## 5. Documentation drift

Cheap to fix, and each one currently teaches something false.

| Doc                                                | Claim                                                          | Reality                                                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `architecture/eco-as-branch.md:141-147`            | Phase 3 locks the branch on submission                         | Never happens (**F5**)                                                                                                                       |
| `architecture/eco-as-branch.md:325-329`            | At merge, differing fields "auto-merge (JSON merge)"           | No auto-merge exists. `validateMerge` refuses; `rebaseItem`/`pullChangesFromMain` are separate user-invoked operations                       |
| `architecture/eco-as-branch.md:118`, `:264`        | Working copies carry `revision = 'DRAFT'`                      | Branch-scoped `-{branchId8}` since the revision-marker work                                                                                  |
| `features/versioning.md:283-290`                   | Branch lifecycle includes a Locked stage                       | Never entered (**F5**)                                                                                                                       |
| `features/versioning.md:358`                       | Warning conflicts can be acknowledged to proceed               | Acknowledgement has no effect anywhere (**F3**)                                                                                              |
| `features/versioning.md:118-120`                   | Example table shows Rev B **and** Rev C both `isCurrent: true` | Contradicts the paragraph below it and the code's one-current-row invariant                                                                  |
| `features/versioning.md:513` (merge step 3)        | Deleted items are marked `isCurrent: false`, state Obsolete    | Code sets state + `isDeleted: true` and removes the main `branchItem` row; `isCurrent` is untouched (`ChangeOrderMergeService.ts:1578-1600`) |
| `features/change-management.md:349`                | `saveChanges` creates a new row with `revision = 'DRAFT'`      | Branch placeholder on first save; **in-place update** on later saves                                                                         |
| `features/change-management.md:512`                | Vault files copied via `FileService.copyFilesToNewVersion()`   | Method does not exist; the merge calls `FileService.promoteFilesToMain(branchId)`                                                            |
| `features/change-management.md` (ECO Cancellation) | Cancellation transitions to `Rejected`                         | The shipped workflow's cancel state is `Cancelled`; semantics come from `finalKind`, not the name                                            |

---

## 6. What is genuinely solid

Worth recording, both to avoid re-litigating it and because it sets the bar the rest should meet:

1. **The release interlock.** Gates before the claim, claim as compare-and-swap with staleness
   recovery, merge inside `beforeFinalize` so no state is written unless it succeeded, claim
   released on failure, claim-holders exempted from the CAS that would otherwise deadlock them.
   The reasoning is in the code comments and it is correct.
2. **`finalKind` instead of name-sniffing**, failing closed when undeclared.
3. **Revision assignment against main's current version**, which is what makes parallel change
   orders actually safe.
4. **Supersession scoped to currently-current rows**, so parallel branches' in-flight working
   copies are not corrupted.
5. **Scope/content reconciliation** before release, one-directional for the right reason.
6. **The structural post-branch pass** — "whatever the branch merge did not handle" — instead of an
   action allow-list.
7. **Branch structure replaces released structure**, so branch deletions survive the merge.
8. **`RevisionService` as the single authority** on the working-revision marker, with writer and
   predicate agreeing, plus a SQL counterpart (`notWorkingRevision()`) for query paths.
9. **Fail-closed approval verification.**
10. **Type-specific data copied on revision** for every item type including WorkInstruction
    sub-tables and Software manifests.

The code comments throughout this domain are unusually good: they explain _why_, name the bug the
current shape prevents, and record decisions rather than restating the code. That is a large part
of why this assessment could be specific.

---

## 7. Recommended order

Sequenced by user impact per unit of change, not by architectural tidiness.

| #   | Work                                                                                                                                                                                  | Findings | Size     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- |
| 1   | Server-authoritative revision prediction: delete client `incrementRevision`/`getTargetInfo`, add a Zod schema to the affected-items route, drop client `targetRevision`               | F1       | S        |
| 2   | Dialogs read valid actions from the server (`getValidActionsForItem`)                                                                                                                 | F2       | S        |
| 3   | Preview honesty: gate on `finalKind` not `isFinal`; disable Confirm when `canRelease` is false                                                                                        | F4       | XS       |
| 4   | Reconcile conflict verdicts — promote `concurrent_modification` to `error`, teach detection about BOM structure, and either honour `conflictReviews` or delete the acknowledgement UI | F3       | M        |
| 5   | Decide and document branch locking; remove the always-fires warning                                                                                                                   | F5       | XS + doc |
| 6   | `mergeStatus` guard on the per-design merge loop                                                                                                                                      | F8       | XS       |
| 7   | Make `isMainBranchProtected` lifecycle-driven; sweep the remaining load-bearing literals                                                                                              | F6       | M        |
| 8   | Derive `itemsAffected`; drop the column                                                                                                                                               | F9       | S        |
| 9   | Presentation sweep: state badges from lifecycle config, `finalKind`-driven button styling, preselect the clicked transition, un-gate Edit/Delete from `'Draft'`                       | F10      | S        |
| 10  | Documentation drift table                                                                                                                                                             | §5       | S        |

Items 1–3 and 5–6 are small, independent, and together remove almost all of the "the product is
guessing" feel. Item 4 is the one that needs a decision before code.

See the companion document,
[`change-order-versioning-lifecycle-simplification.md`](./change-order-versioning-lifecycle-simplification.md),
for structural and volume reduction in the same code.

---

## 8. As-built record

All findings addressed. Verified with `npm run lint` (0 warnings), `tsc --noEmit`
(0 errors), the full unit suite (1,468 passing, 10 new), and `openapi:check`.

| Finding | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1**  | `LifecycleService.resolveActionTarget()` is now the single authority for an action's target state and revision. `addAffectedItem` resolves both server-side and ignores the caller; the affected-items route validates its body against a Zod schema with no target fields; the merge's no-working-copy `revise` path recomputes rather than reading the stored prediction; `eco-helpers.ts` is deleted. `ChangeOrderMergeService.resolvePromote` now delegates to the same resolver, removing the duplicate.                                                                                                               |
| **F2**  | New `POST /:id/affected-items/preview` returns the valid actions per item with server-resolved targets, plus a `blockedReason`. All four intake dialogs read it via `changeActionOptionsQuery`. `promote` is offered wherever the lifecycle configures it.                                                                                                                                                                                                                                                                                                                                                                  |
| **F3**  | One verdict across all four components. `concurrent_modification` is now `error` (matching what the merge enforces); `checkout` is a `warning` in both engines, since the release auto-checks-in first — that divergence made every ECO with a held checkout unreleasable, and had never been caught because the merge tests bypass the gate. Detection compares BOM structure through the same `bomStructureOf()` comparator the merge uses, so a BOM-only divergence is no longer invisible until it fails. `validateMerge` keys on `conflictType` rather than the reason text.                                           |
| **F4**  | The transition dialog gates the release preview on `finalKind === 'release'`, so cancelling no longer shows "N item(s) will be merged to main"; a cancel shows what abandoning actually does. Confirm is disabled while the preview says `canRelease: false`.                                                                                                                                                                                                                                                                                                                                                               |
| **F5**  | Settled as scope-lock-only, which is what shipped and is the better design. The always-fires `validateMerge` warning is gone; `eco-as-branch.md` Phase 3 and `versioning.md`'s branch-lifecycle diagram now describe scope locking and say plainly that nothing in the workflow locks a branch.                                                                                                                                                                                                                                                                                                                             |
| **F6**  | `isMainBranchProtected` resolves released states from each present item type's lifecycle (`release.toState` / `revise.newVersionState`). `canRelease` in both `previewMerge` and `getEcoSummary` now asks `ChangeOrderService.canReachRelease()` — a reachable `finalKind: 'release'` transition — instead of comparing against `'Approved'`. The working-copy and first-save resets key on the revise mapping's `fromState`; `createOnBranch` takes the lifecycle's initial state; the AI tool and both `items.ts` checkout sites infer through the lifecycle. The dead helpers holding hardcoded state lists are deleted. |
| **F7**  | `approvalRequirement.requiredCount` restored on definition-level transitions, enforced in both `transition()` and the availability preview, and editable in the lifecycle editor's transition panel. Composes with named approvers as before.                                                                                                                                                                                                                                                                                                                                                                               |
| **F8**  | The per-design merge loop skips a design already marked `merged`, so a retry after a partial failure cannot double-bump revisions. The affected-items path's transaction comment now states what it actually guarantees instead of claiming atomicity it does not have.                                                                                                                                                                                                                                                                                                                                                     |
| **F9**  | `changeOrderDesigns.itemsAffected` is dropped. Both consumers derive the count from the affected-items rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **F10** | `ChangeOrderDetail` renders state through `StateBadge` (which now prefers the lifecycle's configured colour) and gates Edit/Delete on the workflow not being final. Transition buttons are styled from `finalKind`/`isInitial` rather than substring-matching the transition name, and clicking one preselects it in the dialog.                                                                                                                                                                                                                                                                                            |
| **§5**  | All eleven drift items corrected across `eco-as-branch.md`, `versioning.md`, `change-management.md`, and `workflow-engine.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**Found and fixed in passing**: `autoStartWorkflow` typed its `changeType`
parameter as a four-value literal union that omitted `XCO`, while the creation
form, the admin config and `RuntimeItemTypeConfig` all offer it; it now takes
`ChangeOrderType`.

**New tests** (all invariant-shaped, per the three-gate rule):

- release is idempotent across designs — a retry does not re-release a merged one
- the merge recomputes the revision and never uses a stale stored prediction
- `resolveActionTarget` honours numeric/prefixed schemes, rolls `Z → AA`, targets
  `revise.newVersionState`, resets on a phase boundary that says so, and returns
  null for membership actions (six cases)
- a BOM-only divergence on main is reported, and blocks

### The three carried-forward items — now closed

**Merge atomicity.** A `withTx(tx, fn)` helper in `packages/core/src/lib/db/` lets a service
join its caller's transaction instead of opening its own, and `ItemService.update`
/ `.revise`, `BranchService.archiveBranch`, `CommitService.createMergeCommit` and
`FileService.promoteFilesToMain` now take one. Each design's release is one
serializable transaction — item versions, BOM structure, cross-design references,
the merge commit, file promotion, branch archival, and the `mergeStatus` that
records it. That last one matters most: the retry guard trusts `mergeStatus` to
know a design is done, so it has to commit with the release it describes. Both
affected-item passes are genuinely transactional now (one of them previously had
no transaction at all; the other had a decorative one). Outbound side effects —
the work-instruction alert job, derived-MBOM notification — moved after commit,
since a queue publish cannot be rolled back.

Deliberately **not** one transaction across all designs: that would hold
serializable locks over N designs and a network call, and the `mergeStatus` guard
already makes a cross-design retry safe.

> **This fix cannot be covered by a test, and that is why it survived.**
> `TestDatabase` injects its gate transaction as the global `db` and caps the
> pool at one connection, so a service that ignores the caller's `tx` and opens
> its own still lands on the same connection, as a savepoint nested inside the
> caller's, and rolls back with it. Ignoring `tx` looks perfectly atomic under
> test and is not atomic at all in production. Two tests were written for this
> and deleted after they were shown to pass with the fix reverted; the
> limitation is documented on `withTx` instead. Review this by reading the call
> chain, not by trusting a green suite.

**Impact analysis branch context.** `findWhereUsed` and `findAncestorChain` take
an optional `branchIds`, and build a `resolved_items` CTE that overlays each
branch's version of every master it changed on top of main's current versions,
minus the masters it deleted. The traversal joins that instead of
`items ... is_current = true`. `analyzeImpact` passes the change order's own
branches, as does the ancestors endpoint behind the parent-propagation dialog —
so a parent added to an assembly on the branch is now a parent the user is asked
about. Four tests, verified to fail with the overlay reverted.

(One trap worth recording: drizzle's `sql` template expands a JS array into a
_parameter list_, `($1, $2)`, not an array literal, so `${ids}::uuid[]` is a
syntax error at the database. `uuidArray()` builds the `ARRAY[...]` constructor
explicitly, one bound parameter per element.)

**`add`/`remove` retired.** Both are gone from `ChangeAction`. They had two
producers, both meaning "this item is new", and being inert had real
consequences: an item created on a workspace and converted to a change order was
recorded as `add` and then silently never released. Both producers now use
`release`. BOM membership was never actually theirs — it is edited on the branch
via `POST /:id/bom-changes` and released when the branch merges, because the
merge replaces the released item's structure with the branch's. Rows written
before the retirement keep their stored action; every release loop skips an
action it does not recognise, leaving them as inert as they already were rather
than failing a release.

This also closed a regression from the F2 work: `getChangeActionOptions` derives
its list from `LifecycleService.getValidActions`, which used to prepend
`['add', 'remove']` unconditionally — so the intake dialogs had started offering
two actions that did nothing.

**Still open**, and genuinely larger than this pass:

- Transaction atomicity across the _whole_ change order rather than per design.
  Deliberate, per above.
- Workspace-to-ECO conversion still does not move branch content between
  branches (the prior remediation's A6), so a workspace item reaches the change
  order as an affected item with no branch content. It is now released rather
  than dropped, but its workspace edits are not carried over.
- `notDeleted()` still erases deleted items from history reads (the prior
  remediation's C5, e.g. `CommitService.ts`). The commit-graph mechanism
  already handles deletions correctly; removing the row-level filter needs
  care about every caller.
