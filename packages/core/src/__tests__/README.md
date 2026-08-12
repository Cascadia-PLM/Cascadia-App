# Test Utilities

Shared helpers and fixtures for Vitest unit/integration tests. Import these
from test files via the `@test/` or `@/__tests__/` path aliases.

## Layout

```
src/__tests__/
├── helpers/
│   ├── db.ts         — TestDatabase class (transaction-per-test isolation)
│   ├── auth.ts       — login/session helpers for authenticated scenarios
│   ├── vault.ts      — MockVaultStorage for file-storage-adjacent tests
│   ├── api.ts        — helpers for exercising API handlers in-process
│   └── index.ts      — re-exports
└── fixtures/
    ├── users.ts         — TestUser type, insertTestUser, role helpers
    ├── items.ts         — part/document/etc. factories
    ├── builder.ts       — TestDataBuilder fluent API
    ├── lifecycles.ts    — system user + Part lifecycle seeding
    └── index.ts         — re-exports
```

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

Use `.onConflictDoNothing()` for unique IDs (first writer wins) or
`.onConflictDoUpdate(...)` when you need to override pre-existing app seed data.

## Fixtures

| Fixture                                     | What it gives you                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `insertTestUser(db, overrides?)`            | Creates a user with a unique email, returns `TestUser`.                     |
| `insertTestUserWithRole(db, roleName, ...)` | User + role + userRole join row.                                            |
| `insertTestSession(db, userId, ...)`        | Session row for a user.                                                     |
| `seedStandardPartLifecycle(db)`             | System user + Part lifecycle + Part item-type config.                       |
| `SYSTEM_USER_ID`                            | Fixed UUID for the seeding-only system user.                                |
| `PART_LIFECYCLE_DEFINITION`                 | The canonical lifecycle object (states, transitions, changeActionMappings). |
| `TestDataBuilder`                           | Fluent API: `.withPart().withDocument().insert(db)`.                        |

## Writing tests — philosophy

See [`CLAUDE.md`](../../CLAUDE.md#testing-philosophy) for the three-gate rule:
write tests for files that mutate multi-entity state, gate access, or
implement non-obvious algorithms. Skip everything else.

Golden examples to pattern-match:

- `src/lib/services/BranchService.test.ts` — branching invariants
- `src/lib/services/ChangeOrderMergeService.test.ts` — ECO release invariants
- `src/lib/services/VersionResolver.test.ts` — version resolution correctness
