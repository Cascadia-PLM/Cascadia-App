# Adding API Routes

This guide covers how to add API routes in Cascadia using Hono route modules and the `apiHandler()` wrapper.

## Route Architecture

API routes are defined in `src/server/routes/`, one file per domain. Each file creates a `Hono` app, defines routes using `adapt()` + `apiHandler()`, and exports the app. The routes are mounted in `src/server/index.ts`.

| File                              | Mounted At                  |
| --------------------------------- | --------------------------- |
| `src/server/routes/parts.ts`      | `/api/parts`                |
| `src/server/routes/programs.ts`   | `/api/programs`             |
| `src/server/routes/designs.ts`    | `/api/designs`              |
| `src/server/routes/change-orders.ts` | `/api/change-orders`     |

Route parameters use the `:param` naming convention (e.g., `/:id`, `/:designId/branches`).

## Basic Route Structure

Every API route file creates a `Hono` app, uses `adapt()` to bridge Hono's context to the `apiHandler()` signature, and wraps handlers with `apiHandler()`:

```typescript
// src/server/routes/widgets.ts
import { Hono } from 'hono'
import { adapt } from '../adapter'
import { apiHandler } from '@/lib/api/handler'
import { ItemService } from '@/lib/items/services/ItemService'
import { NotFoundError } from '@/lib/errors'
import '@/lib/items/registerItemTypes.server'

const app = new Hono()

// GET /api/widgets/:id
app.get(
  '/:id',
  adapt(
    apiHandler(
      { permission: ['widgets', 'read'] },
      async ({ params }) => {
        const widget = await ItemService.findById(params.id)
        if (!widget) throw new NotFoundError('Widget', params.id)
        return { widget }
      },
    ),
  ),
)

// PUT /api/widgets/:id
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

// DELETE /api/widgets/:id
app.delete(
  '/:id',
  adapt(
    apiHandler(
      { permission: ['widgets', 'delete'] },
      async ({ params }) => {
        await ItemService.delete(params.id)
        return { success: true }
      },
    ),
  ),
)

export default app
```

Then mount the route in `src/server/index.ts`:

```typescript
import widgets from './routes/widgets'

app.route('/api/widgets', widgets)
```

## The adapt() Bridge

`adapt()` from `src/server/adapter.ts` bridges Hono's `Context` to the `apiHandler()` signature. It extracts `params` and `request` from the Hono context and passes them to the legacy handler:

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

`apiHandler()` from `src/lib/api/handler.ts` wraps every API handler. It provides:

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

### Handler Context

The handler function receives a context object:

```typescript
interface HandlerContext {
  request: Request // Raw HTTP request
  params: TParams // URL parameters (e.g., { id: '...' })
  user: SessionUser // Authenticated user (empty for public routes)
  requestId: string // Unique request ID for tracing
}
```

### Return Values

**Return an object** — auto-wrapped as `{ data: { ... } }` with 200 status:

```typescript
app.get('/:id', adapt(
  apiHandler({}, async ({ params }) => {
    const widget = await ItemService.findById(params.id)
    return { widget }
  })
))
// Response: { "data": { "widget": { ... } } }
```

**Return a Response** — passed through directly (for custom status codes, streaming, cookies):

```typescript
import { created } from '@/lib/api/handler'

app.post('/', adapt(
  apiHandler(
    { permission: ['parts', 'create'] },
    async ({ request, user }) => {
      const data = await request.json()
      const part = await ItemService.create('Part', data, user.id)
      return created({ part })
    },
  )
))
// Response: 201 Created, { "data": { "part": { ... } } }
```

## Request Parsing

### JSON Body

```typescript
app.post('/', adapt(
  apiHandler({}, async ({ request }) => {
    const data = await request.json()
    // data is unknown — validate with Zod or pass to service
  })
))
```

### Query Parameters

Use `parseQuery()` with a Zod schema for validated, typed query parameters:

```typescript
import { apiHandler, parseQuery } from '@/lib/api/handler'
import { paginationSchema } from '@/lib/api/schemas'

app.get('/', adapt(
  apiHandler({}, async ({ request }) => {
    const query = parseQuery(request, paginationSchema)
    // query.limit is number (default 50), query.offset is number (default 0)
  })
))
```

Common query schemas from `src/lib/api/schemas.ts`:

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

URL parameters come from the `params` object. For a route at `/api/parts/:id`:

```typescript
app.get('/:id', adapt(
  apiHandler({}, async ({ params }) => {
    const { id } = params // string
  })
))
```

## Error Handling

**Do not use try/catch in routes.** Just throw errors — `apiHandler` catches them:

```typescript
app.get('/:id', adapt(
  apiHandler({}, async ({ params }) => {
    const part = await ItemService.findById(params.id)
    if (!part) throw new NotFoundError('Part', params.id)
    return { part }
  })
))
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

For responses that need custom status codes, use helpers from `src/lib/api/handler.ts`:

```typescript
import { apiHandler, created, jsonResponse } from '@/lib/api/handler'

// 201 Created
return created({ part })

// Custom status code
return jsonResponse({ results }, 207) // Multi-status
```

Or use response builders from `src/lib/api/response.ts` for more control:

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
  location: `/api/widgets/${widget.id}`,
})
```

## Access Control Helpers

For routes that need design-level or branch-level access checks beyond simple permissions:

```typescript
import { requireDesignAccess, requireBranchAccess } from '@/lib/auth/access'

app.get('/designs/:designId/items', adapt(
  apiHandler({}, async ({ params, user, request }) => {
    await requireDesignAccess(request, params.designId, user)
    // ... user has access to this design
  })
))

app.post('/branches/:branchId/items', adapt(
  apiHandler({}, async ({ params, user, request }) => {
    await requireBranchAccess(request, params.branchId, user)
    // ... user has access to this branch
  })
))
```

## Important Notes

### Mounting New Routes

After creating a new route file, you must import and mount it in `src/server/index.ts`:

```typescript
import widgets from './routes/widgets'

// ... other route mounts ...
app.route('/api/widgets', widgets)
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
// src/server/routes/widgets.ts
import { Hono } from 'hono'
import { adapt } from '../adapter'
import { apiHandler, parseQuery, created } from '@/lib/api/handler'
import { itemListSchema } from '@/lib/api/schemas'
import { ItemService } from '@/lib/items/services/ItemService'
import '@/lib/items/registerItemTypes.server'

const app = new Hono()

// GET /api/widgets
app.get(
  '/',
  adapt(
    apiHandler(
      { permission: ['widgets', 'read'] },
      async ({ request }) => {
        const query = parseQuery(request, itemListSchema)
        const result = await ItemService.search({
          itemType: 'Widget',
          limit: query.limit,
          offset: query.offset,
          search: query.search,
          designId: query.designId,
        })
        return { widgets: result.items, total: result.total }
      },
    ),
  ),
)

// POST /api/widgets
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
// src/server/routes/change-orders.ts (excerpt)
import { Hono } from 'hono'
import { adapt } from '../adapter'
import { apiHandler } from '@/lib/api/handler'

const app = new Hono()

// POST /api/change-orders/:id/workflow/transition
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
