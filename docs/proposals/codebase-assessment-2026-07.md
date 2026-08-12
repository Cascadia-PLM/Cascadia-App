# Codebase Assessment — July 2026

**Status:** Findings inventory. No fixes applied in this document's branch.
**Scope:** Whole-repo health check — backend, frontend, tests, CI, docs. The
change-order/versioning/lifecycle domain is deliberately summarized only, since
PR #52 (`change-order-versioning-lifecycle-assessment.md`) covers it in depth.

## Verification baseline

All quality gates were run locally at `9c9a187` (current `main`):

| Gate                            | Result                                |
| ------------------------------- | ------------------------------------- |
| `npm run lint` (max-warnings 0) | ✅ clean                              |
| `npm run build`                 | ✅ clean                              |
| `npm run typecheck:strict`      | ✅ 0 errors                           |
| `npm run test` (real Postgres)  | ✅ 1,513/1,513 across 58 files (~91s) |

So despite what the Actions tab shows (see below), the code on `main` is green.

---

## 0. Urgent: CI has been dead since 2026-07-31 00:24 UTC

Every CI run since PR #49 — including three merges to `main` — shows all jobs
failing within ~3 seconds. Inspection of the failing jobs shows `runner_id: 0`
and **zero executed steps**: a runner was never assigned. This is not a code
failure; it is the signature of exhausted GitHub Actions minutes (or a
billing/spending-limit block) on a Free-plan private repo — and it began at the
end of the billing month.

Because checks are advisory on this plan, four PRs merged with no CI at all.
(All gates verified green locally, so nothing broken actually landed — this
time.)

**Action:** check the org's Actions usage/billing at
https://github.com/organizations/Cascadia-PLM/settings/billing. Options, in
rough order of preference:

1. Raise the spending limit or upgrade to Team (which also unlocks the branch
   protection CLAUDE.md already wants).
2. Cut CI spend: add `cache: 'npm'` to all 7 jobs (currently none cache — cold
   `npm ci` seven times per push), add `needs: [lint]` to `e2e-tests` (the
   slowest job currently starts unconditionally), and run only `@tier1` E2E on
   PRs.
3. Self-hosted runner as a fallback.

---

## 1. Security — authorization gaps on API routes

> **Fixed (2026-08-01).** Batch create/update/delete now gate every distinct
> item type up front (before any row is written, so a denied batch cannot
> half-apply); `bypassBranchProtection` and lock-stealing (`force`) require
> `system:manage`; the two drifted itemType→resource maps were consolidated
> (between them, Tool/TestPlan/TestCase/WorkOrder mutations skipped the
> check entirely); typed reads on `GET /api/items` and `/search` require the
> type's read permission and autocomplete filters to readable types; and
> `GET /api/files`, `/api/reports/*`, `GET /api/workflows`, and
> `POST`/`GET /api/workspaces` gained their missing gates. Invariants pinned
> in `packages/core/src/server/routes/items.permissions.test.ts`. Batch checkin/checkout
> intentionally keep `requireBranchAccess`-only, matching their single-item
> siblings.

The single most important code finding. The batch endpoints in
`packages/core/src/server/routes/items.ts` bypass the permission model that their
single-item siblings enforce:

| Endpoint                     | Site           | Guard                                 |
| ---------------------------- | -------------- | ------------------------------------- |
| `POST /items/batch-create`   | `items.ts:662` | none                                  |
| `POST /items/batch-delete`   | `items.ts:744` | none — not even `requireBranchAccess` |
| `POST /items/batch-update`   | `items.ts:831` | none                                  |
| `POST /items/batch-checkin`  | `items.ts:452` | `requireBranchAccess` only            |
| `POST /items/batch-checkout` | `items.ts:539` | `requireBranchAccess` only            |

By contrast `POST /api/items` checks `requirePermission(request, resourceType,
'create')` at `items.ts:1196` (update `:1411`, delete `:1533`). As written, any
authenticated user — including a read-only role — can batch-delete up to 100
items. Additionally, `batch-create` accepts a **client-supplied**
`bypassBranchProtection` flag (`packages/core/src/lib/api/schemas.ts:403`, consumed at
`items.ts:673`) with no role check, allowing direct writes to protected `main`.

Other routes missing permission gates (each has a correctly-gated sibling
nearby, so this is drift, not a design decision):

- `GET /api/files` (`files.ts:305`) — lists the entire vault, no permission, no
  design/program scoping.
- `GET /api/items` (`items.ts:978`) and `GET /api/items/search`
  (`items.ts:376`) — no permission, while `parts.ts:43` uses
  `['parts','read']`.
- `GET`/`POST /api/reports` (`reports.ts:16,41`) — `reports` is a declared
  `ResourceType` that is never checked here.
- `GET /api/workflows` (`workflows.ts:16`) — no permission; `POST` in the same
  file has one.
- `POST /api/workspaces` (`workspaces.ts:38`) — creates a branch on any
  `designId` with no design-access check; `GET /:id` (`:64`) has no ownership
  check.

**Action:** one focused PR adding `requirePermission` to the batch loops,
gating `bypassBranchProtection` on role, and adding the missing `permission:`
options above. Follow with tests — this passes gate 2 of the three-gate rule
by definition.

## 2. Data integrity — merge/workflow transaction hygiene

> **Post-merge note (PR #52, merged 2026-07-31 after this assessment was
> written):** the release path was substantially restructured — `merge()` was
> split into named phases, and a `withTx` helper now threads one serializable
> transaction per design through item versions, cross-design references, the
> merge commit, file promotion, branch archival, and `mergeStatus` (whose
> retry guard makes the per-design loop resumable). Items 1–3 below describe
> the pre-#52 code and should be re-verified against the new shape before
> acting on them. Item 4 (`WorkflowService.transition`) still stands —
> re-checked post-merge, the file still contains no `db.transaction`.

The concurrency work in the merge path is genuinely good (CAS, serializable
isolation, `withSerializableRetry`), but four specific holes remain:

1. **Retry double-counting.** In `ChangeOrderMergeService.mergeBranchToMain`,
   the accumulators (`revisionsAssigned`, `itemChanges`, `itemIdMapping`,
   merge counters) are declared at `ChangeOrderMergeService.ts:1237-1256` —
   _outside_ the `withSerializableRetry(() => db.transaction(...))` at
   `:1312` — but mutated inside it. A 40001 serialization retry (the exact
   event the wrapper exists for) re-runs the closure without resetting them,
   producing a merge commit with duplicated `itemChanges` and inflated counts.
   `CommitService.createMergeCommit` (`CommitService.ts:310`) shows the correct
   shape. **One-scope fix; do this first.**
2. **Unprotected post-transaction steps.** After the merge transaction closes
   (`:1715`), cross-design reference merge (`:1721`), merge-commit creation
   (`:1726`), file promotion (`:1740`), and branch archival (`:1783`) run as
   separate auto-commits. A failure in `createMergeCommit` leaves items
   released with no commit recording the merge.
3. **Multi-design ECO merge is not atomic.** `merge()` loops
   `mergeBranchToMain` per design (`:361-461`); failure on design 3 of 5
   leaves designs 1–2 released and the ECO non-final, with no rollback or
   resume. A `mergeStatus` state machine with a resume path would fix this
   without nesting transactions.
4. **`WorkflowService.transition` spans five writes with zero transactions**
   (`WorkflowService.ts:1351-1727`; the file has no `db.transaction` in 2,038
   lines). The CAS closes the concurrency half, but a mid-sequence failure
   leaves `workflowInstances.currentState` and `items.state` divergent. Note
   the workflow-engine remediation record (removed from `docs/proposals/`;
   see git history for `workflow-engine-remediation.md`) claimed all phases
   done — F2's transaction requirement only half-landed.

Also: `CheckoutService.checkout` inserts the `branchItems` row (`:404`) and
registers the branch change on the ECO (`:419`) as two unwrapped statements;
failure of the second later hard-blocks the merge via
`assertScopeMatchesBranchContent`.

## 3. Frontend — the query-layer migration stopped at the route boundary

The route and query layers are in excellent shape: all 62 loaders prime via
`ensureQueryData`, zero `useLoaderData` reads, zero `refreshTrigger` counters,
query keys ~100% through `qk` factories. But the component layer never
migrated:

- **78 component files** fetch imperatively via `useEffect` + `useState` with
  no `useQuery`; only 30 of 349 components use `useQuery` at all.
- **~46 mutating components never call `invalidate()`** — writes land while the
  shared cache the routes primed goes stale. This is a live staleness bug
  class, not style. Canonical example: `WorkflowStatusPanel.tsx:76-115`
  refreshes its private state after a transition while the ECO route's cache
  stays stale.
- `packages/core/src/routes/lifecycles/$id.tsx` is the one route fully outside the pattern
  (no loader, `useEffect` fetch at `:47`).
- `packages/core/src/routes/profile.tsx:14-29` is an outright bug: a transient network error
  in `beforeLoad`'s bare catch redirects to `/login` — a blip logs users out.
- 118 raw `fetch()` calls (44% of client HTTP) bypass `apiFetch`; 121 silent
  `catch {}` blocks render blank UI instead of errors.
- God-components to split, using the already-correct
  `PartRelationshipsPanel.tsx` as the template: `PartDetail.tsx` (1,706 lines,
  24 `useState`, 0 `useQuery`), `StructureTab.tsx` (1,318),
  `AddPartFromDesignDialog.tsx` (1,063), `SourceViewer.tsx` (1,019).

## 4. Test coverage — quality is excellent, placement has holes

The suite is unusually disciplined: `toHaveBeenCalled` appears **zero** times
in 58 test files, only 2 files use `vi.mock`, 35 run against real Postgres,
names read as invariants. The gaps are all at the high-value end of the
three-gate rule:

- **Gate 2 (security), zero coverage:** `packages/core/src/lib/auth/permission-service.ts`
  (cached permission resolution — nothing tests cache invalidation after a
  role change), `credentials.ts` (the single identity funnel for both auth
  methods), `api-key-utils.ts` (`intersectPermissions` — a privilege-reduction
  algorithm), `session.ts`, `password.ts` (legacy-hash migration branch).
- **Gate 1 (data integrity):** `ItemVersioningFacade.ts` (548 lines — this _is_
  the checkout/branch-protection gate, referenced in no test),
  `CrossDesignReferenceService.mergeReferencesOnRelease`,
  `MbomService.createFromEbom`, `ItemRelationshipService` batch mutations,
  `ConflictReviewService` signature validity, the entire `packages/core/src/lib/jobs/` tree
  (including the 614-line `design-clone` handler).
- **Gate 3:** `GuardEvaluator.ts` (the repo's own remediation proposal
  documents three live bugs at `:166-178` a test would have caught),
  `ThreadService` (2,906 lines, only the physical domain tested),
  `graph-utils.ts` (pure functions — cheapest high-value test available).
- **E2E:** `eco-workflow.spec.ts` never approves, releases, or asserts a
  revision letter changed — the system's central workflow has no end-to-end
  proof. No E2E for work orders, software items, or the design engine. Eight
  conditional `test.skip()` calls let specs pass by vanishing when seed data
  is missing.

## 5. Cleanups (each small, all verified)

- **Email stub reports success:** `notification.ts:118-130` sleeps 100ms, logs
  "Would send email", and the caller increments `emailsSent`. Implement or
  make it fail/no-op honestly.
- **Dead frontend code (~1,780 lines):** `TraceabilityMatrix.tsx` (406),
  `RequirementsCoverageWidget.tsx` (334), `TestCoverageWidget.tsx` (311),
  `EcoCheckoutDialog.tsx` (228), `WorkflowTable.tsx` (199),
  `CheckoutStatusBadge.tsx` (71) — complete, unrouted, unreferenced. Plus the
  dead duplicate `packages/core/src/components/items/VersionContextSelector.tsx` (233; the
  live one is in `versioning/`). Route them or delete them.
- **Dead backend code:** `ChangeOrderMergeService.getNextRevision`
  (deprecated, zero production callers, its tests duplicate
  `RevisionService.test.ts` line-for-line); `NotImplementedError` (zero refs).
- **ThreadService duplication:** six near-duplicate traversal pairs (~1,600
  lines) between plain and `...AtContext` variants, already drifting.
  Parameterize the version resolver to collapse them.
- **Docs staleness:** `docs/migration-tool/` documented a tool that doesn't
  exist (since relocated to `proposals/` with `Status: Not started`);
  CLAUDE.md's testing section said service tests mock transactions when 35/58
  files use real Postgres (fixed). Two initially-reported items were false
  positives on verification: `adding-item-types.md`'s "missing" paths are
  deliberate `widget` placeholders, and `software-management.md`'s
  `packages/core/src/lib/scm/` refs are proposed Phase 3 paths, not stale ones.
- **13 test assertions match error-message strings** (`local-storage.test.ts`,
  `ChangeOrderService.test.ts`, `WorkflowService.test.ts:375`) — the suite's
  only deviation from its own stated rule; swap for error classes.
- SPDX headers cover 118 of 415 files under `src/lib` + `src/server` — a gap
  if the proprietary license matters commercially.

---

## Recommended order of work

1. **Restore CI** (billing/minutes) + the two cheap workflow fixes
   (`cache: 'npm'`, `needs: [lint]` on E2E). Everything else depends on the
   gates actually running.
2. **Authorization PR**: batch endpoints, `bypassBranchProtection`, and the
   missing `permission:` options (§1) — exploitable today, small diff.
3. **Move the merge accumulators inside the retry closure** (§2.1) — a
   silent-data-corruption bug with a one-scope fix.
4. **Auth-layer tests**: `permission-service` cache invalidation,
   `credentials`, `intersectPermissions` (§4).
5. **Frontend invalidation sweep**: the ~46 mutating components that never
   invalidate, starting with `WorkflowStatusPanel`; plus the `profile.tsx`
   logout-on-blip fix and `lifecycles/$id.tsx` loader conversion (§3).
6. **Merge/workflow atomicity design**: `mergeStatus` resume path for
   multi-design merge; wrap `WorkflowService.transition` writes (§2) —
   coordinate with the PR #52 simplification proposal, same domain.
7. **E2E through ECO release** with revision-letter assertions (§4).
8. **Cleanup batch** (§5): dead code, email stub, ThreadService dedup, doc
   fixes — mechanical, good between larger items.
