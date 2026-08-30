# Adding API Routes

This guide covers how to add API routes in Cascadia using Hono route modules and the `apiHandler()` wrapper.

## Route Architecture

API routes are defined in `packages/core/src/server/routes/`, one file per domain. Each file creates a `Hono` app, defines routes using `adapt()` + `apiHandler()`, and exports the app. The routes are mounted in `packages/core/src/server/index.ts`.

| File                                               | Mounted At              |
| -------------------------------------------------- | ----------------------- |
| `packages/core/src/server/routes/parts.ts`         | `/api/v1/parts`         |
| `packages/core/src/server/routes/programs.ts`      | `/api/v1/programs`      |
| `packages/core/src/server/routes/designs.ts`       | `/api/v1/designs`       |
| `packages/core/src/server/routes/change-orders.ts` | `/api/v1/change-orders` |

Route parameters use the `:param` naming convention (e.g., `/:id`, `/:designId/branches`).

## Basic Route Structure

Every API route file creates a `Hono` app, uses `adapt()` to bridge Hono's context to the `apiHandler()` signature, and wraps handlers with `apiHandler()`:

```typescript
// packages/core/src/server/routes/widgets.ts
import { Hono } from 'hono'
import { adapt } from '../adapter'
import { apiHandler } from '@/lib/api/handler'
import { ItemService } from '@/lib/items/services/ItemService'
import { NotFoundError } from '@/lib/errors'
import '@/lib/items/registerItemTypes.server'

const app = new Hono()

// GET /api/v1/widgets/:id
app.get(
  '/:id',
  adapt(
    apiHandler({ permission: ['widgets', 'read'] }, async ({ params }) => {
      const widget = await ItemService.findById(params.id)
      if (!widget) throw new NotFoundError('Widget', params.id)
      return { widget }
    }),
  ),
)

// PUT /api/v1/widgets/:id
app.put(
  '/:id',
  adapt(
    apiHandler(
      { permission: ['widgets', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()
        const widget = await ItemService.update(params.id, data, user.id)
        return { widget }
      },
    ),
  ),
)

// DELETE /api/v1/widgets/:id
app.delete(
  '/:id',
  adapt(
    apiHandler({ permission: ['widgets', 'delete'] }, async ({ params }) => {
      await ItemService.delete(params.id)
      return { success: true }
    }),
  ),
)

export default app
```

Then mount the route in `packages/core/src/server/index.ts`:

```typescript
import widgets from './routes/widgets'

app.route('/api/v1/widgets', widgets)
```

## The adapt() Bridge

`adapt()` from `packages/core/src/server/adapter.ts` bridges Hono's `Context` to the `apiHandler()` signature. It extracts `params` and `request` from the Hono context and passes them to the legacy handler:

```typescript
export function adapt(handler: LegacyHandler) {
  return async (c: Context) => {
    const params = c.req.param()
    const request = c.req.raw
    return await handler({ params, request })
  }
}
```

You always wrap `apiHandler()` calls with `adapt()` when defining Hono routes.

## The apiHandler() Wrapper

`apiHandler()` from `packages/core/src/lib/api/handler.ts` wraps every API handler. It provides:

1. **Authentication** — verifies session or API key, extracts user
2. **Authorization** — checks permissions if specified
3. **CSRF protection** — validates Origin header on state-changing requests
4. **Error handling** — catches all thrown errors, returns proper HTTP responses
5. **Security headers** — X-Content-Type-Options, X-Frame-Options, CORS
6. **Response serialization** — wraps return values in `{ data: ... }` envelope

### Signature

```typescript
apiHandler(options: HandlerOptions, handler: HandlerFn)
```

### Auth Options

The first argument controls authentication and authorization:

```typescript
// Public route — no auth required
app.get('/public', adapt(
  apiHandler({ public: true }, async ({ request }) => { ... })
))

// Auth-only — requires valid session, no specific permission
app.get('/protected', adapt(
  apiHandler({}, async ({ user }) => { ... })
))

// Permission-required — requires specific permission
app.get('/items', adapt(
  apiHandler({ permission: ['parts', 'read'] }, async ({ user }) => { ... })
))
app.post('/items', adapt(
  apiHandler({ permission: ['parts', 'create'] }, async ({ user }) => { ... })
))
app.delete('/items/:id', adapt(
  apiHandler({ permission: ['parts', 'delete'] }, async ({ user }) => { ... })
))
```

Both halves of the tuple are typed, so a misspelt resource or action is a
compile error. What the types cannot say is whether any role _holds_ the pair
you charged. `manage` is the trap: it sits on `workflows`, `users`, `roles`,
`programs` and `system`, and on no item-type resource — so
`permission: ['documents', 'manage']` is not a tight route, it is a route
nobody can call, answering 403 to everyone including the Administrator with
the message an unauthorized caller gets.

`npm run permissions:check` fails on a tuple no role in `ROLE_DEFINITIONS`
grants, and runs in CI's Lint job. The other way to satisfy one is to grant the
action in `packages/core/src/lib/auth/permissions.ts` — existing databases pick
that up with `npm run db:sync-roles`. To see which roles a tuple actually
admits, run `npm run permissions:check -- --audience`.

#### Row-level reach: `access:`

`permission:` answers _may this role do this verb at all_. It cannot answer
_may this user touch this row_ — that needs the route's params. Declare the
second as `access:`, which runs **after** the permission check and **before**
the body is parsed:

```typescript
apiHandler<{ id: string }, z.infer<typeof transitionSchema>>(
  {
    permission: ['change_orders', 'update'],
    access: ({ params, user }) => requireEcoAccess(user.id, params.id),
    body: transitionSchema,
  },
  async ({ params, body }) => { ... },
)
```

**The ordering is the point, not a detail.** These checks used to be the first
statement of each handler, which put them _after_ the wrapper's body parse —
so a caller with no reach got a 400 describing the body they were not allowed
to send, instead of a 403. Declaring the gate makes the ordering structural
rather than something every author has to remember.
`program-isolation.permissions.test.ts` and `handler.test.ts` both hold it.

Throw to refuse; the `require*Access` helpers in `lib/auth/access` already
throw `PermissionDeniedError`, so most gates are one line. Any return value is
awaited and discarded.

### Handler Context

The handler function receives a context object:

```typescript
interface HandlerContext {
  request: Request // Raw HTTP request
  params: TParams // URL parameters (e.g., { id: '...' })
  body: TBody // Validated body when the route declares `body:` (see below)
  user: SessionUser // Authenticated user, null on a public route
  requestId: string // Unique request ID for tracing
}
```

### Return Values

**Return an object** — auto-wrapped as `{ data: { ... } }` with 200 status:

```typescript
app.get(
  '/:id',
  adapt(
    apiHandler({}, async ({ params }) => {
      const widget = await ItemService.findById(params.id)
      return { widget }
    }),
  ),
)
// Response: { "data": { "widget": { ... } } }
```

**Return a Response** — passed through directly (for custom status codes, streaming, cookies):

```typescript
import { created } from '@/lib/api/handler'

app.post(
  '/',
  adapt(
    apiHandler(
      { permission: ['parts', 'create'] },
      async ({ request, user }) => {
        const data = await request.json()
        const part = await ItemService.create('Part', data, user.id)
        return created({ part })
      },
    ),
  ),
)
// Response: 201 Created, { "data": { "part": { ... } } }
```

## Request Parsing

### JSON Body

**Declare a `body:` schema. Do not call `request.json()`.** The wrapper reads,
parses and validates the body before the handler runs, and hands it over as
`ctx.body` — so a body that does not conform never reaches your code, and the
400 it produces names the failing fields in the documented envelope.

```typescript
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof partUpdateSchema>>(
      { permission: ['parts', 'update'], body: partUpdateSchema },
      async ({ params, body, user }) =>
        ItemService.update(params.id, body, user.id),
    ),
  ),
)
```

The same schema is written into the route's OpenAPI metadata, so the spec
cannot drift from what actually runs.

Four things this replaced, none of which should come back:

- `await request.json()` followed by hand-rolled `if (!x) throw new
ValidationError(...)` checks. Put the rule in the schema; the 400 then names
  the field instead of describing the rule in prose.
- `schema.safeParse(body)` with the issues mapped into a `ValidationError` by
  hand. `handleApiError` already builds that envelope from a `ZodError`.
- `(await request.json()) as SomeInterface` — a cast, which validates nothing.
- Unbounded arrays and numbers. Every array gets a `.max()` and every numeric
  field a range; an uncapped `maxDepth` or message list is a request that can
  ask the server for unbounded work.

Naming `TParams` switches off inference for the rest, so a route with both
params and a body names both type arguments. A route with only a body
(`apiHandler({ body: schema }, …)`) has its body type inferred.

**Two documented exceptions**, both because the schema is not knowable until
after a lookup, and both commented where they live:

- `PUT /api/v1/items/:id` — the schema depends on the _stored_ item's type.
- `POST /api/v1/relationships/batch` — validates line by line and collects
  rejections into `errors[]`, which is what a batch endpoint is for. Parsing
  the whole body would turn one malformed line into a rejection of all 500.
  Its _envelope_ (non-empty, at most 500) is still a `body:` schema.

Multipart upload handlers read the raw request and are untouched by this.

### Query Parameters

Use `parseQuery()` with a Zod schema for validated, typed query parameters:

```typescript
import { apiHandler, parseQuery } from '@/lib/api/handler'
import { paginationSchema } from '@/lib/api/schemas'

app.get(
  '/',
  adapt(
    apiHandler({}, async ({ request }) => {
      const query = parseQuery(request, paginationSchema)
      // query.limit is number (default 50), query.offset is number (default 0)
    }),
  ),
)
```

Common query schemas from `packages/core/src/lib/api/schemas.ts`:

```typescript
// Pagination
const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
})

// Version context (for querying items at specific versions)
const versionContextSchema = z.object({
  designId: z.string().uuid().optional(),
  branch: z.string().optional(),
  commitId: z.string().uuid().optional(),
  tag: z.string().optional(),
})

// Combined item list query
const itemListSchema = paginationSchema.merge(versionContextSchema).extend({
  itemType: z.string().optional(),
  state: z.string().optional(),
  search: z.string().optional(),
})
```

### URL Parameters

URL parameters come from the `params` object. For a route at `/api/v1/parts/:id`:

```typescript
app.get(
  '/:id',
  adapt(
    apiHandler({}, async ({ params }) => {
      const { id } = params // string
    }),
  ),
)
```

## Error Handling

**Do not use try/catch in routes.** Just throw errors — `apiHandler` catches them:

```typescript
app.get(
  '/:id',
  adapt(
    apiHandler({}, async ({ params }) => {
      const part = await ItemService.findById(params.id)
      if (!part) throw new NotFoundError('Part', params.id)
      return { part }
    }),
  ),
)
```

The service layer can also throw errors, and they propagate up:

```typescript
// In the service — throws ValidationError if branch is locked
static async checkout(data, userId) {
  if (branch.isLocked) {
    throw new ValidationError('Cannot checkout items on a locked branch')
  }
}

// In the route — no try/catch needed
app.post('/checkout', adapt(
  apiHandler({}, async ({ request, user }) => {
    const data = await request.json()
    return await CheckoutService.checkout(data, user.id)
    // If service throws, apiHandler converts to proper HTTP error response
  })
))
```

## Response Helpers

For responses that need custom status codes, use helpers from `packages/core/src/lib/api/handler.ts`:

```typescript
import { apiHandler, created, jsonResponse } from '@/lib/api/handler'

// 201 Created
return created({ part })

// Custom status code
return jsonResponse({ results }, 207) // Multi-status
```

Or use response builders from `packages/core/src/lib/api/response.ts` for more control:

```typescript
import {
  createCollectionResponse,
  createCreatedResponse,
} from '@/lib/api/response'

// Collection with pagination
return createCollectionResponse(
  parts,
  { total: 100, limit: 20, offset: 0 },
  {
    resourceName: 'parts',
  },
)

// Created with Location header
return createCreatedResponse(widget, {
  resourceName: 'widget',
  location: `/api/v1/widgets/${widget.id}`,
})
```

## Access Control Helpers

For routes that need design-level or branch-level access checks beyond simple permissions:

```typescript
import { requireDesignAccess, requireBranchAccess } from '@/lib/auth/access'

app.get(
  '/designs/:designId/items',
  adapt(
    apiHandler({}, async ({ params, user, request }) => {
      await requireDesignAccess(request, params.designId, user)
      // ... user has access to this design
    }),
  ),
)

app.post(
  '/branches/:branchId/items',
  adapt(
    apiHandler({}, async ({ params, user, request }) => {
      await requireBranchAccess(request, params.branchId, user)
      // ... user has access to this branch
    }),
  ),
)
```

## Documenting the Route

Handler options take an `openapi` block. Point `request.body.schema` at the
same Zod schema the route validates against, and declare the success response;
the error responses are merged in for you:

```typescript
apiHandler(
  {
    permission: ['programs', 'create'],
    openapi: {
      summary: 'Create a program',
      request: { body: { schema: programCreateSchema } },
      responses: {
        201: { schema: z.object({ program: programResponseSchema }) },
      },
    },
  },
  async ({ request, user }) => { ... },
)
```

The committed `docs/api/openapi.v1.json` snapshot is refreshed by the
maintainers, so leave it out of your PR — `npm run openapi:check` runs on
`main`, not on pull requests. Full reference, including multipart bodies and
optional ones: [`docs/api/README.md`](../api/README.md).

## Important Notes

### Mounting New Routes

After creating a new route file, you must import and mount it in `packages/core/src/server/index.ts`:

```typescript
import widgets from './routes/widgets'

// ... other route mounts ...
app.route('/api/v1/widgets', widgets)
```

### Item Type Registration

API routes that work with items must import the server-side item type registration:

```typescript
import '@/lib/items/registerItemTypes.server'
```

This ensures the `ItemTypeRegistry` knows about all item types when the route handler runs.

### Server-Only Imports

Keep database imports strictly in API routes, services, and server-only files. Importing database modules in client-side code causes build errors:

```
error: "performance" is not exported by "__vite-browser-external"
```

Use `import type` for types, and dynamic imports for server-only services when needed in shared files.

## Complete Examples

### Collection Endpoint (List + Search)

```typescript
// packages/core/src/server/routes/widgets.ts
import { Hono } from 'hono'
import { adapt } from '../adapter'
import { apiHandler, parseQuery, created } from '@/lib/api/handler'
import { itemListSchema } from '@/lib/api/schemas'
import { ItemService } from '@/lib/items/services/ItemService'
import '@/lib/items/registerItemTypes.server'

const app = new Hono()

// GET /api/v1/widgets
app.get(
  '/',
  adapt(
    apiHandler({ permission: ['widgets', 'read'] }, async ({ request }) => {
      const query = parseQuery(request, itemListSchema)
      const result = await ItemService.search({
        itemType: 'Widget',
        limit: query.limit,
        offset: query.offset,
        search: query.search,
        designId: query.designId,
      })
      return { widgets: result.items, total: result.total }
    }),
  ),
)

// POST /api/v1/widgets
app.post(
  '/',
  adapt(
    apiHandler(
      { permission: ['widgets', 'create'] },
      async ({ request, user }) => {
        const data = await request.json()
        const widget = await ItemService.create('Widget', data, user.id)
        return created({ widget })
      },
    ),
  ),
)

export default app
```

### Action Endpoint (Non-CRUD)

```typescript
// packages/core/src/server/routes/change-orders.ts (excerpt)
import { Hono } from 'hono'
import { adapt } from '../adapter'
import { apiHandler } from '@/lib/api/handler'

const app = new Hono()

// POST /api/v1/change-orders/:id/workflow/transition
app.post(
  '/:id/workflow/transition',
  adapt(
    apiHandler(
      { permission: ['change_orders', 'update'] },
      async ({ params, request, user }) => {
        const { targetState } = await request.json()
        const result = await ChangeOrderService.transition(
          params.id,
          targetState,
          user.id,
        )
        return { changeOrder: result }
      },
    ),
  ),
)

export default app
```
