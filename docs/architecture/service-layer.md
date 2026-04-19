# Service Layer Architecture

Cascadia's business logic lives in a layered service architecture with strict dependency rules. This document covers the three layers, key services, error handling, and transaction patterns.

---

## Three-Layer Architecture

```
 API Routes (src/routes/api/)
        │
        ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  LAYER 1 — Orchestrators                                         │
 │  Coordinate multi-service operations with transaction management  │
 │                                                                   │
 │  ItemService, ChangeOrderService, ChangeOrderMergeService,       │
 │  ConflictDetectionService, ImpactAssessmentService               │
 └──────────────────────────────┬───────────────────────────────────┘
                                │ calls down
                                ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  LAYER 2 — Domain Logic                                          │
 │  Core domain operations, single-responsibility                   │
 │                                                                   │
 │  CheckoutService, VersionResolver, CommitService,                │
 │  BranchService, DesignService, LifecycleService,                 │
 │  ItemVersioningFacade                                            │
 └──────────────────────────────┬───────────────────────────────────┘
                                │ calls down
                                ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │  LAYER 3 — Utilities                                             │
 │  Standalone services with no service-layer dependencies          │
 │                                                                   │
 │  ProgramService, ItemTypeRegistry, NumberingService,             │
 │  ItemRelationshipService, ItemSearchService, UsageService,       │
 │  WorkflowService, FileService                                    │
 └──────────────────────────────┬───────────────────────────────────┘
                                │
                                ▼
                       Database (Drizzle ORM)
```

**The import rule**: Services may only import from the same layer or a lower layer. Never upward. This prevents circular dependencies and makes the dependency graph acyclic.

---

## Layer 1: Orchestrators

These services coordinate multiple lower-layer services to implement complex business operations.

### ItemService

**File**: `src/lib/items/services/ItemService.ts`

The central CRUD service for all item types. Handles creation, updates, deletion, search, and version-aware operations.

**Dependencies**: CommitService, CheckoutService, VersionResolver, BranchService, UsageService, ItemRelationshipService, ItemSearchService, ItemVersioningFacade, NumberingService, ItemTypeRegistry

Key responsibilities:

- Create items with automatic numbering, type validation, and commit tracking
- Enforce branch protection (post-release designs require ECO branches)
- Split data between `items` table and type-specific extension table
- Delegate versioning operations to `ItemVersioningFacade`

### ChangeOrderService

**File**: `src/lib/items/services/ChangeOrderService.ts`

Manages the ECO lifecycle: adding affected items, creating branches, orchestrating transitions.

**Dependencies**: BranchService, CheckoutService, CommitService, DesignService, ChangeOrderMergeService, LifecycleService, ItemService, WorkflowService

Key responsibilities:

- Add/remove affected items to an ECO
- Create or reuse ECO branches per design
- Trigger merge on ECO closure
- Track which designs an ECO affects via `changeOrderDesigns`

### ChangeOrderMergeService

**File**: `src/lib/services/ChangeOrderMergeService.ts`

Orchestrates ECO release: validates merges, assigns revisions, creates merge commits, archives branches.

**Dependencies**: ItemService, ChangeOrderService, FileService, BranchService, CommitService, DesignService, LifecycleService

Key responsibilities:

- Validate merge readiness (no checkout locks, no unresolved conflicts)
- Assign next revision letters (A->B, B->C)
- Create merge commits with dual parents
- Update item states to Released
- Archive ECO branches after merge
- Uses serializable transaction retry for merge atomicity

### ConflictDetectionService

**File**: `src/lib/services/ConflictDetectionService.ts`

Detects conflicts between branches: checkout locks, main divergence, cross-ECO modifications.

**Dependencies**: BranchService, ItemService

### ImpactAssessmentService

**File**: `src/lib/services/ImpactAnalysisService.ts`

Analyzes BOM relationships to find items indirectly affected by changes.

**Dependencies**: ItemService, ChangeOrderService

---

## Layer 2: Domain Logic

Single-responsibility services implementing core domain operations.

### CheckoutService

**File**: `src/lib/services/CheckoutService.ts`

Manages item checkout (lock for editing) and save operations on branches.

**Dependencies**: BranchService, CommitService, VersionResolver

Key methods:

- `checkout(itemMasterId, branchId, userId)` -- lock an item for editing
- `saveChanges(branchId, itemMasterId, newData, userId)` -- save edits, compute diffs, commit
- `createOnBranch(branchId, type, data, userId)` -- create a new item on a branch
- `checkin(branchId, itemMasterId)` -- release the checkout lock

### VersionResolver

**File**: `src/lib/services/VersionResolver.ts`

Resolves which version of an item to show for a given context (main, branch, commit, tag).

**Dependencies**: BranchService, DesignService

Key methods:

- `getReleasedVersion(masterId, designId)` -- latest on main
- `getWorkingVersion(masterId, branchId)` -- branch version with main fallback
- `getBranchItems(branchId, filters)` -- complete BOM for a branch (merges main + overrides)
- `getItemAtCommit(masterId, commitId)` -- time-travel to a specific commit

### CommitService

**File**: `src/lib/services/CommitService.ts`

Creates commits and tracks item changes within them.

**Dependencies**: BranchService

Key methods:

- `create(branchId, message, items, userId)` -- create a commit and advance HEAD
- `createMergeCommit(mainBranchId, ecoBranchId, ...)` -- merge commit with dual parents
- `getBranchChanges(branchId)` -- all changes on a branch since fork

### BranchService

**File**: `src/lib/services/BranchService.ts`

Branch lifecycle: creation, locking, archival, lookup.

**Dependencies**: DesignService

Key methods:

- `createEcoBranch(designId, ecoItemId, userId)` -- create ECO branch from main HEAD
- `getOrCreateEcoBranch(designId, ecoItemId, userId)` -- idempotent branch creation
- `lockBranch(branchId)` / `unlockBranch(branchId)` -- submission locking
- `archiveBranch(branchId)` -- post-merge archival

### DesignService

**File**: `src/lib/services/DesignService.ts`

Design CRUD and initialization. Leaf service with no service dependencies.

Key methods:

- `create(data)` -- creates design + main branch + initial commit in one transaction
- `getById(id)` / `listAll()` / `listByProgramIds(ids)`

### LifecycleService

**File**: `src/lib/services/LifecycleService.ts`

Item lifecycle state management using workflow definitions.

**Dependencies**: ItemTypeRegistry

Key methods:

- `getValidTransitions(itemType, currentState)` -- which states can an item move to
- `canTransition(itemType, fromState, toState)` -- validate a transition

### ItemVersioningFacade

**File**: `src/lib/items/services/ItemVersioningFacade.ts`

Facade that simplifies versioning operations for ItemService consumers.

**Dependencies**: VersionResolver, CommitService, CheckoutService, BranchService, NumberingService, ItemTypeRegistry, ItemService

---

## Layer 3: Utilities

Standalone services with no service-layer dependencies. They only access the database directly.

| Service                   | File                                                | Purpose                                      |
| ------------------------- | --------------------------------------------------- | -------------------------------------------- |
| `ProgramService`          | `src/lib/services/ProgramService.ts`                | Program CRUD and membership checks           |
| `ItemTypeRegistry`        | `src/lib/items/registry.ts`                         | Central registry of item type configurations |
| `NumberingService`        | `src/lib/items/numbering/NumberingService.ts`       | Auto-numbering (P-001, ECO-001, D-001)       |
| `ItemRelationshipService` | `src/lib/items/services/ItemRelationshipService.ts` | BOM and cross-item relationships             |
| `ItemSearchService`       | `src/lib/items/services/ItemSearchService.ts`       | Full-text search, filtering, sorting         |
| `UsageService`            | `src/lib/services/UsageService.ts`                  | SysML definition/usage copy tracking         |
| `WorkflowService`         | `src/lib/workflows/WorkflowService.ts`              | Workflow state machine execution             |
| `FileService`             | `src/lib/vault/services/FileService.ts`             | File vault upload/download/versioning        |

---

## Error Handling

### Typed Error Hierarchy

All business errors extend `AppError` (defined in `src/lib/errors/AppError.ts`), which carries:

- `code`: Machine-readable error code (enum from `src/lib/errors/codes.ts`)
- `httpStatus`: Derived automatically from the code
- `message`: Human-readable description
- `context`: Structured metadata (requestId, userId, resource, etc.)
- `isOperational`: `true` for expected errors, `false` for bugs
- `fieldErrors`: Array of per-field validation errors (for Zod failures)

### Error Classes

```
AppError
├── AuthenticationError          (401)
├── InvalidCredentialsError      (401)
├── SessionExpiredError          (401)
├── AccountLockedError           (401)
├── PermissionDeniedError        (403)
├── RoleRequiredError            (403)
├── ResourceForbiddenError       (403)
├── ValidationError              (400)  -- with .fromZodError() factory
├── FieldRequiredError           (400)
├── FieldInvalidError            (400)
├── NotFoundError                (404)
├── AlreadyExistsError           (409)
├── ConflictError                (409)
├── ResourceLockedError          (423)
├── WorkflowTransitionError      (400)
├── RevisionConflictError        (409)
├── MergeConflictError           (409)
├── BranchProtectionError        (403)
├── FileTooLargeError            (413)
├── FileTypeNotAllowedError      (415)
├── DatabaseConnectionError      (500, non-operational)
├── DatabaseQueryError           (500, non-operational)
├── TransactionError             (500, non-operational)
├── ConstraintViolationError     (409)
├── ExternalServiceUnavailableError (503)
├── InternalError                (500, non-operational)
└── RateLimitedError             (429)
```

### Error Flow Through apiHandler()

Services throw typed errors. `apiHandler()` catches everything via `handleApiError()`:

```
Service throws NotFoundError("Part", "P-001")
    │
    ▼
handleApiError() in src/lib/errors/handleApiError.ts
    ├── AppError → createErrorResponse(error, requestId)
    │               Returns: { error: { code, message, context, timestamp } }
    │               Status: error.httpStatus (404)
    │
    ├── ZodError → ValidationError.fromZodError(zodError)
    │               Returns field-level errors
    │               Status: 400
    │
    ├── PostgreSQL error → mapPostgresError(error)
    │               23505 unique_violation → AlreadyExistsError
    │               23503 foreign_key     → ConstraintViolationError
    │               40001 serialization   → TransactionError
    │               Status: varies
    │
    └── Unknown error → InternalError (500)
```

Every error is also logged to the database via `ErrorLogService` (fire-and-forget) and to structured console output via Pino.

---

## Transaction Patterns

### Standard Transaction

Use `db.transaction()` for multi-step operations that must be atomic:

```typescript
const result = await db.transaction(async (tx) => {
  const [item] = await tx.insert(items).values(data).returning()
  await tx.insert(parts).values({ itemId: item.id, ...partData })
  return item
})
```

### Serializable Transaction with Retry

For operations where concurrent access is expected (like ECO merge), use `withSerializableRetry()`:

```typescript
import { withSerializableRetry } from '@/lib/db/retry'

const result = await withSerializableRetry(async () => {
  return await db.transaction(async (tx) => {
    // Merge logic that may face serialization failures
  })
})
```

This retries on PostgreSQL serialization failures (`40001`) and deadlocks (`40P01`).

### Transaction Boundaries

- **ItemService.create()** -- single transaction for `items` + extension table + auto-commit
- **DesignService.create()** -- single transaction for design + initial commit + main branch + reference patching
- **ChangeOrderMergeService.mergeBranchToMain()** -- serializable transaction for the entire merge
- **FileService.uploadFile()** -- transaction for file record + version history

---

## Dependency Graph Summary

The graph is acyclic. Key design decisions that prevent cycles:

1. **Facade pattern**: `ItemVersioningFacade` calls `ItemService`, but `ItemService` only delegates to the facade (no reverse logic).
2. **Dynamic imports**: `ChangeOrderService` uses `import()` for `WorkflowService` to avoid static circular references.
3. **Leaf services**: `DesignService` and `ProgramService` have zero service dependencies -- they only talk to the database.

### Impact of Changes

When modifying a service, consider its position in the graph:

| Layer                   | Testing Complexity        | Change Impact                          |
| ----------------------- | ------------------------- | -------------------------------------- |
| Layer 3 (Utilities)     | Low -- no mocks needed    | High -- many services depend on these  |
| Layer 2 (Domain)        | Medium -- mock 1-3 deps   | Medium                                 |
| Layer 1 (Orchestrators) | High -- many deps to mock | Low -- only API routes depend on these |

---

## Adding a New Service

1. **Determine the layer**: Does it coordinate others (L1)? Implement core domain logic (L2)? Provide standalone utilities (L3)?
2. **Check dependencies**: Only import from the same layer or lower.
3. **Use typed errors**: Throw `NotFoundError`, `ValidationError`, etc. Never raw `Error`.
4. **Use transactions**: Wrap multi-step database operations in `db.transaction()`.
5. **Export static methods**: Services use static methods (no instantiation) for simplicity.

---

## Key Files

| File                                           | Purpose                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `src/lib/api/handler.ts`                       | `apiHandler()` -- wraps all routes with auth, CSRF, error handling |
| `src/lib/errors/index.ts`                      | All typed error classes                                            |
| `src/lib/errors/handleApiError.ts`             | `handleApiError()` -- catches and maps errors to responses         |
| `src/lib/errors/AppError.ts`                   | Base error class with code, status, context                        |
| `src/lib/errors/codes.ts`                      | Error code enum and HTTP status mapping                            |
| `docs/development/service-dependency-graph.md` | Full Mermaid dependency graph                                      |
