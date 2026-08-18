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
