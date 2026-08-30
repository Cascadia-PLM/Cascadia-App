# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cascadia is an open-source, code-first Product Lifecycle Management (PLM) system built with Hono (API server) and Vite + TanStack Router (SPA frontend). It replaces traditional low-code PLM systems (like Aras Innovator) with a developer-centric, type-safe approach where all customization happens in code, not through UI configuration.

**Key Philosophy**: Code-first configuration, TypeScript everywhere, enterprise-ready PostgreSQL backend, Git-style versioning for engineering data.

The signature feature is "ECO-as-Branch" - each Engineering Change Order gets its own isolated branch for parallel development.

**See [cascadia-feature-list.md](./cascadia-feature-list.md) for comprehensive feature documentation.**

## Repository Context

This is `Cascadia-PLM/Cascadia-App`, the **public AGPL edition** of Cascadia PLM.
It is dual licensed by Cascadia PLM LLC: this repository is the AGPL v3 half, and
a proprietary edition adds separately licensed modules on top of the same core.

**This tree is generated.** `packages/core` and `apps/cascadia` are composed and
published from the upstream repository, so a change lands there first and arrives
here through the publish pipeline. Contributions are still made by pull request
against this repository — see [CONTRIBUTING.md](./CONTRIBUTING.md) for how an
accepted one reaches `main`, and why it is closed rather than merged.

Related repositories:

| Repository                          | Purpose                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `../DocsSite/`                      | Documentation site                                                                              |
| `../MarketingSite/`                 | Marketing website                                                                               |
| `Cascadia-PLM/Demo-Data`            | TDJ-25 robot-arm demo dataset; publishes `cascadia-demo-data`. Fetched by `npm run demo:fetch`. |
| `Cascadia-PLM/Cascadia-App-archive` | Private. SolidWorks source + STEPs behind the demo dataset.                                     |

## Technology Stack

- **Frontend**: Vite SPA + TanStack Router (file-based routing) + TanStack Query
- **Backend**: Hono API server, TypeScript, Node.js
- **Database**: PostgreSQL 18+ with Drizzle ORM
- **UI**: Tailwind CSS 4 + Radix UI components
- **Auth**: @oslojs/crypto + @oslojs/encoding + Arctic (OAuth)
- **Validation**: TanStack Form + Zod
- **Graph Visualization**: React Flow (@xyflow/react) + Dagre for layout
- **AI Integration**: TanStack AI with Anthropic and OpenAI adapters
- **CAD Conversion**: Python worker with pythonocc-core (STEP/IGES → STL/GLB)
- **Testing**: Vitest (unit) + Playwright (E2E)
- **Message Queue**: RabbitMQ
- **Containerization**: Docker, Docker Compose

## Project Structure

An npm workspace. `packages/core` holds the application; an app under `apps/` is
a composition root plus a build config, choosing which modules exist. This
edition composes core alone — separately licensed modules register into the same
extension points, described under "The extension boundary" below.

```
packages/
└── core/                  The application
    ├── src/
    │   ├── components/    React components (forms, tables, dialogs)
    │   │   ├── ui/        Base UI primitives (Button, Card, DataGrid, …)
    │   │   ├── ai/        AI chatbot panel
    │   │   └── work-instructions/  Authoring and execution
    │   ├── lib/
    │   │   ├── auth/      Authentication & authorization services
    │   │   ├── db/        Drizzle schema & database utilities
    │   │   ├── items/     Item services (Parts, Documents, …)
    │   │   ├── services/  Core services (Branch, Checkout, Commit, …)
    │   │   ├── workflows/ Workflow engine + approval registry
    │   │   ├── jobs/      Background job dispatch, definitions & worker
    │   │   ├── api/       apiHandler, response builders, route registry
    │   │   ├── ui/        Slot registry — named UI extension points
    │   │   ├── query/     TanStack Query keys, options, invalidation graph
    │   │   ├── vault/     File storage system
    │   │   ├── sysml/     SysML v2 serialization
    │   │   ├── ai/        AI chatbot tools, adapters, session service
    │   │   ├── mcp/       MCP servers, built on the AI tool registry
    │   │   └── packages/  Package entitlement registry
    │   ├── routes/        TanStack Router file-based routes
    │   ├── server/        Hono API server
    │   │   ├── index.ts   Entry: mounts every route module under /api/v1/*
    │   │   ├── adapter.ts tagged() factory for consistent OpenAPI tags
    │   │   └── routes/    API route modules — one file per resource
    │   └── __tests__/     Test utilities and fixtures
    ├── test-data/         Component-catalog seed JSON
    └── vite.config.base.ts  Shared Vite config, parameterized by edition

apps/
└── cascadia/              Composition root
    ├── src/modules.{server,client,schema}.ts   Where modules would register
    ├── vite.config.ts     Route composition for this edition
    └── src/{main.tsx,router.tsx,server/,jobs-worker.ts}   Thin entry points

workers/
├── node/             # Node.js job worker Dockerfile
└── cad-converter/    # Python worker: STEP/IGES → STL/GLB (pythonocc)
tests/
├── e2e/              # Playwright E2E tests
│   ├── pages/        # Page object models
│   ├── workflows/    # Workflow-based E2E tests
│   └── fixtures/     # Test fixtures
docs/                 # Architecture & feature documentation
scripts/              # Database seeding, deployment scripts
```

## Development Commands

```bash
# Development
npm run dev           # Start dev server on port 3000
npm run build         # Build for production
npm run serve         # Preview production build

# Database
npm run db:push       # Diff-apply schema directly (dev/CI/demo only — NOT the upgrade path for released installs)
npm run db:generate   # Mint migration SQL into the app's drizzle/ dir. Every schema change commits its migration alongside
npm run db:migrate    # Apply committed migrations (the upgrade path for released installs — see docs/deployment/upgrading.md)
npm run db:baseline   # One-time stamp for pre-v0.5 push-created databases so db:migrate can take over
npm run db:studio     # Open Drizzle Studio GUI
npm run db:seed       # Minimal seed (admin, roles, program, standard library)
npm run db:seed:catalog  # Generic component catalog (fasteners, raw stock)
npm run demo:fetch    # Fetch the demo dataset (required before db:seed:demo)
npm run db:seed:demo  # Full TDJ-25 demo robot-arm dataset (~88 parts, BOM, CAD)

# Database Reset (truncates all tables, then optionally reseeds)
npm run db:reset              # Truncate all tables only (data gone, schema kept)
npm run db:reset:seed         # Truncate + minimal seed
npm run db:drop               # Drop all tables (schema gone, not just data)
npm run db:drop:seed          # Drop + re-push schema + minimal seed

# Testing
npm run test          # Run Vitest tests
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run tests with coverage
npm run test:ui       # Open Vitest UI
npm run test:e2e      # Run Playwright E2E tests
npm run test:e2e:ui   # Run E2E tests with UI
npm run test:e2e:full # Reset database + run E2E tests (clean slate)

# Run a single test file
npx vitest run packages/core/src/lib/services/BranchService.test.ts

# Run tests matching a pattern
npx vitest run -t "should create branch"

# Code Quality
npm run lint          # ESLint (--max-warnings 0)
npm run format        # Prettier
npm run check         # Format + lint fix
npm run openapi:snapshot  # Regenerate docs/api/openapi.v1.json (maintainers — see below)
npm run openapi:check     # Verify the committed OpenAPI snapshot matches
npm run license:check     # Every file carries its SPDX header (CI gate)
npm run boundary:check    # Resolves every import and classifies the target (CI gate)
npm run permissions:check # Every declared permission tuple is one a role holds (CI gate); -- --audience prints who each admits

# Background Workers
npm run workers:dev   # Start RabbitMQ + all workers (Node.js + Python)
npm run workers:stop  # Stop Python workers
npm run workers:logs  # Tail Python worker logs

# Individual workers (if you only need one)
npm run jobs:worker:dev    # Node.js worker only (requires RabbitMQ)
npm run cad:worker:dev     # CAD converter only (Docker)

# Demo Stack (full pre-seeded environment via docker-compose.demo.yml)
npm run demo:up       # Start the demo stack (Postgres, RabbitMQ, app, workers)
npm run demo:down     # Stop the demo stack
npm run demo:reset    # Recreate the demo stack from scratch (wipes demo volumes)
npm run demo:logs     # Tail demo app logs
```

## Lint Warnings Baseline

`npm run lint` runs `eslint --max-warnings 0` — the warning ratchet has reached its floor. **Zero warnings are tolerated**: any new warning fails lint (and CI). Historically the bulk were `@typescript-eslint/no-unnecessary-condition` (over-defensive null/undefined guards the type system already rules out).

Keep it at zero. **Do not raise `--max-warnings` in `package.json` to accommodate a new warning** — fix the warning instead. If a warning is genuinely unavoidable (legitimately-defensive code at a system boundary), disable it per-line with `// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- <reason>` so the suppression is visible and reviewable. The threshold may only ever move down, never up.

## Typecheck

`npm run typecheck` is a **plain zero gate** against `tsconfig.json` — the same config your editor and ESLint see, with `noUncheckedIndexedAccess` on. Any error fails CI, exactly like `eslint --max-warnings 0`. Fix the error; there is no ceiling to raise.

CI runs it as `npm run typecheck:strict` in the **Build** job (not standalone: `apps/*/src/routeTree.gen.ts` is gitignored and generated during `vite build`, and it carries the module augmentation typing every `createFileRoute()` site — so a fresh-checkout tsc job would report a number unrelated to the code).

**The Build job declares no `needs:`, and must not acquire one.** Gating this
gate behind a cheaper one makes it hostage to the weakest check in the workflow:
a prettier failure skips Build, and typecheck with it. That happened on 15 of 18
runs over one week, and two pull requests merged with no type signal at all —
the red X had already been written off as formatting. Do not trade a whole
signal for a couple of runner-minutes.

`noUncheckedIndexedAccess` **must** stay on in `tsconfig.json`. `@tanstack/eslint-config` sets `project: true`, which resolves to the nearest file named `tsconfig.json`; turning it off there makes every legitimate `if (arr[0])` guard a `no-unnecessary-condition` warning — measured at **266 lint problems**, which `--max-warnings 0` rejects.

**History.** This was a two-tier ratchet (`scripts/typecheck.mjs`, `tsconfig.ci.json`) while the counts came down: CORE (nUIA off) reached zero over a run of pull requests, then STRICT (nUIA on) went 1860 → 0 in one. Both files are now deleted. A few notes from that work, since the same shapes will recur:

- `db.insert(...).returning()` destructures use `takeFirst()` from `@/lib/db/take-first`, which throws on an empty result rather than letting `undefined` propagate. Do **not** use it on `.update()`/`.delete()` with a `.where()` — those can legitimately match nothing, so guard and throw `NotFoundError` instead.
- The dominant bug-shape was `if (rows.at(0)) { const x = rows[0] }` — guarding a parallel expression rather than the binding, so nothing narrows. Bind first, then guard.
- `if (k in obj)` does **not** narrow `obj[k]`. This one masked two real crashes in permission checks.
- Route handlers can name their own params (`apiHandler<{ id: string }>`); `adapt()` is generic and asserts the Hono guarantee in one documented place.

A TypeScript version bump can legitimately surface new errors — review such a change, never rubber-stamp it.

## The extension boundary

**Core never reaches into a module.** Extension runs one way: core declares the
extension points, a module registers into them, and core stays unaware of what
registered. That is what lets this edition be built and shipped on its own, and
it is equally the mechanism any module — licensed or your own — plugs into.

A module is a package that registers; it is never imported by core. The
registries core provides:

| Extend                   | Registry                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| Approval voting (server) | `ApprovalRegistry` — `beforeVote` / `afterVote` / `buildExtras`                          |
| ECO release (server)     | `ReleaseHookRegistry` — `afterRelease`, post-commit, warn-only                           |
| Approval dialog (client) | `useApprovalFormSlots` — renders, gates submit, adds request fields                      |
| Any other UI             | `registerSlot()` — core declares the named slots and their props                         |
| API routes               | `registerRoutes(mount, path, app)` — mount points: `api-root`, `admin`, `parts`, `files` |
| AI tools                 | `registerTool()`                                                                         |
| Jobs                     | `JobTypeRegistry.register()` / `.registerHandler()`                                      |
| Cache resources          | `registerResourceDependents()` + declaration merging on `ModuleResources`                |
| Package catalog          | `registerPackage()`                                                                      |
| Schema                   | `apps/*/src/modules.schema.ts` — a re-export, because drizzle-kit reads it statically    |

**Registration happens in a composition root**, never in core:
`apps/*/src/modules.{server,client,schema}.ts`. Order is load-bearing — route
contributions mount while routers are being built, so `registerModules()` must
run _before_ the app is imported. Every server entry uses a dynamic import for
exactly that reason; a static `import app from …` is evaluated first and would
silently yield an app missing the module's endpoints.

**Verification:**

```bash
npm run boundary:check    # resolves every import; catches dynamic import() and id strings
```

It resolves each import specifier to a real path rather than matching text. That
distinction is not academic: two grep-based checks once reported a package fully
seamed while a dynamic `import()` and a bare package-id string were still live.

## Optional Packages

Some functionality is **separately licensed** — an instance only has it when the
package id appears in the `CASCADIA_PACKAGES` environment variable
(comma-separated, or `*`). Read once at process start; there is deliberately no
in-app toggle.

- Registry: `packages/core/src/lib/packages/` — `PackageRegistry.isEnabled(id)`,
  `PackageRegistry.list()`, and `requirePackage(id)` which throws
  `PackageNotLicensedError` (403).
- Client: `usePackageEnabled(id)` from `@/lib/hooks/usePackages` drives
  presentation only. **Always re-check server-side** with `requirePackage()` in
  the route or service — the client answer is a hint, not a gate.
- Admin: `/admin` lists packages read-only via `GET /api/v1/packages`.

**Current packages: none in this edition.** The registry ships here because the
mechanism is core — a build that composes a licensed module needs it — but the
modules themselves are separately licensed and are not part of the AGPL tree.
Full guide: [`docs/development/adding-packages.md`](./docs/development/adding-packages.md).

## Documentation Reference

Comprehensive documentation lives in-repo at [`./docs/`](./docs/README.md).

**Load relevant docs before making significant changes to unfamiliar areas.**

### When to Load Documentation

**Always check docs before:**

- Modifying service layer code (`packages/core/src/lib/services/`, `packages/core/src/lib/items/services/`)
- Working with versioning/branching logic
- Changing ECO/workflow behavior
- Adding or modifying item types
- Touching database schema

**Skip docs for:**

- Simple UI tweaks (styling, layout)
- Bug fixes with clear, isolated scope
- Adding tests for existing code
- Documentation updates themselves

### Documentation Map

| Working In                              | Read First                                     |
| --------------------------------------- | ---------------------------------------------- |
| `packages/core/src/lib/services/`       | `./docs/development/service-patterns.md`       |
| `packages/core/src/lib/items/services/` | `./docs/development/service-patterns.md`       |
| `packages/core/src/server/routes/`      | `./docs/development/adding-api-routes.md`      |
| Versioning, branches, commits           | `./docs/features/versioning.md`                |
| `packages/core/src/lib/db/schema/`      | `./docs/development/database-patterns.md`      |
| Database queries, Drizzle ORM           | `./docs/development/database-patterns.md`      |
| Lifecycles, workflows, change actions   | `./docs/features/workflow-engine.md`           |
| Item type changes                       | `./docs/development/adding-item-types.md`      |
| ECO/Change Order logic                  | `./docs/features/change-management.md`         |
| File vault                              | `./docs/features/file-vault.md`                |
| Auth/permissions                        | `./docs/admin/access-control.md`               |
| UI components / forms                   | `./docs/development/ui-components.md`          |
| Testing patterns                        | `./docs/development/testing.md`                |
| Background jobs                         | `./docs/development/adding-background-jobs.md` |

## Architecture Quick Reference

> For detailed explanations, see `./docs/architecture/overview.md` (and the other files under `./docs/architecture/`).

### Service Quick Reference

| I need to...                                              | Use                                              |
| --------------------------------------------------------- | ------------------------------------------------ |
| CRUD any item                                             | `ItemService`                                    |
| Manage ECO affected items                                 | `ChangeOrderService`                             |
| Release an approved ECO                                   | `ChangeOrderMergeService.merge()`                |
| Checkout item for editing                                 | `CheckoutService.checkout()`                     |
| Get item at a version/commit/tag                          | `VersionResolver.getItemAtContext()`             |
| Create/manage branches                                    | `BranchService`                                  |
| Create commits                                            | `CommitService`                                  |
| Upload/download files                                     | `FileService`                                    |
| Manage programs                                           | `ProgramService`                                 |
| Manage designs                                            | `DesignService`                                  |
| Manage lifecycle transitions                              | `LifecycleService`                               |
| Derive state predicates (released family, initial, final) | `LifecycleService`                               |
| Detect merge conflicts                                    | `ConflictDetectionService`                       |
| Assess ECO impact on items                                | `ImpactAssessmentService`                        |
| AI chatbot conversations                                  | `SessionService` from `@/lib/ai`                 |
| Submit background jobs                                    | `JobService.submit()`                            |
| Register job types                                        | `JobTypeRegistry.register()`                     |
| Wrap an API route handler                                 | `apiHandler()` from `@/lib/api/handler`          |
| Parse & validate query params                             | `parseQuery(request, zodSchema)`                 |
| Check design access                                       | `requireDesignAccess()` from `@/lib/auth/access` |
| Check branch access                                       | `requireBranchAccess()` from `@/lib/auth/access` |

### Core Patterns

**Two-table pattern**: Base fields in `items` table, type-specific fields in `parts`/`documents`/`change_orders`/etc. `ItemService` handles both automatically.

**Branch protection**: Cannot modify items on `main` directly. All changes flow through ECO branches, merged on release.

**Revision assignment**: Revision letters (A, B, C...) are assigned only when merging ECO branch to main, not during work.

**Lifecycle states are configuration, never literals**: no state name appears in application logic. A state carries `isInitial`, `isFinal` (+ `finalKind`), and the roles it plays in change-action mappings; everything else is the configuring user's choice. Every item type has a lifecycle (defaults in `packages/core/src/lib/items/default-lifecycles.ts`). Ask `LifecycleService` — `isReleasedFamilyState`, `isInitialState`, `getFinalStateIds`, `getFinalKind`, `resolveActionStates` — never compare `state === 'Released'`; render with `StateBadge`. See `docs/features/workflow-engine.md`.

**Item types** (13): Part, Document, ChangeOrder, Requirement, Task, TestPlan, TestCase, WorkInstruction, Issue, Tool, Software, WorkOrder, PhysicalPart. All extend `BaseItem` and register via `ItemTypeRegistry` (definitions in `packages/core/src/lib/items/item-type-definitions.ts`, DB handlers in `packages/core/src/lib/items/type-handlers/`).

**Physical traceability**: PhysicalPart (serialized units and lots, non-versioned, Tool pattern) + WorkOrder consumption/production recorded as `Consumes`/`Produces`/`Evidences` edges in `item_relationships` (WO/PhysicalPart always the edge source). Genealogy is derived, never stored; the qualification rollup (`GET /api/v1/work-orders/:id/qualification`) reports requirement satisfaction and uncertified-material gaps. Parts carry `trackingMode` (`none | lot | serial`); the AML lives in `manufacturer_parts`/`part_manufacturer_parts` bound to the part masterId. See `docs/features/physical-parts-and-traceability.md`.

**Work instruction traveler**: WorkInstruction items are pure templates — never executed directly. Work orders instantiate them as traveler lines (`work_order_instructions`, a frozen content snapshot per line with a `requiredCount` of runs); executions (`instruction_executions`) record runs of lines and sign-offs ride executions. Line status is derived from countable runs, WO completion is gated on the traveler (skip-with-reason is the audited escape hatch), and snapshots freeze permanently once a line has executions. See `docs/features/work-order-traveler.md`.

**Software items**: firmware/software configuration items with a content-addressed source store (`software_blobs` + immutable `software_manifests`). The `software.manifestId` pointer rides the item version, so branch isolation and time travel work with no special cases. `SoftwareSourceService` handles imports (files/zip), tree/file/diff reads, and checkout-gated draft editing (`draftManifestId` accumulates edits; an explicit commit promotes the draft and records per-file `source`-category field changes). Software manifest conflicts are sharpened to per-file granularity in `ConflictDetectionService`. See `docs/features/software-management.md`.

**Part types**: Parts have a `partType` field: `Manufacture`, `Purchase`, `Phantom` (logical grouping), or `Software`.

**Organizational hierarchy**: Organization -> Program (permission boundary) -> Design (version container) -> Items

**ECO-as-Branch workflow**:

1. Create ECO -> Creates branch from main
2. Checkout items to ECO -> Items copied to branch
3. Make changes -> Isolated to branch
4. Approve & Release -> Merge to main, assign revision letters

**ECO state changes**: All ECO state transitions go through `POST /api/v1/change-orders/:id/workflow/transition`. When transitioning to a final state (e.g., "Approved"), the endpoint auto-triggers `close()` which merges branches and assigns revisions. There are no separate `/submit`, `/approve`, `/reject`, or `/actions` routes.

**Version Resolution**: Items are resolved per-branch using the `VersionResolver` service, which dynamically computes the current item per masterId per context using `branchItems` lookups and commit ancestry walks. Branch isolation ensures ECO changes don't affect main until merged.

### Data Fetching Pattern

The frontend has **one** cache: the TanStack Query client in `packages/core/src/lib/query/`,
shared with the router through context. Route loaders prime it with
`ensureQueryData`, components read the same query factory with `useQuery`, and
mutations refresh it with `useInvalidateResources()`.

```typescript
// Loader primes the cache — it does not return data.
loaderDeps: ({ search }) => search,
loader: ({ context: { queryClient }, deps }) =>
  queryClient.ensureQueryData(designGridQuery(gridParamsFromSearch(deps))),

// Component reads the same factory — resolves from cache, no second fetch.
const { data } = useQuery(programListQuery())

// Mutation invalidates by resource; dependents follow automatically.
const invalidate = useInvalidateResources()
await apiFetch('/api/v1/designs', { method: 'POST', body })
await invalidate('designs')
```

Keys are built with `qk` (never inline) so prefix invalidation reaches them.
`RESOURCE_DEPENDENTS` in `packages/core/src/lib/query/invalidation.ts` encodes which
resources go stale together — name the resource you wrote, not its dependents.

**Do not** return data from a loader and read it with `useLoaderData()`, call
bare `router.invalidate()`, fetch in `useEffect` + `useState`, patch rows in
local state after a delete, or bump a `refreshTrigger` counter. Those are the
five idioms this layer replaced. Full guide:
[`docs/development/data-fetching.md`](./docs/development/data-fetching.md).

### API Route Pattern

API routes live in `packages/core/src/server/routes/` as Hono modules. Every module mounts under `/api/v1/` and uses the `tagged()` factory so all its handlers carry a consistent OpenAPI tag:

```typescript
import { Hono } from 'hono'
import { tagged } from '../adapter'
const adapt = tagged('Parts') // Tag this file's handlers as "Parts"
import { apiHandler } from '@/lib/api/handler'

const app = new Hono()

// Auth options: { public: true } | {} (auth-only) | { permission: ['resource', 'action'] }
app.get(
  '/:id',
  adapt(
    apiHandler(
      {
        permission: ['parts', 'read'],
        // Optional OpenAPI metadata. Errors (400/401/403/404/500) are added automatically.
        openapi: {
          summary: 'Get a part by ID',
          request: { params: z.object({ id: z.string().uuid() }) },
          responses: {
            200: { schema: z.object({ part: partResponseSchema }) },
          },
        },
      },
      async ({ params, request, user }) => {
        // Return an object → auto-wrapped as { data: { ... } }
        return { example: 'value' }
      },
    ),
  ),
)

export default app
```

Mount new route modules in `packages/core/src/server/index.ts` via `app.route('/api/v1/example', example)`.

For responses needing custom status codes or headers (201 Created, Set-Cookie), return a raw `Response` from within the handler. Use `parseQuery(request, zodSchema)` for validated query parameters. Use `requireDesignAccess`/`requireBranchAccess` from `@/lib/auth/access` for design/branch access checks.

The OpenAPI document is regenerated from these annotations at request time (`/openapi.json`) and served as Scalar UI at `/api/docs`. The committed snapshot at `docs/api/openapi.v1.json` is the frozen v1 contract. **You do not need to regenerate it in a pull request** — the snapshot is refreshed by the maintainers, and `npm run openapi:check` runs on `main` rather than on PRs. See [`docs/api/README.md`](./docs/api/README.md) for the versioning policy.

## Common Tasks

### Adding a Field to an Existing Item Type

1. Add column to schema in `packages/core/src/lib/db/schema/items.ts`
2. Run `npm run db:push` to apply it to your dev database, then mint the migration that ships it: `npm run db:generate`, and commit what appears under `apps/cascadia/drizzle/`
3. Update Zod schema in `packages/core/src/lib/items/types/`
4. Update form component to include new field
5. Update ItemService type-specific methods if needed

### Adding an API Route

1. Add handlers to an existing domain file in `packages/core/src/server/routes/` or create a new one
2. If new file, declare the tag at the top: `const adapt = tagged('YourResource')` (replaces plain `adapt` import)
3. Use `adapt(apiHandler(options, fn))` to define each route handler
4. Declare auth in options: `{ permission: ['resource', 'action'] }`, `{}` (auth-only), or `{ public: true }`
5. Call service layer methods; throw typed errors (`NotFoundError`, `ValidationError`) on failure
6. Return a plain object — it auto-wraps as `{ data: { ... } }` with JSON Content-Type
7. If new file, mount it in `packages/core/src/server/index.ts` via `app.route('/api/v1/newroute', newroute)`
8. Optional but encouraged: add `openapi: { summary, request, responses }` to the handler options to enrich the spec

The committed `docs/api/openapi.v1.json` snapshot is refreshed by the maintainers — leave it out of your PR.

### Adding a Background Job Type

Background jobs use RabbitMQ for async processing. Pattern mirrors ItemTypeRegistry.

**1. Define payload/result schemas** in `packages/core/src/lib/jobs/definitions/yourjob/types.ts`:

```typescript
import { z } from 'zod'

export const myJobPayloadSchema = z.object({
  itemId: z.string(),
  userId: z.string(),
})
export type MyJobPayload = z.infer<typeof myJobPayloadSchema>

export const myJobResultSchema = z.object({
  success: z.boolean(),
  processedCount: z.number(),
})
export type MyJobResult = z.infer<typeof myJobResultSchema>
```

**2. Create job config** in `packages/core/src/lib/jobs/definitions/yourjob/config.ts`:

```typescript
import type { JobTypeConfig } from '../../types'
import { myJobPayloadSchema, myJobResultSchema } from './types'

export const myJobConfig: JobTypeConfig<MyJobPayload, MyJobResult> = {
  type: 'category.action.name', // e.g., 'notification.workflow.transition'
  label: 'My Job Description',
  routingKey: 'jobs.category.action', // RabbitMQ routing key
  payloadSchema: myJobPayloadSchema,
  resultSchema: myJobResultSchema,
  timeout: 60000, // 1 minute
  maxAttempts: 3,
  retryDelays: [30000, 60000, 120000], // Exponential backoff
  priority: 'normal', // 'low' | 'normal' | 'high' | 'critical'
}
```

**3. Create job handler** in `packages/core/src/lib/jobs/node-handlers/yourjob.ts` (for Node.js workers):

```typescript
import type { JobHandler, JobContext } from '../types'
import type { MyJobPayload, MyJobResult } from '../definitions/yourjob/types'

export const myJobHandler: JobHandler<MyJobPayload, MyJobResult> = {
  type: 'category.action.name',

  async execute(
    payload: MyJobPayload,
    context: JobContext,
  ): Promise<MyJobResult> {
    await context.log.info('Starting job', { itemId: payload.itemId })

    // Check for cancellation in loops
    if (context.signal.aborted) throw new Error('Job cancelled')

    // Report progress
    await context.updateProgress(50, 'Processing...')

    // Do work...

    await context.log.info('Job completed')
    return { success: true, processedCount: 10 }
  },
}
```

**4. Register the definition** in `packages/core/src/lib/jobs/definitions/register.ts` and **the handler** in `packages/core/src/lib/jobs/node-handlers/register.ts`:

```typescript
// definitions/register.ts — add config (used by main app for dispatch)
import { myJobConfig } from './yourjob/config'
JobTypeRegistry.register(myJobConfig)

// node-handlers/register.ts — add handler (used only by Node.js worker)
import { myJobHandler } from './yourjob'
JobTypeRegistry.registerHandler(myJobHandler)
```

For Python workers, only register the config in `definitions/register.ts` — the handler lives in `workers/your-worker/`.

**5. Submit jobs** from services or API routes:

```typescript
import { JobService } from '@/lib/jobs'

const job = await JobService.submit(
  'category.action.name',
  { itemId: 'abc', userId: 'user1' },
  userId,
  { priority: 'high', itemId: 'abc' }, // optional: link to item
)
```

## Key Patterns and Conventions

### File Naming

- PascalCase for service classes and components: `BranchService.ts`, `PartForm.tsx`; kebab-case for other lib modules: `default-lifecycles.ts`, `item-type-definitions.ts`
- PascalCase for components: `PartForm.tsx`
- Routes follow TanStack conventions: `parts/$id.tsx`

### TypeScript

- Strict mode enabled, avoid `any` types
- Use Zod schemas for validation and type inference
- Prefer interfaces for object types, type for unions
- Path alias: `@/*` maps to `packages/core/src/*`, then this edition's module package

### Database Queries

- Always use Drizzle ORM, never raw SQL
- Use parameterized queries (Drizzle handles this)
- Prefer `.returning()` for insert/update operations
- Use transactions for multi-step operations — `withTx(tx, fn)` from `@/lib/db` when composing across services (thread the optional `tx?` through), plain `db.transaction()` at a single-service boundary

### UI Components

- Base components in `packages/core/src/components/ui/` (Button, Input, Card, Badge, Dialog, Table, DataGrid, etc.)
- Use `cn()` utility from `@/lib/utils` for class merging
- Use Radix UI primitives for accessible components
- Forms use TanStack Form (`@tanstack/react-form`) + Zod validation
- DataGrid component wraps TanStack Table with sorting, filtering, pagination, and row expansion

### Error Handling

- Service layer throws typed errors from `packages/core/src/lib/errors/` (`NotFoundError`, `ValidationError`, `PermissionDeniedError`, etc.)
- `apiHandler()` catches all errors automatically via `handleApiError` — routes just throw
- Validation errors from Zod are surfaced to forms

### Testing Strategy

- `packages/core/src/__tests__/` - Test utilities and fixtures (import via `@test/` alias)
- `packages/*/src/**/*.test.ts` - Unit/integration tests (co-located)
- `tests/e2e/` - Playwright E2E tests
- **Unit tests**: Vitest with `@testing-library/react` for components
- **Service tests**: Run against a real Postgres via `TestDatabase` (most suites); mocking is the rare exception
- **The suite has its own database.** It runs against `TEST_DATABASE_URL`, never `DATABASE_URL`, and refuses to start without it — it truncates tables and commits shared config rows, so pointed at the dev database it rewrites what you were working on. Provision once with `createdb -U postgres cascadia_test` then `npm run test:db:push`, and add `TEST_DATABASE_URL` to `.env`. Re-run `test:db:push` after a schema change. Nothing is derived or guessed; see `packages/core/src/__tests__/README.md`
- **E2E tests**: Playwright with page object model pattern
- **CI/CD**: GitHub Actions for automated testing
- Key utilities: `TestDatabase` (transaction-per-test), `ConcurrentTestDatabase` (multi-connection race tests), `insertTestUser`/`insertTestUserWithRole`, `seedStandardPartLifecycle`/`overrideItemTypeConfig`
- Tests use forked process pool for parallelization
- Vitest globals enabled (`describe`, `it`, `expect` available without import)

## Testing Philosophy

**Three-gate rule.** Write a test only if the file fails one of these:

1. **Data integrity** — mutates multi-entity state where inconsistency would corrupt data (ECO release, branching, versioning, conflict detection, checkout)
2. **Security** — gates access or verifies identity (auth, permissions, access-control boundaries)
3. **Complex algorithm** — non-obvious logic where reading the code isn't enough (merge logic, workflow state machines, graph traversal)

If a file passes none of the three gates, skip tests. UI components, API routes that just delegate, utilities, schemas, and query-only CRUD services do not need tests. **Deleting a low-value test is usually correct.**

**Prefer invariants over call-shapes.** A good test asserts _what must always be true_ ("after ECO release, every affected item has a new revision letter"). A bad test asserts _what the code happens to do internally_ (`expect(merge).toHaveBeenCalledWith(...)`). Match error **class** (`NotFoundError`, `ValidationError`) or `error.code` — never error-message strings, which are refactor-brittle.

### Running tests

Claude may run tests automatically after meaningful changes. Prefer scoped runs:

- After a service change: `npx vitest run packages/core/src/lib/services/ThatService.test.ts`
- While iterating: `/test-ready --scoped` (lint + tests for changed files only)
- Before a commit: `/test-ready` (lint + full unit suite + tier-1 E2E if UI touched)
- Skip running tests for trivial changes (doc edits, styling, obviously inert refactors)

Use `/write-tests` to evaluate a change against the three gates — it refuses by default unless a gate applies. Use `/test-status` to preview which changed files would trigger the gates.

## Environment Variables

Required in `.env`:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia
NODE_ENV=development
```

Required to run the test suite (a separate database — see Testing Strategy):

```
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia_test
```

Optional:

```
VAULT_ROOT=/path/to/vault   # Default: ./vault (a DB storage setting overrides)
RABBITMQ_URL=amqp://localhost  # For background jobs
```

There is no session secret: sessions are opaque random tokens stored hashed in
the database, so no signing key exists to configure.

## CAD Conversion Worker

**CAD converter** (`workers/cad-converter/`): Python worker using pythonocc-core. Processes STEP/IGES files into STL + GLB (with per-face color preservation). Connects to RabbitMQ for job processing.

## Windows-Specific Notes

- PostgreSQL installed at: `C:\Program Files\PostgreSQL\18\`
- Create database manually: `createdb -U postgres cascadia`
- Path separators: Use forward slashes in imports, Node.js handles conversion

### Line endings

`.gitattributes` sets `* text=auto eol=lf`, so the working tree is LF on every
platform regardless of `core.autocrlf`. CI runs on Linux; this is what keeps a
Windows checkout byte-identical to it.

**Do not** rely on `core.autocrlf` alone. Before this rule existed, a Windows
checkout wrote CRLF and `npm run format:check` flagged **1167 files** — the
whole repo — because Prettier's `endOfLine` default is `lf`. Genuine drift was
invisible in that noise.

If a clone predates the rule, its files are still CRLF on disk and the check is
useless again. Refresh once:

```bash
git rm --cached -r . && git reset --hard
```

Verify with `git ls-files --eol` — every tracked file should report `w/lf`. A
file reporting `w/-text` is being treated as binary (usually a stray NUL byte
in the source) and is silently exempt from all of this.

## Common Pitfalls to Avoid

### TanStack Form + Zod Validation

**Problem**: Zod v4 doesn't implement `StandardSchemaV1` which TanStack Form expects for direct schema usage.

**Wrong** - passing Zod schema directly:

```typescript
const form = useForm({
  validators: {
    onSubmit: myZodSchema, // Won't work with Zod v4
  },
})
```

**Correct** - use the `zodValidator` wrapper:

```typescript
import { zodValidator } from '@/lib/form-validation'

const form = useForm({
  validators: {
    onSubmit: zodValidator(myZodSchema), // Works correctly
  },
})
```

### Form Error Message Access

**Wrong** - errors are strings, not objects with `.message`:

```typescript
error={field.state.meta.errors?.[0]?.message}  // .message doesn't exist
```

**Correct** - cast error directly to string:

```typescript
error={field.state.meta.errors?.[0] as string | undefined}  // Works
```

### TanStack Form useStore

**Wrong** - `form.useStore()` doesn't exist in current API:

```typescript
const value = form.useStore((state) => state.values.fieldName) // Doesn't exist
```

**Correct** - import and use `useStore` with `form.store`:

```typescript
import { useForm, useStore } from '@tanstack/react-form'

const value = useStore(form.store, (state) => state.values.fieldName) // Works
```

### Shared Type Definitions

**Wrong** - duplicating types across files:

```typescript
// In FormA.tsx
interface DesignStatus { ... }

// In FormB.tsx
interface DesignStatus { ... }  // Duplicate, can drift
```

**Correct** - export from one source, import elsewhere:

```typescript
// In DesignPhaseIndicator.tsx
export interface DesignStatus { ... }

// In other files
import { type DesignStatus } from '@/components/versioning/DesignPhaseIndicator'
```

### Drizzle ORM Imports

**Wrong** - using operators without importing them:

```typescript
import { eq, and } from 'drizzle-orm'
// ...
.where(or(condition1, condition2))  // 'or' not imported
```

**Correct** - import all operators you use:

```typescript
import { eq, and, or } from 'drizzle-orm'
```

### Unused Imports

Keep imports clean - remove any imports that aren't used. Common culprits:

- Drizzle operators imported "just in case"
- Schema tables imported but not queried
- Service classes imported but not called

### Database Reset and Reseeding

**Problem**: Running seed scripts multiple times causes duplicate key violations and data conflicts.

**Wrong** - using psql directly or batch files:

```bash
# psql hangs waiting for password, even with PGPASSWORD set
"C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost -d cascadia -c "TRUNCATE..."
```

**Correct** - use the npm scripts that run through Drizzle:

```bash
npm run db:reset              # Truncate all tables
npm run db:reset:seed         # Truncate + minimal seed
```

**Key insight**: Always truncate before reseeding. Seed scripts use `onConflictDoNothing()` for idempotency, but complex seeds with multiple related records can still conflict on unique constraints.

### Postgres Package Bundled into Client Build

**Error:**

```
error during build:
node_modules/postgres/src/connection.js (5:9): "performance" is not exported by "__vite-browser-external"
```

**Root Cause:**
Server-only code (database queries via `postgres` package) is being pulled into the client bundle through import chains.

**Solutions:**

1. **Move shared types to separate files** without database imports:

   ```typescript
   // BAD: packages/core/src/lib/db/schema/config.ts imports drizzle-orm
   import type { RuntimeItemTypeConfig } from '../db/schema/config'

   // GOOD: packages/core/src/lib/items/types/runtime-config.ts has no db imports
   import type { RuntimeItemTypeConfig } from './types/runtime-config'
   ```

2. **Use lazy/dynamic imports** for server-only services:

   ```typescript
   // BAD: Static import pulls db into client
   import { ConfigService } from '../config'

   // GOOD: Dynamic import only loads on server
   const module = await import('../config')
   ```

**Prevention:**

- Keep database imports strictly in `routes/api/`, services, and server-only files
- Use `import type` for types, but ensure the source file doesn't have database imports
- Consider file naming conventions like `*.server.ts` for server-only code

### API Response Structure Mismatch

**Error:**

```
TypeError: Cannot read properties of undefined (reading 'length')
```

**Root Cause:**
API response structure mismatch. The search API returns `{ data: { items: [...] } }` but component accesses `data.items` instead of `data.data.items`.

**Fix:**

```typescript
// BAD
const data = await response.json()
setSearchResults(data.items)

// GOOD
const data = await response.json()
setSearchResults(data.data?.items ?? [])
```

**Prevention:**

- Always check API response structure when implementing new fetch calls
- Use optional chaining (`?.`) and nullish coalescing (`??`) for defensive access

### Cloud SQL Database Empty After Deployment

**Error:**

```
PostgresError: relation "program_members" does not exist
```

**Symptoms:**

- App deploys successfully to Cloud Run
- User can access login page
- All page navigations fail with 500 Internal Server Error

**Root Cause:**
The application was deployed but the database schema was never pushed to Cloud SQL.

**Solutions:**

1. Create a migration Cloud Build step that runs `node scripts/drizzle.mjs migrate` (since v0.5 the committed migrations are the deploy path; `push` is dev/CI-only — see docs/deployment/upgrading.md)
2. Handle Cloud SQL connectivity from Cloud Build
3. Grant Secret Manager access to the Cloud Build service account

**Prevention:**

- Include migration step in deployment pipeline
- Create a health check endpoint that verifies database connectivity

## Deployment and Orchestration

Cascadia supports flexible deployment from single-server to distributed Kubernetes. See `docs/orchestration/` for complete documentation.

### Quick Reference

| Deployment     | Best For                    | Documentation                                    |
| -------------- | --------------------------- | ------------------------------------------------ |
| Single Server  | Development, small teams    | `docs/orchestration/deployments/single-server/`  |
| Distributed    | HA, 50+ users               | `docs/orchestration/deployments/distributed/`    |
| Cloud Database | Managed DB (RDS, Cloud SQL) | `docs/orchestration/deployments/cloud-database/` |
| Kubernetes     | Enterprise, auto-scaling    | `docs/orchestration/deployments/kubernetes/`     |

### Service Components

- **Core App** (`cascadia-app`) - Web UI + API (file vault runs in-process)
- **Jobs Server** (`cascadia-jobs`) - Background processing (optional standalone)
- **CAD Converter** (`cascadia-cad-converter`) - Python STEP/IGES → STL/GLB conversion

### Key Files

- `docker/app.Dockerfile` - Core app container
- `workers/node/Dockerfile` - Node.js jobs worker container
- `workers/cad-converter/Dockerfile` - CAD converter container
- `docs/orchestration/README.md` - Full orchestration guide
- `docs/orchestration/configuration.md` - All environment variables
