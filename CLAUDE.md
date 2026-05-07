# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cascadia is an open-source, code-first Product Lifecycle Management (PLM) system built with Hono (API server) and Vite + TanStack Router (SPA frontend). It replaces traditional low-code PLM systems (like Aras Innovator) with a developer-centric, type-safe approach where all customization happens in code, not through UI configuration.

**Key Philosophy**: Code-first configuration, TypeScript everywhere, enterprise-ready PostgreSQL backend, Git-style versioning for engineering data.

The signature feature is "ECO-as-Branch" - each Engineering Change Order gets its own isolated branch for parallel development.

**See [cascadia-feature-list.md](./cascadia-feature-list.md) for comprehensive feature documentation.**

## Repository Context

This is the main Cascadia PLM application. Related repositories:

| Repository          | Purpose            |
| ------------------- | ------------------ |
| `../DocsSite/`      | Documentation site |
| `../MarketingSite/` | Marketing website  |

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
- **CAD Generation**: Zoo Text-to-CAD API + KCL for assemblies
- **Testing**: Vitest (unit) + Playwright (E2E)
- **Message Queue**: RabbitMQ
- **Containerization**: Docker, Docker Compose

## Project Structure

```
src/
├── components/       # React components (forms, tables, dialogs)
│   ├── ui/           # Base UI primitives (Button, Card, DataGrid, etc.)
│   ├── ai/           # AI chatbot panel
│   ├── design-engine/# Collaborative design workspace components
│   └── work-instructions/ # Work instruction authoring/execution
├── lib/
│   ├── auth/         # Authentication & authorization services
│   ├── db/           # Drizzle schema & database utilities
│   ├── items/        # Item services (Parts, Documents, etc.)
│   ├── services/     # Core services (Branch, Checkout, Commit, etc.)
│   ├── workflows/    # Workflow engine
│   ├── jobs/         # Background job dispatch, definitions & worker
│   ├── api/          # API utilities (apiHandler, response builders, schemas)
│   ├── vault/        # File storage system
│   ├── sysml/        # SysML v2 serialization
│   ├── ai/           # AI chatbot tools, adapters, session service
│   ├── design-engine/# Collaborative design engine (stages, tools, prompts, materialization)
│   └── cad-generation/ # CAD generation pipeline (Zoo API, KCL, assembly)
├── routes/           # TanStack Router routes & API endpoints
└── __tests__/        # Test utilities and fixtures
workers/
├── node/             # Node.js job worker Dockerfile
├── cad-converter/    # Python worker: STEP/IGES → STL/GLB (pythonocc)
└── cad-generator/    # Python worker: Parametric CAD (CadQuery)
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
npm run db:generate   # Generate migrations from schema changes
npm run db:migrate    # Run pending migrations
npm run db:push       # Push schema directly to database (dev only)
npm run db:studio     # Open Drizzle Studio GUI
npm run db:seed       # Minimal seed (admin, roles, program, standard library)
npm run db:seed:catalog  # Generic component catalog (fasteners, raw stock)

# Database Reset (truncates all tables, then optionally reseeds)
npm run db:reset              # Truncate all tables only
npm run db:reset:seed         # Truncate + minimal seed

# Testing
npm run test          # Run Vitest tests
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run tests with coverage
npm run test:ui       # Open Vitest UI
npm run test:e2e      # Run Playwright E2E tests
npm run test:e2e:ui   # Run E2E tests with UI
npm run test:e2e:full # Reset database + run E2E tests (clean slate)

# Run a single test file
npx vitest run src/lib/services/BranchService.test.ts

# Run tests matching a pattern
npx vitest run -t "should create branch"

# Code Quality
npm run lint          # ESLint
npm run format        # Prettier
npm run check         # Format + lint fix

# Background Workers
npm run workers:dev   # Start RabbitMQ + all workers (Node.js + Python)
npm run workers:stop  # Stop Python workers
npm run workers:logs  # Tail Python worker logs

# Individual workers (if you only need one)
npm run jobs:worker:dev    # Node.js worker only (requires RabbitMQ)
npm run cad:worker:dev     # CAD converter only (Docker)
npm run cadgen:worker:dev  # CAD generator only (Docker)
```

## Lint Warnings Baseline

`npm run lint` runs `eslint --max-warnings N`, where `N` is the current warning count. This is a **ratchet**: the current baseline is the ceiling — any new warning fails lint. Most of these are `@typescript-eslint/no-unnecessary-condition` (over-defensive null/undefined guards that the type system already rules out).

**Target: 20 warnings.** Legitimately-defensive code at system boundaries may still trip the rule; 20 is the rough floor we expect once over-guarding is cleaned up.

**When you specifically address lint warnings** (as opposed to incidentally touching a file and fixing a few), and the total drops below the previous threshold, **update `--max-warnings` in `package.json` to the new count** in the same commit. The ratchet should only ever move down, never up. If a refactor legitimately adds a warning, fix one elsewhere to keep the ceiling flat.

Do not raise the threshold to accommodate new warnings. If a warning cannot be fixed, disable it per-line with `// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- <reason>` so the suppression is visible and reviewable.

## Documentation Reference

Comprehensive documentation lives in-repo at [`./docs/`](./docs/README.md).

**Load relevant docs before making significant changes to unfamiliar areas.**

### When to Load Documentation

**Always check docs before:**

- Modifying service layer code (`src/lib/services/`, `src/lib/items/services/`)
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

| Working In                            | Read First                                     |
| ------------------------------------- | ---------------------------------------------- |
| `src/lib/services/`                   | `./docs/development/service-patterns.md`       |
| `src/lib/items/services/`             | `./docs/development/service-patterns.md`       |
| `src/server/routes/`                  | `./docs/development/adding-api-routes.md`      |
| Versioning, branches, commits         | `./docs/features/versioning.md`                |
| `src/lib/db/schema/`                  | `./docs/development/database-patterns.md`      |
| Database queries, Drizzle ORM         | `./docs/development/database-patterns.md`      |
| Lifecycles, workflows, change actions | `./docs/features/workflow-engine.md`           |
| Item type changes                     | `./docs/development/adding-item-types.md`      |
| ECO/Change Order logic                | `./docs/features/change-management.md`         |
| File vault                            | `./docs/features/file-vault.md`                |
| Auth/permissions                      | `./docs/admin/access-control.md`               |
| UI components / forms                 | `./docs/development/ui-components.md`          |
| Testing patterns                      | `./docs/development/testing.md`                |
| Background jobs                       | `./docs/development/adding-background-jobs.md` |

## Architecture Quick Reference

> For detailed explanations, see `./docs/architecture/overview.md` (and the other files under `./docs/architecture/`).

### Service Quick Reference

| I need to...                     | Use                                                    |
| -------------------------------- | ------------------------------------------------------ |
| CRUD any item                    | `ItemService`                                          |
| Manage ECO affected items        | `ChangeOrderService`                                   |
| Release an approved ECO          | `ChangeOrderMergeService.merge()`                      |
| Checkout item for editing        | `CheckoutService.checkout()`                           |
| Get item at a version/commit/tag | `VersionResolver.getItemAtContext()`                   |
| Create/manage branches           | `BranchService`                                        |
| Create commits                   | `CommitService`                                        |
| Upload/download files            | `FileService`                                          |
| Manage programs                  | `ProgramService`                                       |
| Manage designs                   | `DesignService`                                        |
| Manage lifecycle transitions     | `LifecycleService`                                     |
| Detect merge conflicts           | `ConflictDetectionService`                             |
| Assess ECO impact on items       | `ImpactAssessmentService`                              |
| AI chatbot conversations         | `SessionService` from `@/lib/ai`                       |
| Collaborative design sessions    | `DesignSessionService` from `@/lib/design-engine`      |
| Run design engine stages         | `CollaborativeDesignEngine` from `@/lib/design-engine` |
| Materialize design to PLM items  | `MaterializationService` from `@/lib/design-engine`    |
| Generate CAD from text           | `PartGenerator` from `@/lib/cad-generation`            |
| Plan assembly composition        | `AssemblyPlanner` from `@/lib/cad-generation`          |
| Submit background jobs           | `JobService.submit()`                                  |
| Register job types               | `JobTypeRegistry.register()`                           |
| Wrap an API route handler        | `apiHandler()` from `@/lib/api/handler`                |
| Parse & validate query params    | `parseQuery(request, zodSchema)`                       |
| Check design access              | `requireDesignAccess()` from `@/lib/auth/access`       |
| Check branch access              | `requireBranchAccess()` from `@/lib/auth/access`       |

### Core Patterns

**Two-table pattern**: Base fields in `items` table, type-specific fields in `parts`/`documents`/`change_orders`/etc. `ItemService` handles both automatically.

**Branch protection**: Cannot modify items on `main` directly. All changes flow through ECO branches, merged on release.

**Revision assignment**: Revision letters (A, B, C...) are assigned only when merging ECO branch to main, not during work.

**Item types**: Part, Document, ChangeOrder, Requirement, Task, WorkInstruction, Issue. All extend `BaseItem` and register via `ItemTypeRegistry`.

**Part types**: Parts have a `partType` field: `Manufacture`, `Purchase`, `Phantom` (logical grouping), or `Software`.

**Organizational hierarchy**: Organization -> Program (permission boundary) -> Design (version container) -> Items

**ECO-as-Branch workflow**:

1. Create ECO -> Creates branch from main
2. Checkout items to ECO -> Items copied to branch
3. Make changes -> Isolated to branch
4. Approve & Release -> Merge to main, assign revision letters

**ECO state changes**: All ECO state transitions go through `POST /api/change-orders/:id/workflow/transition`. When transitioning to a final state (e.g., "Approved"), the endpoint auto-triggers `close()` which merges branches and assigns revisions. There are no separate `/submit`, `/approve`, `/reject`, or `/actions` routes.

**Version Resolution**: Items are resolved per-branch using the `VersionResolver` service, which dynamically computes the current item per masterId per context using `branchItems` lookups and commit ancestry walks. Branch isolation ensures ECO changes don't affect main until merged.

### API Route Pattern

API routes live in `src/server/routes/` as Hono modules. Every module mounts under `/api/v1/` and uses the `tagged()` factory so all its handlers carry a consistent OpenAPI tag:

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
          responses: { 200: { schema: z.object({ part: partResponseSchema }) } },
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

Mount new route modules in `src/server/index.ts` via `app.route('/api/v1/example', example)`.

For responses needing custom status codes or headers (201 Created, Set-Cookie), return a raw `Response` from within the handler. Use `parseQuery(request, zodSchema)` for validated query parameters. Use `requireDesignAccess`/`requireBranchAccess` from `@/lib/auth/access` for design/branch access checks.

The OpenAPI document is regenerated from these annotations at request time (`/openapi.json`) and served as Scalar UI at `/api/docs`. The committed snapshot at `docs/api/openapi.v1.json` is the frozen v1 contract — `npm run openapi:check` enforces it in CI. Run `npm run openapi:snapshot` whenever you change a route signature, then commit the regenerated JSON. See [`docs/api/README.md`](./docs/api/README.md) for the versioning policy.

## Common Tasks

### Adding a Field to an Existing Item Type

1. Add column to schema in `src/lib/db/schema/items.ts`
2. Run `npm run db:generate` to create migration
3. Run `npm run db:push` to apply changes
4. Update Zod schema in `src/lib/items/types/`
5. Update form component to include new field
6. Update ItemService type-specific methods if needed

### Adding an API Route

1. Add handlers to an existing domain file in `src/server/routes/` or create a new one
2. If new file, declare the tag at the top: `const adapt = tagged('YourResource')` (replaces plain `adapt` import)
3. Use `adapt(apiHandler(options, fn))` to define each route handler
4. Declare auth in options: `{ permission: ['resource', 'action'] }`, `{}` (auth-only), or `{ public: true }`
5. Call service layer methods; throw typed errors (`NotFoundError`, `ValidationError`) on failure
6. Return a plain object — it auto-wraps as `{ data: { ... } }` with JSON Content-Type
7. If new file, mount it in `src/server/index.ts` via `app.route('/api/v1/newroute', newroute)`
8. Optional but encouraged: add `openapi: { summary, request, responses }` to the handler options to enrich the spec
9. Run `npm run openapi:snapshot` and commit the updated `docs/api/openapi.v1.json`

### Adding a Background Job Type

Background jobs use RabbitMQ for async processing. Pattern mirrors ItemTypeRegistry.

**1. Define payload/result schemas** in `src/lib/jobs/definitions/yourjob/types.ts`:

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

**2. Create job config** in `src/lib/jobs/definitions/yourjob/config.ts`:

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

**3. Create job handler** in `src/lib/jobs/node-handlers/yourjob.ts` (for Node.js workers):

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

**4. Register the definition** in `src/lib/jobs/definitions/register.ts` and **the handler** in `src/lib/jobs/node-handlers/register.ts`:

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

- kebab-case for files: `item-service.ts`
- PascalCase for components: `PartForm.tsx`
- Routes follow TanStack conventions: `parts/$id.tsx`

### TypeScript

- Strict mode enabled, avoid `any` types
- Use Zod schemas for validation and type inference
- Prefer interfaces for object types, type for unions
- Path alias: `@/*` maps to `src/*`

### Database Queries

- Always use Drizzle ORM, never raw SQL
- Use parameterized queries (Drizzle handles this)
- Prefer `.returning()` for insert/update operations
- Use transactions for multi-step operations via `db.transaction()`

### UI Components

- Base components in `src/components/ui/` (Button, Input, Card, Badge, Dialog, Table, DataGrid, etc.)
- Use `cn()` utility from `@/lib/utils` for class merging
- Use Radix UI primitives for accessible components
- Forms use TanStack Form (`@tanstack/react-form`) + Zod validation
- DataGrid component wraps TanStack Table with sorting, filtering, pagination, and row expansion

### Error Handling

- Service layer throws typed errors from `src/lib/errors/` (`NotFoundError`, `ValidationError`, `PermissionDeniedError`, etc.)
- `apiHandler()` catches all errors automatically via `handleApiError` — routes just throw
- Validation errors from Zod are surfaced to forms

### Testing Strategy

- `src/__tests__/` - Test utilities and fixtures (import via `@test/` alias)
- `src/**/*.test.ts` - Unit/integration tests (co-located)
- `tests/e2e/` - Playwright E2E tests
- **Unit tests**: Vitest with `@testing-library/react` for components
- **Service tests**: Mock database transactions with rollback
- **E2E tests**: Playwright with page object model pattern
- **CI/CD**: GitHub Actions for automated testing
- Key utilities: `TestDatabase`, `TestDataBuilder`, `renderWithProviders()`, `MockVaultStorage`
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

- After a service change: `npx vitest run src/lib/services/ThatService.test.ts`
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

Optional:

```
FILE_STORAGE_PATH=/path/to/vault  # Default: ./vault-storage
RABBITMQ_URL=amqp://localhost     # For background jobs
SESSION_SECRET=your-secret-key    # Session encryption
```

## Collaborative Design Engine Architecture

The design engine is a multi-stage AI workflow at `src/lib/design-engine/`:

**Stages** (sequential): Requirements Drafting → Requirements Review → BOM Drafting → BOM Review → Materialization → CAD Generation → CAD Review → Assembly Composition → Assembly Review

**Key concepts:**

- Sessions are persisted in `design_sessions` table with JSONB artifacts
- Each stage has a file in `stages/` implementing the engine logic
- BOM drafting uses LLM tool-calling with tools defined in `tools/bom-tools.ts`
- Materialization creates actual PLM items (parts, requirements, relationships, ECO) from the draft
- CAD generation submits prompts to Zoo's Text-to-CAD API, uploads STEP files to vault
- Assembly composition uses KCL (KittyCAD Language) code generation
- SSE streaming for real-time updates via `/api/design-engine/sessions/$id/stream`
- UI workspace at `/designs/collaborative/$sessionId`

**CAD converter** (`workers/cad-converter/`): Python worker using pythonocc-core. Processes STEP/IGES files into STL + GLB (with per-face color preservation). Connects to RabbitMQ for job processing.

## Windows-Specific Notes

- PostgreSQL installed at: `C:\Program Files\PostgreSQL\18\`
- Create database manually: `createdb -U postgres cascadia`
- Path separators: Use forward slashes in imports, Node.js handles conversion

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
   // BAD: src/lib/db/schema/config.ts imports drizzle-orm
   import type { RuntimeItemTypeConfig } from '../db/schema/config'

   // GOOD: src/lib/items/types/runtime-config.ts has no db imports
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

1. Create a migration Cloud Build config that runs `drizzle-kit push`
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

- **Core App** (`cascadia-app`) - Web UI + API
- **Vault Service** (`cascadia-vault`) - File storage (optional standalone)
- **Jobs Server** (`cascadia-jobs`) - Background processing (optional standalone)
- **CAD Converter** (`cascadia-cad-converter`) - Python STEP/IGES → STL/GLB conversion

### Key Files

- `docker/app.Dockerfile` - Core app container
- `docker/vault.Dockerfile` - Vault service container
- `workers/node/Dockerfile` - Node.js jobs worker container
- `workers/cad-converter/Dockerfile` - CAD converter container
- `workers/cad-generator/Dockerfile` - CAD generator container
- `docs/orchestration/README.md` - Full orchestration guide
- `docs/orchestration/configuration.md` - All environment variables
