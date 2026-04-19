# API Overview

Cascadia PLM exposes a REST API built on Hono with modular route files. All API routes live under `/api/` and follow consistent patterns for authentication, authorization, request validation, response formatting, and error handling.

## Base URL

```
http://localhost:3000/api
```

In production, replace with your deployment URL.

## The `apiHandler()` Wrapper

Every API route handler is wrapped with `apiHandler()` from `@/lib/api/handler`. This wrapper provides:

- **Authentication and authorization** (configurable per endpoint)
- **CSRF protection** via Origin/Referer validation on state-changing requests
- **CORS handling** with preflight support
- **Security headers** (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`)
- **Error handling** (all thrown errors are caught and serialized)
- **Request ID tracing** (via `X-Request-Id` header or auto-generated)
- **Response envelope** (auto-wraps return values in `{ data: ... }`)

### Signature

```typescript
apiHandler(options: HandlerOptions, handler: HandlerFn): RouteHandler
```

### Handler Context

The handler function receives a context object:

```typescript
interface HandlerContext<TParams> {
  request: Request // The raw HTTP request
  params: TParams // URL path parameters
  user: SessionUser // Authenticated user (id, email, active)
  requestId: string // Unique request ID for tracing
}
```

### Usage Example

```typescript
// src/server/routes/parts.ts
import { Hono } from 'hono'
import { adapt } from '../adapter'
import { apiHandler } from '@/lib/api/handler'
import { NotFoundError } from '@/lib/errors'

const app = new Hono()

app.get('/:id', adapt(
  apiHandler({ permission: ['parts', 'read'] }, async ({ params }) => {
    const part = await ItemService.findById(params.id)
    if (!part) throw new NotFoundError('Part', params.id)
    return { part }
  })
))

export default app
```

## Authentication Options

The first argument to `apiHandler()` controls authentication:

| Option                                   | Description                                     | Example                             |
| ---------------------------------------- | ----------------------------------------------- | ----------------------------------- |
| `{ public: true }`                       | No authentication required                      | Health checks, session check        |
| `{}`                                     | Authentication required, no specific permission | General authenticated endpoints     |
| `{ permission: ['resource', 'action'] }` | Requires specific RBAC permission               | `{ permission: ['parts', 'read'] }` |

### Resource Types

Permissions reference one of these resource types:

`parts`, `documents`, `change_orders`, `designs`, `requirements`, `tasks`, `work_instructions`, `work_orders`, `issues`, `workflows`, `users`, `roles`, `programs`, `reports`, `system`

### Permission Actions

`create`, `read`, `update`, `delete`, `approve`, `manage`

## Response Envelope

### Success Response

All successful responses are wrapped in a `{ data: ... }` envelope:

```json
{
  "data": {
    "part": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "itemNumber": "PRT-001",
      "name": "Motor Assembly"
    }
  }
}
```

When a handler returns an object, `apiHandler` automatically wraps it:

```typescript
// Handler returns:
return { part }

// Client receives:
{ "data": { "part": { ... } } }
```

### Custom Responses

For non-standard responses (201 Created, streaming, file downloads), return a `Response` directly:

```typescript
import { created, jsonResponse } from '@/lib/api/handler'

// 201 Created
return created({ item })

// Custom status code (e.g., 207 Multi-Status)
return jsonResponse(response, 207)
```

### Collection Responses

Collection endpoints typically include pagination metadata:

```json
{
  "data": {
    "items": [...],
    "total": 150
  }
}
```

Use the `createCollectionResponse()` helper for richer pagination:

```typescript
import { createCollectionResponse } from '@/lib/api/response'

return createCollectionResponse(
  items,
  { total: 150, limit: 50, offset: 0 },
  {
    resourceName: 'parts',
  },
)
// Produces: { "data": { "parts": [...], "total": 150 } }
```

## Query Parameter Validation

Use `parseQuery()` to validate and type query parameters with Zod:

```typescript
import { parseQuery } from '@/lib/api/handler'
import { paginationSchema } from '@/lib/api/schemas'

GET: apiHandler({}, async ({ request }) => {
  const query = parseQuery(request, paginationSchema)
  // query.limit is number (default 50)
  // query.offset is number (default 0)
})
```

### Standard Schemas

| Schema                 | Fields                                                                         | Defaults                 |
| ---------------------- | ------------------------------------------------------------------------------ | ------------------------ |
| `paginationSchema`     | `limit`, `offset`                                                              | `limit: 50`, `offset: 0` |
| `versionContextSchema` | `designId`, `branch`, `commitId`, `tag`                                        | All optional             |
| `itemListSchema`       | Pagination + version context + `itemType`, `state`, `search`, `includeDeleted` | Combined defaults        |

## Access Control Helpers

For design and branch access checks beyond RBAC permissions:

```typescript
import { requireDesignAccess, requireBranchAccess } from '@/lib/auth/access'

// Throws PermissionDeniedError if user cannot access this design
await requireDesignAccess(user.id, designId)

// Throws NotFoundError or PermissionDeniedError; returns { branch, designId }
const { branch, designId } = await requireBranchAccess(user.id, branchId)
```

These helpers check organizational access (program membership) and handle Global Admin bypass automatically.

## Error Handling

Handlers throw typed errors from `@/lib/errors`. The `apiHandler` wrapper catches all thrown errors and serializes them into a standard error response.

### Error Response Format

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Part with ID '550e8400...' was not found",
    "requestId": "abc123def456",
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
      {
        "field": "itemNumber",
        "message": "Item number is required",
        "code": "too_small"
      },
      {
        "field": "revision",
        "message": "Revision is required",
        "code": "too_small"
      }
    ],
    "requestId": "abc123def456",
    "timestamp": "2025-01-15T10:30:00.000Z"
  }
}
```

In development mode, the `details` field is included with the underlying error message for debugging.

### Error Types and HTTP Status Codes

#### Authentication Errors (401)

| Error Class               | Error Code                 | Description           |
| ------------------------- | -------------------------- | --------------------- |
| `AuthenticationError`     | `AUTH_REQUIRED`            | No valid session      |
| `InvalidCredentialsError` | `AUTH_INVALID_CREDENTIALS` | Bad login credentials |
| `SessionExpiredError`     | `AUTH_SESSION_EXPIRED`     | Session has expired   |
| `AccountLockedError`      | `AUTH_ACCOUNT_LOCKED`      | Account is locked     |

#### Authorization Errors (403)

| Error Class              | Error Code           | Description               |
| ------------------------ | -------------------- | ------------------------- |
| `PermissionDeniedError`  | `PERMISSION_DENIED`  | Lacks required permission |
| `RoleRequiredError`      | `ROLE_REQUIRED`      | Missing required role     |
| `ResourceForbiddenError` | `RESOURCE_FORBIDDEN` | Access forbidden          |
| `BranchProtectionError`  | `BRANCH_PROTECTED`   | Branch is protected       |

#### Validation Errors (400)

| Error Class          | Error Code                  | Description                |
| -------------------- | --------------------------- | -------------------------- |
| `ValidationError`    | `VALIDATION_FAILED`         | General validation failure |
| `FieldRequiredError` | `VALIDATION_FIELD_REQUIRED` | Required field missing     |
| `FieldInvalidError`  | `VALIDATION_FIELD_INVALID`  | Field value invalid        |

#### Resource Errors

| Error Class           | Error Code                | HTTP Status | Description        |
| --------------------- | ------------------------- | ----------- | ------------------ |
| `NotFoundError`       | `RESOURCE_NOT_FOUND`      | 404         | Resource not found |
| `AlreadyExistsError`  | `RESOURCE_ALREADY_EXISTS` | 409         | Duplicate resource |
| `ConflictError`       | `RESOURCE_CONFLICT`       | 409         | State conflict     |
| `ResourceLockedError` | `RESOURCE_LOCKED`         | 423         | Resource is locked |

#### Business Logic Errors

| Error Class                     | Error Code                    | HTTP Status | Description                         |
| ------------------------------- | ----------------------------- | ----------- | ----------------------------------- |
| `WorkflowTransitionError`       | `WORKFLOW_INVALID_TRANSITION` | 422         | Invalid workflow transition         |
| `WorkflowActionNotAllowedError` | `WORKFLOW_ACTION_NOT_ALLOWED` | 422         | Action not allowed in current state |
| `RevisionConflictError`         | `ITEM_REVISION_CONFLICT`      | 409         | Newer revision exists               |
| `RelationshipCycleError`        | `ITEM_RELATIONSHIP_CYCLE`     | 422         | Circular reference detected         |
| `MergeConflictError`            | `MERGE_CONFLICT`              | 409         | ECO branch merge conflict           |
| `FileTooLargeError`             | `FILE_TOO_LARGE`              | 413         | File exceeds size limit             |
| `FileTypeNotAllowedError`       | `FILE_TYPE_NOT_ALLOWED`       | 415         | File type not permitted             |
| `FileCheckoutRequiredError`     | `FILE_CHECKOUT_REQUIRED`      | 422         | File must be checked out first      |

#### System Errors

| Error Class                       | Error Code                     | HTTP Status | Description                |
| --------------------------------- | ------------------------------ | ----------- | -------------------------- |
| `InternalError`                   | `INTERNAL_ERROR`               | 500         | Unexpected internal error  |
| `NotImplementedError`             | `NOT_IMPLEMENTED`              | 501         | Feature not implemented    |
| `RateLimitedError`                | `RATE_LIMITED`                 | 429         | Too many requests          |
| `DatabaseConnectionError`         | `DB_CONNECTION_FAILED`         | 503         | Cannot connect to database |
| `ExternalServiceUnavailableError` | `EXTERNAL_SERVICE_UNAVAILABLE` | 503         | External service down      |

### PostgreSQL Error Mapping

PostgreSQL errors are automatically mapped:

| PG Code                         | Mapped Error Code           | HTTP Status |
| ------------------------------- | --------------------------- | ----------- |
| `23505` (unique violation)      | `RESOURCE_ALREADY_EXISTS`   | 409         |
| `23503` (foreign key violation) | `DB_CONSTRAINT_VIOLATION`   | 409         |
| `23502` (not null violation)    | `VALIDATION_FIELD_REQUIRED` | 400         |
| `40001` (serialization failure) | `DB_TRANSACTION_FAILED`     | 500         |
| `40P01` (deadlock)              | `DB_TRANSACTION_FAILED`     | 500         |

## Request ID Tracing

Every request gets a unique ID for log correlation:

1. If the client sends an `X-Request-Id` header, that value is used.
2. Otherwise, a 12-character nanoid is generated.

The request ID appears in:

- Error responses (`requestId` field)
- Server logs (structured JSON)
- Database error log entries

```bash
curl -H "X-Request-Id: my-trace-123" /api/parts
```

## CORS Configuration

By default, only same-origin requests are allowed. To allow specific external origins, set the `CORS_ALLOWED_ORIGINS` environment variable:

```bash
CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
```

Allowed CORS headers: `Content-Type`, `Authorization`
Allowed methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`
Max age: 86400 seconds (24 hours)

## Client-Side Utilities

The `@/lib/api/client` module provides typed fetch wrappers with automatic retry:

```typescript
import { apiGet, apiPost, apiPut, apiDelete, ApiError } from '@/lib/api/client'

// GET with automatic retry on transient failures
const { data } = await apiGet<{ data: { part: Part } }>('/api/parts/123')

// POST with body
const { data } = await apiPost<{ data: { item: Part } }>('/api/items', {
  itemType: 'Part',
  itemNumber: 'PRT-001',
  revision: 'A',
  designId: '...',
})

// Disable retry
const { data } = await apiGet('/api/parts', { retry: false })

// Custom retry config
const { data } = await apiGet('/api/parts', {
  retry: { maxAttempts: 5, initialDelayMs: 2000 },
})

// Error handling
try {
  await apiGet('/api/parts/nonexistent')
} catch (error) {
  if (error instanceof ApiError) {
    console.log(error.code) // 'RESOURCE_NOT_FOUND'
    console.log(error.httpStatus) // 404
    console.log(error.isNotFoundError) // true
    console.log(error.isRetryable) // false
  }
}
```

## Security Headers

All API responses include these security headers:

| Header                   | Value                                      |
| ------------------------ | ------------------------------------------ |
| `X-Content-Type-Options` | `nosniff`                                  |
| `X-Frame-Options`        | `DENY`                                     |
| `Referrer-Policy`        | `strict-origin-when-cross-origin`          |
| `Permissions-Policy`     | `camera=(), microphone=(), geolocation=()` |

CSP and HSTS are expected to be set by the reverse proxy or ingress controller.
