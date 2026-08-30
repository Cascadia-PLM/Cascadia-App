# Cascadia API

The Cascadia HTTP API is mounted under `/api/v1/` and described by an OpenAPI 3.1 document.

## Where to find the contract

| Surface            | Path                          | Notes                                                              |
| ------------------ | ----------------------------- | ------------------------------------------------------------------ |
| Live spec          | `GET /openapi.json`           | Generated from route metadata on every request — never stale       |
| Live docs UI       | `GET /api/docs`               | [Scalar](https://scalar.com/) — try requests interactively         |
| Frozen v1 contract | `docs/api/openapi.v1.json`    | Snapshot committed to this repo; the authoritative v1 contract     |
| Generation script  | `scripts/snapshot-openapi.ts` | `npm run openapi:snapshot` rewrites the snapshot from the live app |

## Versioning policy

- **v1 is frozen** as of the commit that introduced this file. The spec at `docs/api/openapi.v1.json` is the contract external consumers should rely on.
- **Additive changes only** until v2 is cut. New endpoints, new optional fields, new response keys are fine. Removing a field, narrowing a type, or changing a required value is a **breaking change** and requires bumping to `/api/v2/`.
- **One narrow exception: an optional request-body property the server has never stored** may be dropped from the snapshot without cutting v2. Body schemas are non-strict, so such a property is already discarded on arrival — a request that sends it succeeds identically before and after, and the only effect is that a generated client stops offering an input that was a no-op. The exception is the never-stored clause and nothing else: it does not license removing a property the server reads, narrowing a type or a `minLength`, tightening required-ness, or touching any response field. Applied so far to `rationale` on `PUT /api/v1/requirements/{id}` and `taskType` on `PUT /api/v1/tasks/{id}`; record any future use here.
- **Breaking changes** mean a new path prefix (`/api/v2/`), a separate snapshot (`docs/api/openapi.v2.json`), and a deprecation window for `/api/v1/`. Don't mutate v1 in place.
- **The spec's `info.version` is the contract version, not the product version.** It stays `1.0.0` for the life of v1; the product version is reported by `GET /api/v1/health`.

## v1 semantics worth knowing

Deliberate v1 behaviors that look like accidents until written down:

- **Updates are `PUT` with partial semantics.** Update endpoints accept a
  partial body and merge it — there is no `PATCH` in v1, and none will be
  added to it (a semantically strict `PUT`/`PATCH` split is v2 material).
  Omitted fields are left unchanged; explicit `null` clears where the field
  is nullable.
- **Listing goes through `/api/v1/items`.** Type-specific route modules
  (`/parts`, `/documents`, `/requirements`, …) serve detail and actions from
  `GET /:id` up; enumerating items of a type is the items API's job
  (`?types=Part` etc.). `work-orders` carries its own root list for
  historical reasons — grandfathered, not the pattern.
- **Pagination defaults are per-endpoint, and the snapshot is the
  authority.** Most list endpoints default `limit` to 50 via the shared
  pagination schema; some surfaces deliberately differ (admin listings 100,
  enterprise search 25, item search per-branch). New endpoints use the
  shared schema's default unless there is a written reason not to.

## How the spec is generated

Every route module in `packages/core/src/server/routes/` declares a default tag at the top of the file:

```typescript
import { tagged } from '../adapter'
const adapt = tagged('Parts')
```

Handlers use the existing `apiHandler({...}, fn)` pattern and may attach OpenAPI metadata:

```typescript
app.get(
  '/:id',
  adapt(
    apiHandler(
      {
        permission: ['parts', 'read'],
        openapi: {
          summary: 'Get a part by ID',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            200: { schema: z.object({ part: partResponseSchema }) },
          },
        },
      },
      async ({ params }) => {
        // handler logic
      },
    ),
  ),
)
```

The shared error envelope (400/401/403/404/500) is added automatically by `metadataToSpec` in `packages/core/src/lib/api/openapi-helpers.ts`. Success payloads are wrapped in the standard `{ data: ... }` envelope.

## Documenting a request body

Point `request.body.schema` at the Zod schema the route already validates
against — the service's own `xCreateSchema`, not a hand-written copy, or the
two drift and the document becomes fiction:

```typescript
openapi: {
  summary: 'Create a program',
  request: { body: { schema: programCreateSchema } },
  responses: {
    201: { schema: z.object({ program: programResponseSchema }) },
  },
}
```

Three options on the body, all optional:

| Field         | Use                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `mediaType`   | Anything that is not `application/json`. `multipart/form-data` for uploads; describe file parts with `z.file()`. |
| `required`    | `false` for a route that runs on defaults when the body is absent. Defaults to `true`.                           |
| `description` | Long-form notes. Prefer the operation's own `description` — Scalar gives it more room.                           |

Bodies, path params and query params are all described from the **input** side
of the schema, so a field with `.default()` shows as optional with its default
listed rather than as required. `.describe()` on a field carries through to the
document, and is the cheapest way to explain a field an integrator cannot guess.

Note that the schemas are converted here rather than handed to hono-openapi's
`resolver()`: that returns a proxy the generator only awaits for _responses_, so
a resolver in a body position serialises as the literal `{ "vendor": "zod" }`.
`packages/core/src/lib/api/openapi-helpers.test.ts` guards against that
regressing — it is invisible in every other check.

## CI gate

`npm run openapi:check` regenerates the spec and diffs it against `docs/api/openapi.v1.json`. It runs on pushes to `main`, **not on pull requests** — the committed snapshot is refreshed by the maintainers, so adding or changing a route without touching `docs/api/openapi.v1.json` is expected, and nothing in a contributor's PR turns red because of it.

## Generating a typed client

External consumers can generate a TypeScript client from the snapshot:

```bash
npx openapi-typescript docs/api/openapi.v1.json -o api-types.d.ts
```

Or use any OpenAPI-compatible toolchain (Kiota, openapi-generator, Stoplight, etc.).
