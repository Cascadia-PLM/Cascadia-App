# Adding an Optional Package

An **optional package** is a coherent slice of functionality that ships in this
codebase but is only _available_ on instances entitled to it. Packages are how
Cascadia sells capability tiers without maintaining a fork per customer.

This guide covers the framework. For a worked example, read
[Advanced Auditing](../features/advanced-auditing.md), the first package built
on it.

---

## Contents

- [How entitlement works](#how-entitlement-works)
- [The registry](#the-registry)
- [Adding a package](#adding-a-package)
- [Gating server-side](#gating-server-side)
- [Gating the UI](#gating-the-ui)
- [Where package code lives](#where-package-code-lives)
- [Database tables](#database-tables)
- [Testing a package](#testing-a-package)
- [Design rules](#design-rules)

---

## How entitlement works

Entitlement comes from a single environment variable:

```bash
CASCADIA_PACKAGES=advanced-auditing        # one package
CASCADIA_PACKAGES=advanced-auditing,other  # several
CASCADIA_PACKAGES=*                        # everything in the catalog
```

It is parsed once at process start and cached. Unknown ids are logged and
ignored rather than failing startup, so a newer deployment manifest does not
break an older build.

**There is deliberately no in-app toggle.** Entitlement is a deploy-time
property, so an instance administrator can see what they hold but cannot grant
themselves more. Anything that could turn a package on from inside the
application defeats the purpose — do not add a setting, a database column, or an
admin mutation for it.

---

## The registry

Everything lives in `packages/core/src/lib/packages/`:

| File          | Role                                                                     |
| ------------- | ------------------------------------------------------------------------ |
| `types.ts`    | `PackageId` union, `PackageDescriptor`, and the `PackageStatus` wire DTO |
| `catalog.ts`  | `PACKAGE_CATALOG` — every package the build knows about                  |
| `registry.ts` | `PackageRegistry` — parses the env var, answers `isEnabled` / `list`     |
| `guard.ts`    | `requirePackage(id)` — throws `PackageNotLicensedError` (HTTP 403)       |

```typescript
import { PackageRegistry, requirePackage } from '@/lib/packages'

PackageRegistry.isEnabled('advanced-auditing') // boolean, no throw
PackageRegistry.enabled() // Array<PackageId>
PackageRegistry.list() // Array<PackageStatus>, for the admin UI
requirePackage('advanced-auditing') // throws unless licensed
```

`PackageRegistry.reset()` clears the cache. It exists for tests that mutate
`process.env` and has no production use.

---

## Adding a package

**1. Add the id to the union** in `packages/core/src/lib/packages/types.ts`:

```typescript
export type PackageId = 'advanced-auditing' | 'your-package'
```

**2. Describe it** in `packages/core/src/lib/packages/catalog.ts`. The description and feature
list are what an administrator sees at `/admin`, so write them for a buyer, not
for a developer:

```typescript
export const PACKAGE_CATALOG: Record<PackageId, PackageDescriptor> = {
  // ...
  'your-package': {
    id: 'your-package',
    name: 'Your Package',
    description: 'One sentence on what the customer gets.',
    features: [
      'Concrete capability, not an implementation detail',
      'Another one',
    ],
  },
}
```

That is the whole registration step — `ALL_PACKAGE_IDS`, the admin listing, the
`GET /api/v1/packages` response, and `isPackageId()` all derive from the
catalog.

**3. Put the code under its own directory**, `packages/core/src/lib/your-package/`, so the
licensing boundary is legible at a glance.

**4. Gate every entry point** (below).

**5. Document it** — add `docs/features/your-package.md`, list it in the
Optional Packages table in [`docs/README.md`](../README.md), add its environment
variables to [`docs/orchestration/configuration.md`](../orchestration/configuration.md)
and `.env.example`, and add a row to the package table in the repository
`CLAUDE.md`.

---

## Gating server-side

**The server is the only real gate.** Call `requirePackage()` at the entry point
of anything the package adds:

```typescript
// In a route handler
app.get(
  '/:id',
  adapt(
    apiHandler({ permission: ['parts', 'read'] }, async ({ params }) => {
      requirePackage('your-package')
      return YourService.get(params.id)
    }),
  ),
)
```

```typescript
// Or in the service, when several routes share it
static async doTheThing(...) {
  requirePackage('your-package')
  // ...
}
```

Prefer gating in the service when a capability has more than one caller — that
way a new route cannot forget the check. `PackageNotLicensedError` maps to a 403
with code `PACKAGE_NOT_LICENSED` automatically via `handleApiError`.

### Gating behavior, not just endpoints

A package may also _change_ how existing behavior works rather than adding new
endpoints. In that case, branch on `PackageRegistry.isEnabled()` at the single
chokepoint the behavior flows through, and make the licensed path the stricter
one:

```typescript
// WorkflowApprovalService.submitApproval — every approval route goes through here
const signatureRequired = PackageRegistry.isEnabled('advanced-auditing')
if (signatureRequired && !signing) {
  throw new SignatureRequiredError('submit an approval')
}
```

Use `isEnabled()` (which returns a boolean) rather than `requirePackage()`
(which throws) when the unlicensed path is a legitimate outcome.

### Reporting state without throwing

An endpoint that exists to _describe_ capability should report entitlement
rather than 403, so the client can render the right thing instead of handling an
error. `GET /api/v1/signatures/capability` does this — it answers
`packageEnabled: false` on an unlicensed instance.

---

## Gating the UI

The client hook drives **presentation only**:

```tsx
import { usePackageEnabled } from '@/lib/hooks/usePackages'

function YourPanel() {
  const { enabled, loading } = usePackageEnabled('your-package')

  if (loading) return <Spinner />
  if (!enabled) return null

  return <ThePanel />
}
```

`usePackages()` fetches `GET /api/v1/packages` once and shares the result, since
entitlement cannot change while the process is running.

> **The client answer is a hint, not a gate.** A user who edits the response in
> their browser must gain nothing. Always re-check server-side.

`loading` matters: it distinguishes "not licensed" from "not known yet", so a
panel does not flash in and out on first paint.

---

## Where package code lives

| Concern         | Location                                          |
| --------------- | ------------------------------------------------- |
| Services, logic | `packages/core/src/lib/your-package/`             |
| Database schema | `packages/core/src/lib/db/schema/your-package.ts` |
| API routes      | `packages/core/src/server/routes/your-thing.ts`   |
| UI components   | `packages/core/src/components/your-package/`      |
| Tests           | Co-located, `*.test.ts`                           |

Keeping the package under its own directory means a reviewer can see what is
covered by which licence without tracing imports.

---

## Database tables

Package tables live in the shared schema and ship in the normal migration
sequence, so an unlicensed instance still has the tables — it simply never
writes to them. This keeps `db:push`, `db:migrate`, and the drizzle snapshots
uniform across all instances.

Two follow-ups when you add tables:

1. Export the new schema file from `packages/core/src/lib/db/schema/index.ts`.
2. Add the table names to `ALL_TABLES` in `scripts/truncate-all.ts`, or
   `npm run db:reset` will leave rows behind.

---

## Testing a package

Tests must cover **both** entitlement states — that the feature works when
licensed, and that it is unreachable when not:

```typescript
describe('package gating', () => {
  const original = process.env.CASCADIA_PACKAGES

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CASCADIA_PACKAGES
    } else {
      process.env.CASCADIA_PACKAGES = original
    }
    PackageRegistry.reset()
  })

  it('refuses the operation on an unlicensed instance', async () => {
    delete process.env.CASCADIA_PACKAGES
    PackageRegistry.reset()

    await expect(YourService.doTheThing()).rejects.toMatchObject({
      code: ErrorCode.PACKAGE_NOT_LICENSED,
    })
  })
})
```

Always restore the original environment and call `PackageRegistry.reset()` in
`afterEach` — the cache is module-level and leaks across test files otherwise.

Per the [three-gate rule](./testing.md), entitlement is a **security** gate, so
it warrants tests even when the feature it protects would not.

---

## Design rules

- **Server-side is the gate; the client is a hint.** Every gated capability
  re-checks entitlement server-side.
- **No in-app toggle, ever.** No setting, no admin mutation, no database flag.
- **Fail closed.** An unrecognized or missing `CASCADIA_PACKAGES` enables
  nothing. A substring match is not a match — only exact ids count.
- **One directory per package** so the licensing boundary stays legible.
- **Gate at chokepoints, not at call sites.** One check a new caller cannot
  bypass beats five checks a new caller can forget.
- **Errors name the package.** `PackageNotLicensedError` reports the display
  name, so the 403 tells an administrator what to buy rather than what broke.

---

## Related documentation

- [Advanced Auditing](../features/advanced-auditing.md) — the reference package
- [Adding API Routes](./adding-api-routes.md) — route and `apiHandler` conventions
- [Configuration](../orchestration/configuration.md) — all environment variables
- [Testing](./testing.md) — the three-gate rule
