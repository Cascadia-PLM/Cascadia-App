# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cascadia is an open-source, code-first Product Lifecycle Management (PLM) system built with Hono (API server) and Vite + TanStack Router (SPA frontend). It replaces traditional low-code PLM systems (like Aras Innovator) with a developer-centric, type-safe approach where all customization happens in code, not through UI configuration.

**Key Philosophy**: Code-first configuration, TypeScript everywhere, enterprise-ready PostgreSQL backend, Git-style versioning for engineering data.

The signature feature is "ECO-as-Branch" - each change order gets its own isolated branch for parallel development.

**See [cascadia-feature-list.md](./cascadia-feature-list.md) for comprehensive feature documentation.**

## Repository Context

This is `Cascadia-PLM/Cascadia-App`, the Cascadia PLM repository. Everything in
it is AGPL v3 — core, the design engine module and every worker — and there is
one app, built from `cascadia-app/`. Cascadia PLM LLC also offers the same code
under a commercial license for organizations that cannot use the AGPL — see
[LICENSING.md](./LICENSING.md).

Every change lands here by pull request. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for how to contribute.

Each module package keeps a short guide of its own beside its `package.json`
(`cascadia-design-engine/CLAUDE.md`). Read it before working in that package.

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

An npm workspace. Every workspace is a top-level `cascadia-<id>/` directory
whose npm name is `@cascadia/<id>` — `scripts/workspaces.mjs` spells
that convention out once. The application is four Node packages with a
one-way dependency graph, one module package (`cascadia-design-engine`) that
plugs into them, four Python packages that are not npm workspaces, and an app
(`cascadia-app`), which is a composition root plus a build config, choosing
which modules exist. The module registers into core's extension points,
described under "The extension boundary" below; core never imports it.

```
@cascadia/web  ──►  @cascadia/commons  ◄──  @cascadia/api  ◄──  @cascadia/workers-job
```

- **`@cascadia/commons`** (`cascadia-commons`) — code both sides
  share: item Zod schemas and definitions, permissions, lifecycle types, the
  import parser, and every _wire type_ the client names (thread nodes,
  conflicts, checkout status, file records, …). Depends on nothing else in
  the workspace, and on no server-only npm package.
- **`@cascadia/api`** (`cascadia-api`) — the Hono server: routes,
  services, the Drizzle schema, jobs, events, extensions, MCP, the test
  helpers and fixtures (they need the database).
- **`@cascadia/web`** (`cascadia-web`) — the Vite SPA: routes,
  components, hooks, the query layer, the API client, styles.
- **`@cascadia/workers-job`** (`cascadia-workers-job`) — the Node.js jobs
  worker: the RabbitMQ consumer, the retry scheduler and the job handlers.
  Sits above the api (it runs the handlers, which call the services); the api
  never imports it — `JobService.submit` needs a job's _definition_, which
  stays in the api, never its handler.
- **`@cascadia/design-engine`** (`cascadia-design-engine`) — a module: the
  collaborative AI design engine and the generative CAD it drives. Depends on
  api, web and commons; nothing depends on it except the app's composition
  roots. See "Collaborative Design Engine" below.
- **`cascadia-workers-cad`** and **`cascadia-workers-commons`** — Python: the
  STEP/IGES → STL/GLB converter and the jobs/vault database layer every
  Python worker imports via `PYTHONPATH`.
- **`cascadia-workers-cad-generator`** and **`cascadia-workers-freecad-runner`**
  — Python: the CadQuery generator (parametric parts, mechanisms, assembly
  STEPs) and the headless FreeCAD runner (AI-written scripts), both serving the
  design engine.

**The web never imports the api.** Its tsconfig maps no `@cascadia/api/*`
path and the Vite alias plugin refuses the specifier, so a component that
reaches for a service or the schema fails to resolve rather than shipping
`postgres` to the browser. `npm run boundary:check` states the rule and
enforces it on resolved paths. When the client needs a type a service
declares, move the type into commons and re-export it from the service — see
`thread/types.ts` or `services/types/*.ts` for the pattern.

```
cascadia-commons/      Shared by api and web
└── src/
    ├── items/types/   Zod schemas per item type; item-type-definitions.ts
    ├── auth/          permissions.ts (roles, resources, actions), types
    ├── errors/        Error codes, the API error envelope, ApiError, retry
    ├── import/        CSV/XLSX import parsing, mapping, validation
    ├── lifecycles/    Lifecycle & workflow types, normalize
    ├── services/types/ Wire types the services compute and the UI renders
    ├── thread/        Digital-thread wire types
    ├── vault/         File categories, preview, annotations, wire types
    └── types/         Design/Program rows, BOM, Serialized<T>, assert
cascadia-api/          The server
├── src/
│   ├── auth/          Authentication & authorization services
│   ├── db/            Drizzle schema & database utilities
│   ├── items/         Item services, type handlers, registry
│   ├── services/      Core services (Branch, Checkout, Commit, …)
│   ├── lifecycles/    Lifecycle engine + approval registry
│   ├── jobs/          Job submission: JobService, registry, definitions, RabbitMQ client
│   ├── api/           apiHandler, response builders, route registry
│   ├── events/        Domain event log, consumers, webhooks
│   ├── extensions/    Extension registry and the public surface
│   ├── vault/         File storage services and adapters
│   ├── sysml/         SysML v2 serialization
│   ├── ai/            AI chatbot tools, adapters, session service
│   ├── mcp/           MCP servers, built on the AI tool registry
│   ├── packages/      Package entitlement registry
│   ├── server/        Hono API server
│   │   ├── index.ts   Entry: mounts every route module under /api/v1/*
│   │   ├── adapter.ts tagged() factory for consistent OpenAPI tags
│   │   └── routes/    API route modules — one file per resource
│   └── __tests__/     Test utilities and fixtures (database-backed)
└── test-data/         Component-catalog seed JSON
cascadia-web/          The client
├── src/
│   ├── components/    React components (forms, tables, dialogs)
│   │   ├── ui/        Base UI primitives (Button, Card, DataGrid, …)
│   │   ├── ai/        AI chatbot panel
│   │   └── work-instructions/  Authoring and execution
│   ├── query/         TanStack Query keys, options, invalidation graph
│   ├── hooks/         React hooks
│   ├── api/           apiFetch client, generated OpenAPI types
│   ├── ui/            Slot registry — named UI extension points
│   ├── routes/        TanStack Router file-based routes
│   └── styles.css     Tailwind entry
└── vite.config.base.ts  Shared Vite config, parameterized by app
cascadia-workers-job/  The Node.js jobs worker
├── src/
│   ├── main.ts        runJobsWorker(): queue naming, health server, shutdown
│   ├── worker/        The RabbitMQ consumer and job execution
│   ├── scheduler.ts   Parked-retry sweep, dead-letter depth, maintenance registry
│   ├── handlers/      One handler per job type
│   └── register.ts    Registers the handlers into JobTypeRegistry
└── Dockerfile         → ghcr.io/cascadia-plm/cascadia-jobs-worker
cascadia-design-engine/  Module: collaborative AI design + generative CAD
└── src/               Mirrors the application's layout
    ├── register.server.ts  What it contributes to the server
    ├── register.client.ts  … and to the browser bundle
    ├── design-engine/      The engine: stages/, tools/, prompts/, materialize
    ├── cad-generation/     FreeCAD agent, assembly planner/renderer, DFM rules
    └── components/, routes/, server/routes/, jobs/, db/schema/, …
cascadia-workers-cad/  Python worker: STEP/IGES → STL/GLB (pythonocc)
└── Dockerfile         → ghcr.io/cascadia-plm/cascadia-cad-converter
cascadia-workers-cad-generator/   Python worker: parametric CAD + assemblies (CadQuery)
cascadia-workers-freecad-runner/  Python worker: headless FreeCAD running AI-written scripts
cascadia-workers-commons/  Python: jobs/vault DB layer shared by the Python workers
cascadia-app/          Composition root
├── src/modules.{server,client,schema}.ts   Where modules register
├── vite.config.ts     Route composition: web routes + module routes
├── drizzle/           The committed migrations
├── src/{main.tsx,router.tsx,server/,jobs-worker.ts}   Thin entry points
├── public/            Static assets (favicon, logo) — copied into the build
└── Dockerfile         → ghcr.io/cascadia-plm/cascadia-app

tests/
├── e2e/              # Playwright E2E tests
│   ├── pages/        # Page object models
│   ├── workflows/    # Workflow-based E2E tests
│   └── fixtures/     # Test fixtures
docs/                 # Architecture & feature documentation
scripts/              # Database seeding, deployment scripts
```

The app's _name_ and its directory differ: `cascadia` lives in `cascadia-app/`.
The name namespaces the build output (`dist/cascadia/`, `.output/cascadia/`);
`scripts/app.mjs` holds both, and every root script reads them from there.

Paths were preserved across the splits, then flattened: a file that was
`packages/core/src/lib/x.ts` became `packages/cascadia-<pkg>/src/lib/x.ts`,
then `cascadia-<pkg>/src/lib/x.ts`, and is now `cascadia-<pkg>/src/x.ts`
([Cascadia-App#117](https://github.com/Cascadia-PLM/Cascadia-App/pull/117)
removed the `lib/` layer, and the module packages dropped theirs with it). So
`@/x` means what `@/lib/x` did, inside whichever package holds it, and
`git log --follow` crosses every move for any file. The one exception is the
job worker, which public's flatten cut out of the api:
`lib/jobs/node-handlers/*.ts` became `cascadia-workers-job/src/handlers/*.ts`,
`lib/jobs/worker/` and `lib/jobs/scheduler.ts` moved under that package's
`src/`, and `jobs-worker-main.ts` is its `main.ts`. The module packages keep
their own handlers under `src/jobs/node-handlers/`.

The design engine's history before November 2026 is not in this repository:
`git log` for its files starts at the commit that added them.

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
npm run demo:fetch    # Fetch the demo datasets (required before seed:demo)
npm run seed:demo     # All three demo datasets: TDJ-25 robot arm, FreeCAD/KiCad PUC cart + USV catamaran, and standard-library components
npm run seed:demo -- --only robot-arm   # ...or just one of them (robot-arm | freecad | standard-library)

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
npx vitest run cascadia-api/src/services/BranchService.test.ts

# Run tests matching a pattern
npx vitest run -t "should create branch"

# Code Quality
npm run lint          # ESLint (--max-warnings 0)
npm run format        # Prettier
npm run check         # Format + lint fix
npm run openapi:snapshot  # Regenerate the committed OpenAPI snapshot after a route change (every snapshot this tree has an app for)
npm run openapi:check     # Verify the committed OpenAPI snapshot matches (CI gate)
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
npm run cadgen:worker:dev  # CadQuery CAD generator only (Docker) — design engine
npm run freecad:worker:dev # FreeCAD runner only (Docker) — design engine

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

CI runs it as `npm run typecheck:strict` in the **Build** job (not standalone: `cascadia-app/src/routeTree.gen.ts` is gitignored and generated during `vite build`, and it carries the module augmentation typing every `createFileRoute()` site — so a fresh-checkout tsc job would report a number unrelated to the code).

**The Build job declares no `needs:`, and must not acquire one.** Gating this
gate behind a cheaper one makes it hostage to the weakest check in the workflow:
a prettier failure skips Build, and typecheck with it. That happened on 15 of 18
runs over one week, and two pull requests merged with no type signal at all —
the red X had already been written off as formatting. Do not trade a whole
signal for a couple of runner-minutes.

`noUncheckedIndexedAccess` **must** stay on in `tsconfig.json`. `@tanstack/eslint-config` sets `project: true`, which resolves to the nearest file named `tsconfig.json`; turning it off there makes every legitimate `if (arr[0])` guard a `no-unnecessary-condition` warning — measured at **266 lint problems**, which `--max-warnings 0` rejects.

**History.** This was a two-tier ratchet (`scripts/typecheck.mjs`, `tsconfig.ci.json`) while the counts came down: CORE (nUIA off) reached zero over a run of pull requests, then STRICT (nUIA on) went 1860 → 0 in one. Both files are now deleted. A few notes from that work, since the same shapes will recur:

- `db.insert(...).returning()` destructures use `takeFirst()` from `@/db/take-first`, which throws on an empty result rather than letting `undefined` propagate. Do **not** use it on `.update()`/`.delete()` with a `.where()` — those can legitimately match nothing, so guard and throw `NotFoundError` instead.
- The dominant bug-shape was `if (rows.at(0)) { const x = rows[0] }` — guarding a parallel expression rather than the binding, so nothing narrows. Bind first, then guard.
- `if (k in obj)` does **not** narrow `obj[k]`. This one masked two real crashes in permission checks.
- Route handlers can name their own params (`apiHandler<{ id: string }>`); `adapt()` is generic and asserts the Hono guarantee in one documented place.

A TypeScript version bump can legitimately surface new errors — review such a change, never rubber-stamp it.

## The extension boundary

**Core never reaches into a module.** Extension runs one way: core declares the
extension points, a module registers into them, and core stays unaware of what
registered. That is what keeps core buildable and testable without any module,
and it is the same mechanism the design engine and any module of your own plug
into. A module's licence does not change the rule: `cascadia-design-engine` is
AGPL and ships in this tree, and core still never imports it.

A module is a package that registers; it is never imported by core. The
registries core provides:

| Extend                        | Registry                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| Approval voting (server)      | `ApprovalRegistry` — `beforeVote` / `afterVote` / `buildExtras`                                     |
| Change-order release (server) | A `consumed` extension on `design.released` (`ReleaseHookRegistry` is deprecated, zero registrants) |
| Approval dialog (client)      | `useApprovalFormSlots` — renders, gates submit, adds request fields                                 |
| Any other UI                  | `registerSlot()` — core declares the named slots and their props                                    |
| API routes                    | `registerRoutes(mount, path, app)` — mount points: `api-root`, `admin`, `parts`, `files`            |
| AI tools                      | `registerTool()`                                                                                    |
| Jobs                          | `JobTypeRegistry.register()` / `.registerHandler()`                                                 |
| Recurring maintenance         | `registerMaintenanceJobType()` — the jobs worker's sweep submits it on the module's own period      |
| Cache resources               | `registerResourceDependents()` + declaration merging on `ModuleResources`                           |
| Schema                        | `cascadia-app/src/modules.schema.ts` — a re-export, because drizzle-kit reads it statically         |

**Registration happens in a composition root**, never in core:
`cascadia-app/src/modules.{server,client,schema}.ts`. Order is load-bearing — route
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
Since the module ships in the same tree and is built with core, a core file that
imported it would compile and run — this check is the only thing that says no.

## Documentation Reference

Comprehensive documentation lives in-repo at [`./docs/`](./docs/README.md).

**Load relevant docs before making significant changes to unfamiliar areas.**

### When to Load Documentation

**Always check docs before:**

- Modifying service layer code (`cascadia-api/src/services/`, `cascadia-api/src/items/services/`)
- Working with versioning/branching logic
- Changing change-order or lifecycle behavior
- Adding or modifying item types
- Touching database schema

**Skip docs for:**

- Simple UI tweaks (styling, layout)
- Bug fixes with clear, isolated scope
- Adding tests for existing code
- Documentation updates themselves

### Documentation Map

| Working In                            | Read First                                     |
| ------------------------------------- | ---------------------------------------------- |
| `cascadia-api/src/services/`          | `./docs/development/service-patterns.md`       |
| `cascadia-api/src/items/services/`    | `./docs/development/service-patterns.md`       |
| `cascadia-api/src/server/routes/`     | `./docs/development/adding-api-routes.md`      |
| Versioning, branches, commits         | `./docs/features/versioning.md`                |
| `cascadia-api/src/db/schema/`         | `./docs/development/database-patterns.md`      |
| Database queries, Drizzle ORM         | `./docs/development/database-patterns.md`      |
| Lifecycles, instances, change actions | `./docs/features/workflow-engine.md`           |
| Item type changes                     | `./docs/development/adding-item-types.md`      |
| Change-order logic                    | `./docs/features/change-management.md`         |
| File vault                            | `./docs/features/file-vault.md`                |
| Auth/permissions                      | `./docs/admin/access-control.md`               |
| UI components / forms                 | `./docs/development/ui-components.md`          |
| Component size, refactor-on-touch     | `./docs/development/ui-components.md`          |
| Data fetching, caching, invalidation  | `./docs/development/data-fetching.md`          |
| Testing patterns                      | `./docs/development/testing.md`                |
| Background jobs                       | `./docs/development/adding-background-jobs.md` |
| Domain events, the event log          | `./docs/development/adding-domain-events.md`   |
| Extensions, the three phases          | `./docs/development/writing-extensions.md`     |
| Webhooks, building a receiver         | `./docs/features/webhooks.md`                  |
| Demo data and seeding                 | `./docs/development/demo-datasets.md`          |
| MCP servers, AI tool registry         | `./docs/features/mcp.md`                       |
| `cascadia-design-engine/`, its stages | `./docs/features/design-engine.md`             |
| Generative CAD, the FreeCAD agent     | `./docs/features/cad-services.md`              |
| The Python workers' test suites       | `./docs/development/python-worker-tests.md`    |

## Architecture Quick Reference

> For detailed explanations, see `./docs/architecture/overview.md` (and the other files under `./docs/architecture/`).

### Service Quick Reference

| I need to...                                              | Use                                                               |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| CRUD any item                                             | `ItemService`                                                     |
| Manage change-order affected items                        | `ChangeOrderService`                                              |
| Release an approved change order                          | `ChangeOrderMergeService.merge()`                                 |
| Checkout item for editing                                 | `CheckoutService.checkout()`                                      |
| Get item at a version/commit/tag                          | `VersionResolver.getItemAtContext()`                              |
| Create/manage branches                                    | `BranchService`                                                   |
| Create commits                                            | `CommitService`                                                   |
| Upload/download files                                     | `FileService`                                                     |
| Manage programs                                           | `ProgramService`                                                  |
| Manage designs                                            | `DesignService`                                                   |
| Manage lifecycle transitions                              | `LifecycleService`                                                |
| Derive state predicates (released family, initial, final) | `LifecycleService`                                                |
| Detect merge conflicts                                    | `ConflictDetectionService`                                        |
| Assess change-order impact on items                       | `ImpactAssessmentService`                                         |
| AI chatbot conversations                                  | `SessionService` from `@/ai`                                      |
| Submit background jobs                                    | `JobService.submit()`                                             |
| Queue a route's work and answer 202 (503 if no queue)     | `submitForRequest()` + `jobAccepted()`                            |
| Write a sheet import / item batch-create (worker side)    | `ImportService` / `BatchCreateService`                            |
| Register job types                                        | `JobTypeRegistry.register()`                                      |
| Wrap an API route handler                                 | `apiHandler()` from `@/api/handler`                               |
| Parse & validate query params                             | `parseQuery(request, zodSchema)`                                  |
| Check design access                                       | `requireDesignAccess()` from `@/auth/access`                      |
| Check branch access                                       | `requireBranchAccess()` from `@/auth/access`                      |
| Collaborative design sessions (design-engine module)      | `DesignSessionService` from `@/design-engine`                     |
| Run design engine stages                                  | `CollaborativeDesignEngine` from `@/design-engine`                |
| Materialize a design session into PLM items               | `MaterializationService` from `@/design-engine`                   |
| Generate CAD from text                                    | `generateAllParts()` from `@/cad-generation`                      |
| Generate one part with the FreeCAD agent                  | `generatePartWithFreecad()` from `@/cad-generation/freecad-agent` |
| Plan assembly composition                                 | `AssemblyPlanner` from `@/cad-generation`                         |

### Core Patterns

**Two-table pattern**: Base fields in `items` table, type-specific fields in `parts`/`documents`/`change_orders`/etc. `ItemService` handles both automatically.

**Branch protection**: Once anything in a design is released, `main` is protected and changes flow through change-order branches, merged on release. What it protects is the program's `settings.branchProtectionScope`: `design` (the default) protects every item in the design; `released-items` protects released items **and everything beneath one in the BOM on main** (a released assembly does not require released children, so without that a Draft child could change it), leaving other drafts editable on main. Free/Driving-lifecycle types are exempt either way. `canEditOnMain` (`cascadia-api/src/items/branch-protection.ts`) is the one verdict — every gate, the edit-context and the AI tools ask it; never re-derive it. Changing the scope takes `system:manage` and emits `program.branch_protection_scope_changed`. See `docs/features/versioning.md`.

**Revision assignment**: Revision letters (A, B, C...) are assigned only when merging a change-order branch to main, not during work.

**Lifecycle states are configuration, never literals**: no state name appears in application logic. A state carries `isInitial`, `isFinal` (+ `finalKind`), and the roles it plays in change-action mappings; everything else is the configuring user's choice. Every item type has a lifecycle (defaults in `cascadia-api/src/items/default-lifecycles.ts`). Ask `LifecycleService` — `isReleasedFamilyState`, `isInitialState`, `getFinalStateIds`, `getFinalKind`, `resolveActionStates` — never compare `state === 'Released'`; render with `StateBadge`. See `docs/features/workflow-engine.md`.

**Item types** (15): Part, Document, ChangeOrder, Requirement, SystemElement, Interface, Task, TestPlan, TestCase, WorkInstruction, Issue, Tool, Software, WorkOrder, PhysicalPart. All extend `BaseItem` and register via `ItemTypeRegistry` (definitions in `cascadia-commons/src/items/item-type-definitions.ts`, DB handlers in `cascadia-api/src/items/type-handlers/`).

**Physical traceability**: PhysicalPart (serialized units and lots, non-versioned, Tool pattern) + WorkOrder consumption/production recorded as `Consumes`/`Produces`/`Evidences` edges in `item_relationships` (WO/PhysicalPart always the edge source). Genealogy is derived, never stored; the qualification rollup (`GET /api/v1/work-orders/:id/qualification`) reports requirement satisfaction and uncertified-material gaps. Parts carry `trackingMode` (`none | lot | serial`); the AML lives in `manufacturer_parts`/`part_manufacturer_parts` bound to the part masterId. See `docs/features/physical-parts-and-traceability.md`.

**Work instruction traveler**: WorkInstruction items are pure templates — never executed directly. Work orders instantiate them as traveler lines (`work_order_instructions`, a frozen content snapshot per line with a `requiredCount` of runs); executions (`instruction_executions`) record runs of lines and sign-offs ride executions. Line status is derived from countable runs, WO completion is gated on the traveler (skip-with-reason is the audited escape hatch), and snapshots freeze permanently once a line has executions. See `docs/features/work-order-traveler.md`.

**Software items**: firmware/software configuration items with a content-addressed source store (`software_blobs` + immutable `software_manifests`). The `software.manifestId` pointer rides the item version, so branch isolation and time travel work with no special cases. `SoftwareSourceService` handles imports (files/zip), tree/file/diff reads, and checkout-gated draft editing (`draftManifestId` accumulates edits; an explicit commit promotes the draft and records per-file `source`-category field changes). Software manifest conflicts are sharpened to per-file granularity in `ConflictDetectionService`. See `docs/features/software-management.md`.

**Part types**: Parts have a `partType` field: `Manufacture`, `Purchase`, `Phantom` (logical grouping), or `Software`.

**Organizational hierarchy**: Organization -> Program (permission boundary) -> Design (version container) -> Items

**ECO-as-Branch flow**:

1. Create change order -> Creates branch from main
2. Checkout items to it -> Items copied to branch
3. Make changes -> Isolated to branch
4. Approve & Release -> Merge to main, assign revision letters

**Change-order state changes**: every transition of a change order goes through `POST /api/v1/change-orders/:id/workflow/transition`, the endpoint on its lifecycle instance. When transitioning to a final state (e.g., "Approved"), the endpoint auto-triggers `close()` which merges branches and assigns revisions. There are no separate `/submit`, `/approve`, `/reject`, or `/actions` routes.

**Version Resolution**: Items are resolved per-branch using the `VersionResolver` service, which dynamically computes the current item per masterId per context using `branchItems` lookups and commit ancestry walks. Branch isolation ensures ECO changes don't affect main until merged.

### Data Fetching Pattern

The frontend has **one** cache: the TanStack Query client in `cascadia-web/src/query/`,
shared with the router through context. Route loaders prime it with
`ensureQueryData`, components read the same query factory with `useQuery`, and
mutations refresh it by naming the resources they wrote.

```typescript
// Loader primes the cache — it does not return data.
loaderDeps: ({ search }) => search,
loader: ({ context: { queryClient }, deps }) =>
  queryClient.ensureQueryData(designGridQuery(gridParamsFromSearch(deps))),

// Component reads the same factory — resolves from cache, no second fetch.
const { data } = useQuery(programListQuery())

// Writes go through useResourceMutation; dependents follow automatically.
const archive = useResourceMutation({
  mutationFn: (id: string) =>
    apiFetch(`/api/v1/designs/${id}/archive`, { method: 'POST' }),
  invalidates: ['designs'],
  onSuccess: () => navigate({ to: '/designs' }),
})
```

**`useResourceMutation` is the standard for new mutation code.** It registers
the invalidation _before_ running `onSuccess`, so a navigation there lands on a
page that is already refetching; `invalidates` is a typed `Resource` list; and
`isPending` comes free. Most of the app still uses the older
`await apiFetch(...); await invalidate('designs')` pair — that is not broken and
there is no sweep planned, but a PR that rewrites a mutation handler moves it to
the hook.

Keys are built with `qk` (never inline) so prefix invalidation reaches them.
`RESOURCE_DEPENDENTS` in `cascadia-web/src/query/invalidation.ts` encodes which
resources go stale together — name the resource you wrote, not its dependents.

**Do not** return data from a loader and read it with `useLoaderData()`, call
bare `router.invalidate()`, fetch in `useEffect` + `useState`, patch rows in
local state after a delete, or bump a `refreshTrigger` counter. Those are the
five idioms this layer replaced. Full guide:
[`docs/development/data-fetching.md`](./docs/development/data-fetching.md).

### API Route Pattern

API routes live in `cascadia-api/src/server/routes/` as Hono modules. Every module mounts under `/api/v1/` and uses the `tagged()` factory so all its handlers carry a consistent OpenAPI tag:

```typescript
import { Hono } from 'hono'
import { tagged } from '../adapter'
const adapt = tagged('Parts') // Tag this file's handlers as "Parts"
import { apiHandler } from '@/api/handler'

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

Mount new route modules in `cascadia-api/src/server/index.ts` via `app.route('/api/v1/example', example)`.

For responses needing custom status codes or headers (201 Created, Set-Cookie), return a raw `Response` from within the handler. Use `parseQuery(request, zodSchema)` for validated query parameters. Use `requireDesignAccess`/`requireBranchAccess` from `@/auth/access` for design/branch access checks.

The OpenAPI document is regenerated from these annotations at request time (`/openapi.json`) and served as Scalar UI at `/api/docs`. The committed snapshot at `docs/api/openapi.v1.json` is the frozen v1 contract — `npm run openapi:check` enforces it on every pull request. Run `npm run openapi:snapshot` whenever you change a route signature — a module's included, since the snapshot is taken with the modules registered — then commit the regenerated JSON. See [`docs/api/README.md`](./docs/api/README.md) for the versioning policy.

## Common Tasks

### Adding a Field to an Existing Item Type

1. Add column to schema in `cascadia-api/src/db/schema/items.ts`
2. Run `npm run db:push` to apply it to your dev database, then mint the migration that ships it: `npm run db:generate`, and commit what appears under `cascadia-app/drizzle/`
3. Update Zod schema in `cascadia-commons/src/items/types/`
4. Update form component to include new field
5. Update ItemService type-specific methods if needed

### Adding an API Route

1. Add handlers to an existing domain file in `cascadia-api/src/server/routes/` or create a new one
2. If new file, declare the tag at the top: `const adapt = tagged('YourResource')` (replaces plain `adapt` import)
3. Use `adapt(apiHandler(options, fn))` to define each route handler
4. Declare auth in options: `{ permission: ['resource', 'action'] }`, `{}` (auth-only), or `{ public: true }`
5. Call service layer methods; throw typed errors (`NotFoundError`, `ValidationError`) on failure
6. Return a plain object — it auto-wraps as `{ data: { ... } }` with JSON Content-Type
7. If new file, mount it in `cascadia-api/src/server/index.ts` via `app.route('/api/v1/newroute', newroute)`
8. Optional but encouraged: add `openapi: { summary, request, responses }` to the handler options to enrich the spec

9. Run `npm run openapi:snapshot` and commit the regenerated `docs/api/openapi.v1.json`

### Adding a Background Job Type

Background jobs use RabbitMQ for async processing. Pattern mirrors ItemTypeRegistry.

**1. Define payload/result schemas** in `cascadia-api/src/jobs/definitions/yourjob/types.ts`:

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

**2. Create job config** in `cascadia-api/src/jobs/definitions/yourjob/config.ts`:

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

**3. Create job handler** in `cascadia-workers-job/src/handlers/yourjob.ts` (for Node.js workers). Handlers live in the worker package, not the api — the api submits jobs and never runs them:

```typescript
import type { JobHandler, JobContext } from '@cascadia/api/jobs/types'
import type {
  MyJobPayload,
  MyJobResult,
} from '@cascadia/api/jobs/definitions/yourjob/types'

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

**4. Register the definition** in `cascadia-api/src/jobs/definitions/register.ts` and **the handler** in `cascadia-workers-job/src/register.ts`:

```typescript
// definitions/register.ts — add config (used by main app for dispatch)
import { myJobConfig } from './yourjob/config'
JobTypeRegistry.register(myJobConfig)

// cascadia-workers-job/src/register.ts — add handler (used only by the Node.js worker)
import { myJobHandler } from './yourjob'
JobTypeRegistry.registerHandler(myJobHandler)
```

For Python workers, only register the config in `definitions/register.ts` — the handler lives in its own `cascadia-workers-<name>/`.

**5. Submit jobs** from services or API routes:

```typescript
import { JobService } from '@/jobs'

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
- Path alias: `@/*` means _the importing file's own package_ (`cascadia-<pkg>/src/*`). Reach another package by name — `@cascadia/commons/...` from api or web; `@cascadia/api/...` and `@cascadia/web/...` only from apps and scripts. Commons imports itself relatively (it is compiled inside the other two programs, where `@/` means something else). In an app's Vite build, `@/` searches web first, then the module packages. Inside a module package, `@/` resolves across the application packages first and then the module's own `src/` — so module code writes the same `@/` imports core would, and a module file must never share a relative path with a core file (`boundary:check` refuses the collision)

### Database Queries

- Always use Drizzle ORM, never raw SQL
- Use parameterized queries (Drizzle handles this)
- Prefer `.returning()` for insert/update operations
- Use transactions for multi-step operations — `withTx(tx, fn)` from `@/db` when composing across services (thread the optional `tx?` through), plain `db.transaction()` at a single-service boundary

### UI Components

- Base components in `cascadia-web/src/components/ui/` (Button, Input, Card, Badge, Dialog, Table, DataGrid, etc.)
- Use `cn()` utility from `@/utils` for class merging
- Use Radix UI primitives for accessible components
- Forms use TanStack Form (`@tanstack/react-form`) + Zod validation
- DataGrid component wraps TanStack Table with sorting, filtering, pagination, and row expansion

### Error Handling

- Service layer throws typed errors from `cascadia-api/src/errors/` (`NotFoundError`, `ValidationError`, `PermissionDeniedError`, etc.)
- `apiHandler()` catches all errors automatically via `handleApiError` — routes just throw
- Validation errors from Zod are surfaced to forms

### Testing Strategy

- `cascadia-api/src/__tests__/` - Test utilities and fixtures (import via `@test/` alias)
- `cascadia-*/src/**/*.test.ts` - Unit/integration tests (co-located)
- `tests/e2e/` - Playwright E2E tests
- **Unit tests**: Vitest with `@testing-library/react` for components
- **Service tests**: Run against a real Postgres via `TestDatabase` (most suites); mocking is the rare exception
- **The suite has its own database.** It runs against `TEST_DATABASE_URL`, never `DATABASE_URL`, and refuses to start without it — it truncates tables and commits shared config rows, so pointed at the dev database it rewrites what you were working on. Provision once with `createdb -U postgres cascadia_test` then `npm run test:db:push`, and add `TEST_DATABASE_URL` to `.env`. Re-run `test:db:push` after a schema change. Nothing is derived or guessed; see `cascadia-api/src/__tests__/README.md`
- **E2E tests**: Playwright with page object model pattern
- **CI/CD**: GitHub Actions for automated testing
- Key utilities: `TestDatabase` (transaction-per-test), `ConcurrentTestDatabase` (multi-connection race tests), `insertTestUser`/`insertTestUserWithRole`, `seedStandardPartLifecycle`/`overrideItemTypeConfig`
- Tests use forked process pool for parallelization
- Vitest globals enabled (`describe`, `it`, `expect` available without import)

## Testing Philosophy

**Three-gate rule.** Write a test only if the file fails one of these:

1. **Data integrity** — mutates multi-entity state where inconsistency would corrupt data (change-order release, branching, versioning, conflict detection, checkout)
2. **Security** — gates access or verifies identity (auth, permissions, access-control boundaries)
3. **Complex algorithm** — non-obvious logic where reading the code isn't enough (merge logic, lifecycle state machines, graph traversal)

If a file passes none of the three gates, skip tests. UI components, API routes that just delegate, utilities, schemas, and query-only CRUD services do not need tests. **Deleting a low-value test is usually correct.**

**Prefer invariants over call-shapes.** A good test asserts _what must always be true_ ("after a change-order release, every affected item has a new revision letter"). A bad test asserts _what the code happens to do internally_ (`expect(merge).toHaveBeenCalledWith(...)`). Match error **class** (`NotFoundError`, `ValidationError`) or `error.code` — never error-message strings, which are refactor-brittle.

### Running tests

Claude may run tests automatically after meaningful changes. Prefer scoped runs:

- After a service change: `npx vitest run cascadia-api/src/services/ThatService.test.ts`
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

## Collaborative Design Engine

A multi-stage AI workflow in the `cascadia-design-engine` module, at
`cascadia-design-engine/src/design-engine/`:

**Stages** (sequential): Toolset Establishment → Toolset Review → Requirements Drafting → Requirements Review → BOM Drafting → BOM Review → Materialization → CAD Generation → CAD Review → Assembly Composition → Assembly Review

The canonical stage enum is `DesignSessionStage` in `cascadia-design-engine/src/design-engine/types.ts`.

**Key concepts:**

- Sessions are persisted in the `design_sessions` table with JSONB artifacts; snapshots for rollback and forking in `design_session_snapshots`
- Each drafting/review stage pair is one file in `stages/` (`toolset-establishment.ts`, `requirements.ts`, `bom.ts`, `cad-generation.ts`, `assembly-composition.ts`); materialization lives in `materialize.ts`, not `stages/`
- Toolset Establishment captures the available manufacturing processes/tools and a scope (`in_house_only` | `in_house_preferred` | `unconstrained`); selections become per-BOM-node `ManufacturingConstraints` (FDM, laser-cut, CNC, …) that constrain downstream BOM and CAD generation
- BOM drafting uses LLM tool-calling with tools defined in `tools/bom-tools.ts`
- Materialization creates actual PLM items (parts, requirements, relationships, change order) from the draft, through the same services any other client uses
- CAD generation has the AI provider write a FreeCAD Python script per part, executed by the FreeCAD runner (`cascadia-workers-freecad-runner/`) in an iterate-on-report loop (`cad-generation/freecad-agent.ts`); the accepted script's STEP lands in the vault
- Assembly composition plans placements with the LLM, serializes them to an assembly script, and renders the STEP via the CadQuery worker (`cascadia-workers-cad-generator/`)
- SSE streaming for real-time updates via `POST /api/v1/design-engine/sessions/:id/stream`
- UI workspace at `/designs/collaborative/$sessionId` (routes under `cascadia-design-engine/src/routes/`, composed by `cascadia-app/vite.config.ts`)

**How it attaches:** `registerDesignEngine()` / `registerCadGeneration()` in
`cascadia-design-engine/src/register.server.ts` add the AI tool, the routes and
the job definitions; `registerCadGenerationWorker()` adds the one Node job
handler; `register.client.ts` adds the sidebar entry, the part-page CAD actions
and the admin CAD-generation section through slots. All are called from
`cascadia-app/src/modules.{server,client}.ts`, and its tables are re-exported
from `modules.schema.ts`.

## Python Workers

**CAD converter** (`cascadia-workers-cad/`): pythonocc-core. Processes STEP/IGES files into STL + GLB (with per-face color preservation). Connects to RabbitMQ for job processing.

**CAD generator** (`cascadia-workers-cad-generator/`): CadQuery. Parametric part templates, multi-part mechanisms, and the composed STEP assemblies the design engine's assembly stage renders.

**FreeCAD runner** (`cascadia-workers-freecad-runner/`): headless FreeCAD (conda-forge). Executes AI-written scripts in a sandboxed child process — scrubbed environment, resource limits, wall-clock deadline — validates `result`, and stores the accepted STEP. A failing script is a completed job with `ok: false`; the agent's revision is the retry.

CI runs none of the three workers' suites (only `cascadia-workers-commons`); they run locally — see `docs/development/python-worker-tests.md`.

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
invisible in that noise and reached `main` across two merges.

If a clone predates the rule, its files are still CRLF on disk and the check is
useless again. Refresh once:

```bash
git rm --cached -r . && git reset --hard
```

Verify with `git ls-files --eol` — every tracked file should report `w/lf`. A
file reporting `w/-text` is being treated as binary (usually a stray NUL byte
in the source) and is silently exempt from all of this.

A fresh `git worktree add` lands in the same state, and does so every time: git
only writes a working-tree file when it believes the content changed, so a file
some other process rewrote with CRLF is stat-dirty but content-clean, and
`checkout` never touches it again. Repair it with `npm run eol:fix`, or report
without writing using `npm run eol:check`. `postinstall` runs the repair, so the
`npm ci` a new worktree already needs covers it — on Linux it finds nothing and
stays silent.

Repair it rather than reasoning around it. `git status` stays **clean**
throughout, because git normalises CRLF on the way into the index, so the only
symptom is a tool that reads bytes off disk disagreeing with CI — and those
disagree in both directions. A hash check reports the file as drifted content;
a per-line regex scan terminates at the CR, matches nothing, and passes. Both
have happened here, and the second is the dangerous one: a check that finds
nothing looks exactly like a clean tree.

## Merging prose files

**Before formatting a prose file after a merge, grep it for conflict markers.**
Prettier does not reject an unresolved merge — it reflows the markers into
valid markdown: a bare `=======` is padded into a `| ======= |` table cell, and
`>>>>>>> origin/main` becomes a `> > > > > > >` blockquote. After that
`format:check` is green forever and nothing else in CI reads prose, so the
damage is permanent and invisible. One plan document carried **two entire
copies of itself** for weeks that way, which is why it conflicted against every
branch that touched it. Run `git diff --check`, or `grep -rn '^<<<<<<<' .`,
before `npm run format` — never after.

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
import { zodValidator } from '@/form-validation'

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

### Client Code Reaching the API Package

**Error:**

```
[vite] cascadia-web/src/components/x/Y.tsx imports @cascadia/api/services/Z.
The client bundle cannot reach @cascadia/api: ...
```

or, from `tsc`, `Cannot find module '@cascadia/api/...'` / `'@/db'` in a
web file, or `npm run boundary:check` reporting a layering violation.

**Root Cause:**
The web package has no route to the api package — not in its tsconfig
`paths`, not in the Vite alias plugin — so a component or query option that
imports a service, the schema, or anything else under `cascadia-api`
cannot resolve. That is the point: before the split, the same import compiled
fine and only failed as
`node_modules/postgres/src/connection.js: "performance" is not exported by "__vite-browser-external"`
at build time, or not at all when it was `import type`.

**Solutions:**

1. **A type the client needs**: move the declaration into commons and re-export
   it from where it was, so server callers are untouched:

   ```typescript
   // cascadia-commons/src/services/types/checkout.ts
   export interface CheckoutStatus { ... }

   // cascadia-api/src/services/CheckoutService.ts
   export type { CheckoutStatus } from '@cascadia/commons/services/types/checkout'

   // cascadia-web/src/query/options/checkout.ts
   import type { CheckoutStatus } from '@cascadia/commons/services/types/checkout'
   ```

   If the type is inferred from a Drizzle table (`typeof t.$inferSelect`),
   write it out in commons and pin it to the table with `Expect<Equal<...>>`
   from `@cascadia/commons/types/assert` — see `db/schema/designs.ts`.

2. **Behaviour the client needs**: it belongs behind an endpoint; the client
   calls it through `apiFetch` and the query layer.

3. **Pure logic both sides run** (a parser, a formatter): it belongs in
   commons — provided it imports no `node:*` module and no server-only
   package. `formatFileSize` lives in `commons/vault/format-file-size.ts`
   for exactly this reason, apart from the `node:crypto`-using `file-utils`.

**Prevention:**

- `npm run boundary:check` fails on any web→api or commons→anything import,
  resolved by path rather than matched by pattern.
- Commons files must not import `node:*`, `drizzle-orm`, `hono`, or
  `postgres`; the commons tsconfig has no `@types/node` reach, so a `Buffer`
  is a type error there.

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
- **CAD Generator** and **FreeCAD Runner** - Python workers for the design engine's generative CAD (built locally from their Dockerfiles; no published images yet)

### Key Files

- `cascadia-app/Dockerfile` - Core app container
- `cascadia-workers-job/Dockerfile` - Node.js jobs worker container
- `cascadia-workers-cad/Dockerfile` - CAD converter container
- `cascadia-workers-cad-generator/Dockerfile` - CAD generator container
- `cascadia-workers-freecad-runner/Dockerfile` - FreeCAD runner container
- `docs/orchestration/README.md` - Full orchestration guide
- `docs/orchestration/configuration.md` - All environment variables
