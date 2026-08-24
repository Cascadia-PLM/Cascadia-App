# Versioning System -- Issues Found During Documentation

Issues discovered while researching the versioning system for `docs/features/versioning.md`.

---

## 1. DocsSite Versioning Doc References Non-Existent `getNextRevision` on `EcoReleaseService`

**Severity**: Documentation inaccuracy

The developer versioning doc at `../DocsSite/docs/development/versioning.md` (line ~258) shows:

```typescript
// EcoReleaseService.getNextRevision()
```

This method now lives in `RevisionService.getNextRevision()` and `RevisionService.getInitialRevision()`.

**Fix**: Update the code reference in the DocsSite versioning documentation.

---

## 3. Workspace Branch Changes Not Committable Without ECO

**Severity**: Resolved

Workspace branches (`workspace/name`) allow personal drafts and experiments; only ECO branches can merge to main, and that part is by design. The promotion path this issue asked for now exists: `POST /api/v1/workspaces/:id/convert-to-eco` (new ECO) and `POST /api/v1/workspaces/:id/merge-to-eco` (existing ECO), both backed by `ChangeOrderService.adoptWorkspaceItems()`. Adoption **moves** the workspace's branch items onto the ECO branch — content is transferred, not copied — and registers each in the ECO's reviewed scope, so the ordinary merge machinery releases workspace work exactly as if it had been drafted on the ECO branch. See `docs/features/versioning.md`.

---

## 4. `compareTags` Uses Timestamp-Based Ancestor Ordering

**Severity**: Minor / edge case

In `CommitService.compareTags()`, the method determines which tag is "older" by checking if one commit is an ancestor of the other (`ancestor2Ids.has(commit1.id)`). However, if neither tag is an ancestor of the other (they're on divergent branches), the comparison may produce unexpected results.

This is an unlikely scenario in normal usage (tags are typically on the main branch), but could occur with tags on different branches.

**Recommendation**: Add a guard or documentation noting that tag comparison assumes both tags are on the same branch lineage.

---

## 5. Items Released Under the `none` Revision Scheme Are Invisible to Released-Query Fallbacks

**Severity**: Minor / latent (no shipped lifecycle uses `none`)

`RevisionService.getInitialRevision({ type: 'none' })` returns `''`, and `notWorkingRevision()` (`packages/core/src/lib/db/filters.ts`) excludes `revision = ''` alongside the branch working markers. An item released under the `none` scheme therefore carries an empty revision and is filtered out of every released-query fallback built on that predicate (`VersionResolver`), so the scheme is offered in the lifecycle editor but does not work end to end.

**Recommendation**: decide before anything ships on the scheme — either give `none` a non-empty initial value (the scheme table in `docs/features/workflow-engine.md` says "stays unchanged", so a fixed marker would do), or stop treating `''` as an unreleased marker in `notWorkingRevision()` once nothing else relies on it. Carried forward from the retired change-order assessment (`docs/architecture/change-order-versioning-lifecycle-assessment.md` in git history, §3-I).

---

## 6. `getItemCommits` Filters Deleted Versions Out of History

**Severity**: Minor / known limitation

`CommitService.getItemCommits()` (`packages/core/src/lib/services/CommitService.ts`) selects the master's versions with `notDeleted()`, so the history of a deleted item — or of a deleted version — loses those rows. The commit-graph mechanism already handles deletions correctly; it is the row-level filter that erases them from history reads. Removing it needs care about every caller that expects the current-only view.

**Recommendation**: drop the filter from the history read path specifically, with a test that a deleted item's history still lists its commits. Carried forward from the change-action-routing remediation (C5) and the change-order assessment, both retired to git history.
