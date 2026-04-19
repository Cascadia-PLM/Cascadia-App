---
description: Evaluate changes against the three-gate rule and write invariant tests only when a gate applies
argument-hint: [optional: specific file or feature to test]
allowed-tools: Read, Write, Edit, Bash(npm run test*), Bash(npx vitest*), Bash(git *), Glob, Grep
---

# Write Tests — Three-Gate Rule

Evaluate each changed file against three gates. Generate tests only for files that pass one. **Default to refusal.**

## The Three Gates

A file needs tests if and only if it passes one:

1. **Mutates multi-entity state** — touches 2+ tables transactionally or is load-bearing for a versioning / consistency invariant. Examples: ECO release, branch merge, checkout, commit creation, version resolution, conflict detection.
2. **Gates access or verifies identity** — auth services, access-control checks, session handling, permission boundaries. A bug here means unauthorized access.
3. **Implements a non-obvious algorithm** — where reading the code isn't enough to convince yourself it's right. Merge logic, workflow state machines, graph traversal, anything with meaningful branching.

**"Could conceivably go wrong" is not a gate.** "A bug here silently corrupts data / lets the wrong user in / produces a wrong algorithmic answer" is.

### Files that do NOT qualify

- API routes that delegate to a tested service — test the service, not the route
- UI components — covered by E2E
- Utilities, config, schemas, error classes, type definitions
- Query-only services, CRUD wrappers, glue code
- Styling, formatting, documentation

## Current context

**Changed files (uncommitted):**

```
$git diff --name-only HEAD 2>/dev/null || echo "No uncommitted changes"
```

**Changed source files (excluding tests):**

```
$git diff --name-only HEAD 2>/dev/null | grep -E "^src/.*\.(ts|tsx)$" | grep -v "\.test\." | grep -v "__tests__" || echo "None"
```

## Procedure

### 1. Run each file through the gates

For each changed file, state explicitly which gate it passes — and if none, say so. Be strict: refusal is the default.

### 2. Write invariant tests, not call-shape tests

For files that pass a gate, assert **what must always be true**, not **what the code happens to do internally**.

**Good (invariant):**

```typescript
it('releases ECO and assigns revision letter to every affected item', async () => {
  const eco = await createEcoWith3Items(db, user)
  await ChangeOrderMergeService.merge(eco.id, user.id)

  for (const item of eco.affectedItems) {
    const released = await getItem(item.id)
    expect(released.revision).toMatch(/^[A-Z]+$/)
    expect(released.state).toBe('Released')
  }
})
```

**Bad (call-shape):**

```typescript
it('calls merge with correct params', async () => {
  const spy = vi.spyOn(ChangeOrderMergeService, 'merge')
  await someOperation()
  expect(spy).toHaveBeenCalledWith({ ecoId: 'x', userId: 'y' }) // brittle
})
```

**Assertion rules:**

- Match error **class** (`NotFoundError`, `ValidationError`) — not message strings
- Use `error.code` if matching more specifically
- Prefer real DB via `TestDatabase` over mocks — integration tests catch real bugs
- Do not write "it renders without crashing" tests
- Do not write a test that only passes because of a mock you set up

### 3. Golden examples to pattern-match

- `src/lib/services/BranchService.test.ts` — branch invariants
- `src/lib/services/ChangeOrderMergeService.test.ts` — ECO release invariants
- `src/lib/services/VersionResolver.test.ts` — version resolution correctness
- `src/lib/auth/AccessControlService.test.ts` — access boundary tests (once written in Phase 4)

### 4. Use the standard fixture pattern

```typescript
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest'
import { TestDatabase } from '@test/helpers/db'
import { insertTestUser } from '@test/fixtures/users'

describe('ServiceName', () => {
  const testDb = new TestDatabase()
  let user: TestUser

  beforeAll(async () => await testDb.setup())
  afterAll(async () => await testDb.teardown())
  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
  })
  afterEach(async () => await testDb.rollback())

  describe('methodName', () => {
    it('holds invariant X under condition Y', async () => {
      // Set up real state, perform operation, assert the invariant
    })
  })
})
```

See the memory note on shared-table seeding — `workflow_definitions` and `item_type_configs` go in `beforeAll`, per-test data in `beforeEach`.

### 5. Run each test after writing

```bash
npx vitest run <path-to-test-file>
```

Fix failures before moving on.

$ARGUMENTS

## After evaluation

Report:

1. Each evaluated file with its gate verdict (pass which gate, or "skip — no gate passed")
2. Tests generated (if any) and whether they pass
3. Any file where you chose to refuse — with one-line rationale

If _all_ files were refused, that's a correct outcome. Report it plainly. Do not fabricate reasons to write a test.

**Remind user**: Run `/test-ready` when ready to validate the full suite before committing.
