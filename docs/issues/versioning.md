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

**Severity**: Design clarification needed

Workspace branches (`workspace/name`) allow personal drafts and experiments. However, there is no documented or implemented path to merge workspace branch changes into main. The only merge path goes through ECO branches.

This is likely by design (workspace branches are throwaway), but it means:

- Work done on a workspace branch cannot be promoted without recreating it on an ECO branch.
- There is no "promote workspace to ECO" workflow.

**Recommendation**: Document workspace branches as explicitly non-mergeable and consider whether a "promote to ECO" feature would be valuable.

---

## 4. `compareTags` Uses Timestamp-Based Ancestor Ordering

**Severity**: Minor / edge case

In `CommitService.compareTags()`, the method determines which tag is "older" by checking if one commit is an ancestor of the other (`ancestor2Ids.has(commit1.id)`). However, if neither tag is an ancestor of the other (they're on divergent branches), the comparison may produce unexpected results.

This is an unlikely scenario in normal usage (tags are typically on the main branch), but could occur with tags on different branches.

**Recommendation**: Add a guard or documentation noting that tag comparison assumes both tags are on the same branch lineage.
