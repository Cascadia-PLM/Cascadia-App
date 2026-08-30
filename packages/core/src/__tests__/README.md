# Test Utilities

Shared helpers and fixtures for Vitest unit/integration tests. Import these
from test files via the `@test/` or `@/__tests__/` path aliases.

## Before your first run: provision the test database

The suite runs against **`TEST_DATABASE_URL`, not `DATABASE_URL`**, and refuses
to start without it. This is not belt-and-braces: the suite truncates tables and
commits shared config rows — `item_type_configs` holds one row per item type for
the whole run — so pointed at your development database it rewrites the data you
were working with.

```bash
createdb -U postgres cascadia_test
npm run test:db:push
```

Then add to `.env`:

```
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia_test
```

No seeding step: `global-setup.ts` seeds the lifecycle rows on every run, and
everything else a suite needs it builds itself. `test:db:push` uses `push` rather
than `migrate` because the database is disposable and CI's Unit Tests job builds
its schema the same way. Re-run it after a schema change.

Nothing is derived. A guessed `${dev}_test` would still be a database nobody
chose, and on a machine with more than one Cascadia checkout the guess lands in
another checkout's data.

## Layout

```
src/__tests__/
├── helpers/
│   ├── db.ts            — TestDatabase class (transaction-per-test isolation)
│   ├── concurrent-db.ts — ConcurrentTestDatabase, for genuine race tests
│   └── index.ts         — re-exports
└── fixtures/
    ├── users.ts         — TestUser type, insertTestUser, role helpers
    ├── items.ts         — part/document/etc. factories
    ├── lifecycles.ts    — system user + Part lifecycle seeding + config override
    └── index.ts         — re-exports
```

(A previous generation of mock-based helpers — a mock auth layer, a mock
vault, an API client wrapper, a fluent data builder, a provider-wrapping
render — accumulated ~2,500 lines with zero consumers and was deleted. The
real suites talk to a real Postgres and, for routes, the real Hono app; see
the idioms below.)

## Two environments: node by default, jsdom for `.test.tsx`

The suite runs as two Vitest projects split by file extension (TEST-4):
`.test.ts` files run under the **node** environment with `setup.node.ts`;
`.test.tsx` files run under **jsdom** with `setup.dom.ts` (RTL cleanup,
jest-dom matchers, the Radix window/Element polyfills). The extension is the
routing: a component or hook test must be named `.test.tsx`, or it runs
without a DOM and `document` is undefined. Run one side with
`npx vitest run --project node` / `--project dom`.

## TestDatabase — transaction-per-test isolation

Every service test uses `TestDatabase` with transaction rollback for isolation.
The shape is consistent across the suite:

```typescript
import { TestDatabase } from '@/__tests__/helpers/db'

describe('MyService', () => {
  const testDb = new TestDatabase()

  beforeAll(async () => await testDb.setup())
  afterAll(async () => await testDb.teardown())
  beforeEach(async () => await testDb.beginTransaction())
  afterEach(async () => await testDb.rollback())

  it('holds invariant X', async () => {
    // Work happens inside an open transaction. afterEach rolls it back —
    // nothing persists between tests.
  })
})
```

**Do not use `db.transaction()` inside your test body** — the SUT may already
call it and postgres.js deadlocks on nested `BEGIN` with a single-connection
pool. Let the services manage their own transactions; just pass `testDb.db`.

## Seeding shared tables

Some tables (`workflow_definitions`, `item_type_configs`) are _not_ cleared
by transaction rollback because they hold config that services read during
operation. They must be seeded in `beforeAll` with idempotent inserts.

### Use the shared fixture

`fixtures/lifecycles.ts` exports the canonical Part lifecycle seeding:

```typescript
import {
  SYSTEM_USER_ID,
  seedStandardPartLifecycle,
} from '@/__tests__/fixtures/lifecycles'

beforeAll(async () => {
  await testDb.setup()

  // System user + Part lifecycle + Part item-type link in one call
  await seedStandardPartLifecycle(testDb.db)

  // Any test-specific seeding goes here (e.g. an ECO workflow with a
  // file-specific unique ID to avoid races with other tests)

  await ItemTypeRegistry.reload()
})
```

Finer-grained helpers (`seedSystemUser`, `seedPartLifecycle`,
`seedPartItemTypeConfig`) are exported if you only need one.

### Writing your own seed for workflow-shaped data

If your test needs a different workflow definition (e.g. a custom ECO workflow
with distinct state transitions), keep it inline in that test file. Two rules:

1. **Use a unique UUID** for the definition ID — otherwise you race with
   other test files' seed data. Any UUID ending in a value not listed in
   `src/lib/items/lifecycle-ids.ts` is safe.
2. **Seed in `beforeAll`, not `beforeEach`** — inserts there auto-commit and
   hold locks for ~1ms. `beforeEach` sits inside the gate transaction and
   holds locks for the full test duration, which deadlocks under parallelism.

Use `.onConflictDoNothing()` for unique IDs: first writer wins, and nothing
that already exists is disturbed.

### Overriding a shared config row

`item_type_configs` and `workflow_definitions` hold **one row per item type for
the whole instance**. A `beforeAll` write is outside the gate transaction, so
overriding one is not scoped to your suite: the row survives the suite, the
file, and the run. Six suites overrode a row and never wrote it back, so which
lifecycle `Task` pointed at depended on which suite had last touched the
database — and a test reading it was asserting on file order.

Never write those tables with a bare `.onConflictDoUpdate(...)`. Use the helper,
which captures the row first and hands back the undo:

```typescript
import { overrideItemTypeConfig } from '@/__tests__/fixtures/lifecycles'

let restoreItemTypeConfig: (() => Promise<void>) | undefined

beforeAll(async () => {
  await testDb.setup()
  restoreItemTypeConfig = await overrideItemTypeConfig(testDb.db, 'Issue', {
    lifecycleDefinitionId: FREE_LIFECYCLE_ID,
  })
})

afterAll(async () => {
  await restoreItemTypeConfig?.()
  await testDb.teardown()
})
```

`npm run test:hygiene:check` enforces this, and CI runs it in the Lint job. A
file whose override genuinely lives inside the gate transaction and is undone
before the rollback declares that in a `// test-config-hygiene: <why>` comment;
`CheckoutService.test.ts` is the one such file.

**This fixes pollution across runs. It does not fix contention within one.**
Forks share the database, so two suites overriding the same item type at the
same time still race — which is why a suite that needs a link must seed it
itself in `beforeAll` rather than trusting whatever another suite left behind.

### Roles are seeded for you

`global-setup.ts` commits the built-in roles once, before any worker forks, so
`insertTestUserWithRole` finds them and inserts nothing. Do not add your own
copy of a built-in role: `roles.name` is unique, and suites inserting the same
name from inside their own rolled-back transactions is a deadlock, not a
duplicate — it cost 9 to 12 failures per full run, in a different set of tests
each time. A role that is genuinely test-specific gets a unique name
(`createCustomTestRole`).

## Fixtures

| Fixture                                     | What it gives you                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `insertTestUser(db, overrides?)`            | Creates a user with a unique email, returns `TestUser`.                     |
| `insertTestUserWithRole(db, roleName, ...)` | User + role + userRole join row.                                            |
| `insertTestPart(db, designId, userId, ...)` | Item row + parts extension row.                                             |
| `seedStandardPartLifecycle(db)`             | System user + Part lifecycle + Part item-type config.                       |
| `overrideItemTypeConfig(db, type, patch)`   | Shared-config override that hands back its undo (see above).                |
| `SYSTEM_USER_ID`                            | Fixed UUID for the seeding-only system user.                                |
| `PART_LIFECYCLE_DEFINITION`                 | The canonical lifecycle object (states, transitions, changeActionMappings). |

## Route tests — real app, real session

Route tests do not mock auth or HTTP: they build the in-process Hono app and
authenticate with a real session cookie, so the whole middleware stack —
session validation, permissions, program scoping — runs exactly as in
production. The pattern
(`src/server/routes/designs.post-merge-structure.test.ts`):

```typescript
import { SessionManager } from '@/lib/auth/session'

const cookie = `session=${(await SessionManager.createSession(user.id)).sessionToken}`
const res = await app.request('/api/v1/designs/...', {
  headers: { cookie },
})
```

## Component and hook tests

The `.test.tsx` files use `@testing-library/react` directly — `render`,
`renderHook`, `screen` — with no project-specific wrapper. A hook that needs
StrictMode double-mount coverage passes
`renderHook(..., { reactStrictMode: true })`; a hand-rolled
`<React.StrictMode>` wrapper double-renders but does **not** double-fire
effects, and misses duplicate mount-effect bugs. Golden examples:
`src/lib/hooks/useListSelection.test.tsx`,
`src/components/work-orders/useInstructionRun.test.tsx`.

## Writing tests — philosophy

See [`CLAUDE.md`](../../CLAUDE.md#testing-philosophy) for the three-gate rule:
write tests for files that mutate multi-entity state, gate access, or
implement non-obvious algorithms. Skip everything else.

Golden examples to pattern-match:

- `src/lib/services/BranchService.test.ts` — branching invariants
- `src/lib/services/ChangeOrderMergeService.test.ts` — ECO release invariants
- `src/lib/services/VersionResolver.test.ts` — version resolution correctness
