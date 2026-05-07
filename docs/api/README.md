# Cascadia API

The Cascadia HTTP API is mounted under `/api/v1/` and described by an OpenAPI 3.1 document.

## Where to find the contract

| Surface             | Path                                | Notes                                                                 |
| ------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| Live spec           | `GET /openapi.json`                 | Generated from route metadata on every request — never stale          |
| Live docs UI        | `GET /api/docs`                     | [Scalar](https://scalar.com/) — try requests interactively            |
| Frozen v1 contract  | `docs/api/openapi.v1.json`          | Snapshot committed to this repo; the authoritative v1 contract        |
| Generation script   | `scripts/snapshot-openapi.ts`       | `npm run openapi:snapshot` rewrites the snapshot from the live app    |

## Versioning policy

- **v1 is frozen** as of the commit that introduced this file. The spec at `docs/api/openapi.v1.json` is the contract external consumers should rely on.
- **Additive changes only** until v2 is cut. New endpoints, new optional fields, new response keys are fine. Removing a field, narrowing a type, or changing a required value is a **breaking change** and requires bumping to `/api/v2/`.
- **Breaking changes** mean a new path prefix (`/api/v2/`), a separate snapshot (`docs/api/openapi.v2.json`), and a deprecation window for `/api/v1/`. Don't mutate v1 in place.

## How the spec is generated

Every route module in `src/server/routes/` declares a default tag at the top of the file:

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

The shared error envelope (400/401/403/404/500) is added automatically by `metadataToSpec` in `src/lib/api/openapi-helpers.ts`. Success payloads are wrapped in the standard `{ data: ... }` envelope.

## CI gate

`npm run openapi:check` regenerates the spec and diffs it against `docs/api/openapi.v1.json`. The CI workflow runs this on every PR — if you change a route's signature or add a new endpoint, you must run `npm run openapi:snapshot` and commit the updated JSON.

## Generating a typed client

External consumers can generate a TypeScript client from the snapshot:

```bash
npx openapi-typescript docs/api/openapi.v1.json -o api-types.d.ts
```

Or use any OpenAPI-compatible toolchain (Kiota, openapi-generator, Stoplight, etc.).
