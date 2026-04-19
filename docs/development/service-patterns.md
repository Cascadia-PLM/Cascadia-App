# Service Layer Patterns

This guide covers the conventions and patterns used in Cascadia's service layer, located in `src/lib/services/` and `src/lib/items/services/`.

## Architecture Overview

Cascadia uses a three-layer architecture for server-side logic:

```
API Routes (src/routes/api/)
    │  Thin handlers — parse request, call service, return response
    ▼
Service Layer (src/lib/services/, src/lib/items/services/)
    │  Business logic, validation, orchestration
    ▼
Database Layer (src/lib/db/, Drizzle ORM)
    │  Schema definitions, queries, transactions
    ▼
PostgreSQL
```

### Layer Responsibilities

| Layer          | Does                                                    | Does NOT                           |
| -------------- | ------------------------------------------------------- | ---------------------------------- |
| **API Routes** | Auth, request parsing, call services, format response   | Business logic, direct DB queries  |
| **Services**   | Validation, business rules, orchestration, transactions | HTTP concerns, response formatting |
| **Database**   | Schema, queries, migrations                             | Business logic, validation         |

## Service Conventions

### Static Class Pattern

All services use static methods on a class. There are no instances to manage or inject.

```typescript
// src/lib/services/BranchService.ts
export class BranchService {
  static async getById(id: string) {
    const result = await db
      .select()
      .from(branches)
      .where(eq(branches.id, id))
      .limit(1)

    return result.at(0) || null
  }

  static async createEcoBranch(
    designId: string,
    changeOrderItemId: string,
    userId: string,
  ) {
    // ... business logic
  }
}
```

Call services directly from routes or other services:

```typescript
const branch = await BranchService.getById(branchId)
const part = await ItemService.findById(partId)
```

### File Organization

- One service per file, named after the service class
- Co-located test files: `BranchService.ts` + `BranchService.test.ts`
- Zod schemas defined at the top of the service file
- Types/interfaces exported alongside the service

```
src/lib/services/
├── BranchService.ts          # Branch management
├── BranchService.test.ts     # Tests
├── CheckoutService.ts        # Item checkout/checkin
├── CommitService.ts          # Version commits
├── VersionResolver.ts        # Item version resolution
├── ChangeOrderMergeService.ts # ECO branch merging
└── types/                    # Shared type definitions
```

### Validation with Zod

Services define Zod schemas for input validation and parse data at the entry point:

```typescript
// Define schema at top of file
export const checkoutSchema = z.object({
  itemMasterId: z.string().uuid(),
  branchId: z.string().uuid(),
})

export type CheckoutInput = z.infer<typeof checkoutSchema>

// Parse in the service method
static async checkout(data: CheckoutInput, userId: string) {
  const validated = checkoutSchema.parse(data)
  // ... use validated data
}
```

For `ItemService.create()`, the schema comes from the `ItemTypeRegistry`:

```typescript
const typeConfig = ItemTypeRegistry.getType(type)
const validatedData = typeConfig.schema.parse(dataWithType)
```

## Error Handling

### Typed Error Classes

Services throw typed errors from `src/lib/errors/`. Each error maps to an HTTP status code automatically.

| Error Class               | HTTP Status | When to Use              |
| ------------------------- | ----------- | ------------------------ |
| `NotFoundError`           | 404         | Resource doesn't exist   |
| `ValidationError`         | 400         | Input validation failed  |
| `PermissionDeniedError`   | 403         | User lacks permission    |
| `AlreadyExistsError`      | 409         | Duplicate resource       |
| `ConflictError`           | 409         | State conflict           |
| `ResourceLockedError`     | 423         | Resource is locked       |
| `WorkflowTransitionError` | 422         | Invalid state transition |
| `BranchProtectionError`   | 403         | Main branch is protected |
| `MergeConflictError`      | 409         | Branch merge conflict    |

### Throwing Errors

```typescript
import { NotFoundError, ValidationError } from '../errors'

// Resource not found — pass resource type and optional ID
if (!branch) {
  throw new NotFoundError('Branch', branchId, { operation: 'lock' })
}

// Validation failure — pass message and optional field errors
if (branch.branchType === 'main') {
  throw new ValidationError('Cannot lock main branch')
}

// Validation with field-level errors (for form display)
throw new ValidationError(
  'ECO branch already exists for this change order on this design',
  [
    {
      field: 'changeOrderItemId',
      message: 'An ECO branch for this change order already exists',
    },
  ],
)

// Permission denied — pass resource and action
throw new PermissionDeniedError('parts', 'delete')
```

### How apiHandler Catches Errors

The `apiHandler()` wrapper in `src/lib/api/handler.ts` catches all errors thrown by services and converts them to proper HTTP responses automatically. You never need try/catch in routes:

```typescript
// In the route — just throw, apiHandler catches it
GET: apiHandler({ permission: ['parts', 'read'] }, async ({ params }) => {
  const part = await ItemService.findById(params.id)
  if (!part) throw new NotFoundError('Part', params.id)
  return { part }
})
```

The error handling chain:

1. Service throws `NotFoundError('Part', params.id)`
2. `apiHandler` catches it in its try/catch
3. Calls `handleApiError(error, request, requestId)`
4. `handleApiError` checks the error type:
   - `AppError` subclass: creates response from error's `httpStatus` and `code`
   - `ZodError`: wraps as `ValidationError` (400)
   - PostgreSQL error: maps error code to appropriate response
   - Unknown error: returns 500 Internal Server Error
5. Error is logged to console and database (fire-and-forget)
6. Response includes security headers (CORS, X-Frame-Options, etc.)

### Error Response Format

All error responses follow this structure:

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Part with ID 'abc-123' was not found",
    "requestId": "req_abc123",
    "timestamp": "2025-01-15T10:30:00.000Z"
  }
}
```

Validation errors include field-level details:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "fieldErrors": [
      { "field": "name", "message": "Name is required", "code": "too_small" }
    ],
    "requestId": "req_abc123",
    "timestamp": "2025-01-15T10:30:00.000Z"
  }
}
```

## Transaction Patterns

### When to Use Transactions

Use `db.transaction()` when a service method performs multiple database operations that must succeed or fail together:

```typescript
// BranchService.createBranch — must create branch atomically
return db.transaction(async (tx) => {
  const [branch] = await tx
    .insert(branches)
    .values({ ... })
    .returning()

  return branch
}, { isolationLevel: 'repeatable read' })
```

### Transaction with Isolation Level

For operations that read-then-write and must avoid phantom reads, use `repeatable read`:

```typescript
return db.transaction(async (tx) => {
  // Read and write in the same transaction
  const [branch] = await tx
    .insert(branches)
    .values({ ... })
    .returning()
  return branch
}, { isolationLevel: 'repeatable read' })
```

### When NOT to Use Transactions

Avoid wrapping calls that contain their own transactions. Nested transactions with `postgres.js` attempt to reserve additional connections and can deadlock:

```typescript
// CheckoutService.createOnBranch — CommitService.create() has its own transaction
// So we do NOT wrap the outer method in db.transaction()

// 1. Insert item
const [newItem] = await db.insert(items).values({ ... }).returning()

// 2. Insert branchItem
await db.insert(branchItems).values({ ... })

// 3. Create commit (has its own transaction internally)
const commit = await CommitService.create({ ... }, userId)
```

### Multi-step Operations

When multiple operations must happen atomically but one step has its own transaction, use sequential calls without a wrapping transaction:

```typescript
static async deleteOnBranch(itemMasterId, branchId, commitMessage, userId) {
  // Step 1: Update branchItem (single query, auto-committed)
  await db.update(branchItems)
    .set({ changeType: 'deleted' })
    .where(eq(branchItems.id, bi.id))

  // Step 2: Create commit (has its own transaction)
  const commit = await CommitService.create({ ... }, userId)

  return commit
}
```

## Service Composition

Services call other services freely. There is no dependency injection — just direct static method calls:

```typescript
// CheckoutService calls BranchService and CommitService
export class CheckoutService {
  static async checkout(data: CheckoutInput, userId: string) {
    const branch = await BranchService.getById(validated.branchId)
    if (!branch) throw new NotFoundError('Branch', validated.branchId)

    const releasedItem = await VersionResolver.getReleasedVersion(
      validated.itemMasterId, branch.designId
    )

    // ... create branchItem entry
  }

  static async saveChanges(data: SaveChangesInput, userId: string) {
    // ... create new item version
    const commit = await CommitService.create({ ... }, userId)
    return { item: newItem, commit }
  }
}
```

## Key Services Reference

| Service                    | Location                  | Purpose                                 |
| -------------------------- | ------------------------- | --------------------------------------- |
| `ItemService`              | `src/lib/items/services/` | CRUD for all item types                 |
| `BranchService`            | `src/lib/services/`       | Branch creation, locking, archiving     |
| `CheckoutService`          | `src/lib/services/`       | Item checkout/checkin on branches       |
| `CommitService`            | `src/lib/services/`       | Create version commits                  |
| `VersionResolver`          | `src/lib/services/`       | Resolve item versions per branch/commit |
| `ChangeOrderMergeService`  | `src/lib/services/`       | Merge ECO branches to main              |
| `DesignService`            | `src/lib/services/`       | Design management                       |
| `LifecycleService`         | `src/lib/services/`       | Lifecycle state transitions             |
| `ConflictDetectionService` | `src/lib/services/`       | Detect merge conflicts                  |
| `RevisionService`          | `src/lib/services/`       | Assign revision letters on release      |
| `JobService`               | `src/lib/jobs/`           | Submit and manage background jobs       |
