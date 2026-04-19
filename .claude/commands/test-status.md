---
description: Preview which changed files trigger the three-gate rule and may need tests
allowed-tools: Bash(git *), Bash(npm run test:coverage*), Read, Glob, Grep
---

# Test Gate Preview

Quick status: which changed files pass one of the three gates and may need tests?

## The Three Gates

A file needs tests only if it passes one:

1. **Data integrity** — mutates multi-entity state (branching, versioning, ECO release, conflict detection, checkout)
2. **Security** — gates access or verifies identity (auth, access control, permissions)
3. **Complex algorithm** — non-obvious logic (merge logic, workflow state machines, graph traversal)

Most changes pass none of these. **That is correct and expected.**

## Changed files

**Uncommitted:**

```
$git diff --name-only HEAD 2>/dev/null || echo "No uncommitted changes"
```

**Staged:**

```
$git diff --name-only --cached 2>/dev/null || echo "Nothing staged"
```

## Analysis

Categorize each changed source file (skip test files):

### Files that typically pass a gate

- `src/lib/services/` — likely data-integrity services (BranchService, CommitService, CheckoutService, ChangeOrderMergeService, ConflictDetectionService, VersionResolver)
- `src/lib/auth/` — security services (AuthService, AccessControlService)
- `src/lib/items/services/` — core item services if touching state mutation (ItemService, ChangeOrderService)
- `src/lib/workflows/` — workflow engine state machines

For files in these directories, still ask: does this particular change mutate multi-entity state, gate access, or implement non-obvious logic? If it's a trivial query/getter tweak, no gate applies.

For files that pass a gate, check if a co-located test exists: `ServiceName.test.ts`.

### Files that rarely pass a gate (skip tests)

- `src/routes/api/` — API routes (service tests cover the logic)
- `src/components/` — UI components (E2E covers them)
- `src/lib/utils/`, `src/lib/config/`, `src/lib/errors/` — utilities, types
- Query-only services / CRUD wrappers / glue code
- Styling, config, type definitions, schemas

## Report format

| File                                | Gate           | Needs Tests?                            |
| ----------------------------------- | -------------- | --------------------------------------- |
| `src/lib/services/BranchService.ts` | Data integrity | Yes — check existing test covers change |
| `src/components/parts/PartForm.tsx` | None           | No — E2E covers UI                      |
| `src/routes/api/parts.ts`           | None           | No — service tests cover logic          |

## Recommendation

Only suggest `/write-tests` if a file passed a gate AND doesn't have a test (or existing test doesn't cover the new invariant).

**Most changes will pass NO gate and need NO tests.** This is by design.

## Quick commands

- `/write-tests` — evaluate and write invariant tests only where a gate applies (refuses by default)
- `/test-ready` — full validation before commit
- `/test-ready --scoped` — fast validation while iterating
