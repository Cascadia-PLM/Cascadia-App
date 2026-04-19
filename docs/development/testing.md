# Testing Guide

This guide covers the testing infrastructure, philosophy, and utilities for Cascadia PLM. For the complete reference, see the root-level `docs/testing.md`.

## Testing Philosophy

**Quality over quantity.** Tests are focused on code where bugs cause real damage. Most code does NOT need unit tests.

### What Requires Tests

| Category                | Examples                                                         | Why                             |
| ----------------------- | ---------------------------------------------------------------- | ------------------------------- |
| **Data Integrity**      | ECO release, branching, versioning, conflict detection, checkout | Data corruption is catastrophic |
| **Security**            | Authentication, access control, permissions                      | Security bugs are unacceptable  |
| **Complex Algorithms**  | Merge logic, workflow state machines                             | Hard to verify manually         |
| **Core Business Logic** | ItemService, ChangeOrderService, WorkflowService                 | Business rules must be correct  |

### What Does NOT Require Tests

| Category          | Examples                         | Why                              |
| ----------------- | -------------------------------- | -------------------------------- |
| **API Routes**    | `/api/parts`, `/api/documents`   | Just delegate to tested services |
| **UI Components** | PartForm, DocumentList           | E2E tests cover user flows       |
| **Utilities**     | formatDate, cn(), string helpers | Trivial code                     |
| **Schemas/Types** | Zod schemas, TypeScript types    | Testing library code             |
| **Config/Errors** | Error classes, config files      | Just data structures             |

### Decision Tree

Before writing a test:

1. Could a bug here corrupt data? -- Write tests
2. Could a bug here create a security vulnerability? -- Write tests
3. Is this a complex algorithm hard to verify manually? -- Write tests
4. Is this just connecting pieces together? -- Skip (E2E covers this)
5. Is this trivial code? -- Skip

## Quick Start

```bash
npm run test          # Run all unit/integration tests
npm run test:watch    # Watch mode for development
npm run test:coverage # Run with coverage report
npm run test:ui       # Open Vitest UI

# Run a single file
npx vitest run src/lib/services/BranchService.test.ts

# Run tests matching a pattern
npx vitest run -t "should create branch"

# E2E tests
npm run test:e2e          # Run Playwright tests
npm run test:e2e:ui       # Run with UI mode
npm run test:e2e:full     # Reset database + seed + run tests
```

## Test Architecture

| Layer           | Tool         | Location                 | Purpose                        |
| --------------- | ------------ | ------------------------ | ------------------------------ |
| **Unit**        | Vitest       | `src/**/*.test.ts`       | Service logic, algorithms      |
| **Component**   | Vitest + RTL | `src/**/*.test.tsx`      | Complex interactive components |
| **Integration** | Vitest       | `src/**/*.test.ts`       | Services with real database    |
| **E2E**         | Playwright   | `tests/e2e/**/*.spec.ts` | Full user workflows            |

Tests are co-located with the code they test:

```
src/lib/services/
├── BranchService.ts
├── BranchService.test.ts     # Co-located test
├── CheckoutService.ts
├── CheckoutService.test.ts
```

Shared test infrastructure lives in `src/__tests__/`:

```
src/__tests__/
├── setup.ts              # Test setup (runs before each file)
├── global-setup.ts       # Global setup (runs once)
├── fixtures/             # Test data factories
│   ├── builder.ts        # TestDataBuilder
│   ├── users.ts          # User fixtures
│   ├── items.ts          # Item fixtures
│   └── organizations.ts  # Organization fixtures
└── helpers/              # Test utilities
    ├── db.ts             # TestDatabase helper
    ├── auth.ts           # Auth mocking
    ├── api.ts            # API test client
    ├── vault.ts          # MockVaultStorage
    └── render.tsx        # React render helpers
```

## Writing Unit Tests

Vitest globals are enabled — `describe`, `it`, `expect`, `vi` are available without import.

```typescript
// src/lib/services/BranchService.test.ts
describe('BranchService', () => {
  describe('createEcoBranch', () => {
    it('creates a branch named eco/{itemNumber}', async () => {
      // Arrange
      const designId = 'design-123'
      const changeOrderItemId = 'eco-456'

      // Act
      const branch = await BranchService.createEcoBranch(
        designId,
        changeOrderItemId,
        userId,
      )

      // Assert
      expect(branch.name).toMatch(/^eco\//)
      expect(branch.branchType).toBe('eco')
      expect(branch.designId).toBe(designId)
    })

    it('throws NotFoundError when change order does not exist', async () => {
      await expect(
        BranchService.createEcoBranch(designId, 'nonexistent', userId),
      ).rejects.toThrow(NotFoundError)
    })
  })
})
```

## Integration Tests with TestDatabase

Integration tests use `TestDatabase` for transaction-based isolation:

```typescript
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestOrganization } from '@/__tests__/fixtures/organizations'
import { insertTestUser } from '@/__tests__/fixtures/users'

describe('MyService', () => {
  const testDb = new TestDatabase()
  let org: any, user: any

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    org = await insertTestOrganization(testDb.db)
    user = await insertTestUser(testDb.db, org.id)
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('does something with the database', async () => {
    // All changes are rolled back after each test
    const result = await MyService.doSomething(user.id)
    expect(result).toBeDefined()
  })
})
```

### TestDatabase Gotchas

- **Never set `maxConnections > 1`**: postgres.js throws `UNSAFE_TRANSACTION` when raw `BEGIN` is used with max > 1
- **Services that call `db.transaction()`** (ItemService, etc.) can deadlock with TestDatabase's `BEGIN` because postgres.js tries to reserve a new connection
- **Shared table seeding** (`workflow_definitions`, `item_type_configs`) must go in `beforeAll`, not `beforeEach` to prevent deadlocks
- **Per-test data** (users, items, designs) stays in `beforeEach` for rollback isolation

## Test Fixtures

### Factory Functions

```typescript
import {
  insertTestPart,
  insertTestDocument,
  insertTestChangeOrder,
  createBOMRelationship,
} from '@/__tests__/fixtures/items'

// Create a part with defaults
const { item, part } = await insertTestPart(db, orgId, userId, {
  name: 'Motor Assembly',
  partType: 'Manufacture',
})

// Create a BOM relationship
await createBOMRelationship(db, parentId, childId, userId, {
  quantity: 5,
  findNumber: 10,
})
```

### TestDataBuilder

For complex test scenarios, use the fluent builder:

```typescript
import { TestDataBuilder } from '@/__tests__/fixtures/builder'

const scenario = await new TestDataBuilder(db)
  .withOrganization({ name: 'Acme Corp' })
  .withUser({ email: 'admin@acme.com' }, 'Administrator')
  .withPart({ name: 'Assembly' }, 'assembly')
  .withPart({ name: 'Component' }, 'component')
  .withBOM('assembly', 'component', { quantity: 2 })
  .build()

// Access built data
const userId = scenario.users['admin@acme.com'].id
const assemblyId = scenario.parts['assembly'].item.id
```

## Component Tests

Only write component tests for complex interactive behavior. Most components are covered by E2E.

```typescript
import { renderWithProviders, screen } from '@/__tests__/helpers/render'

describe('ViewEditField', () => {
  it('switches to edit mode on click', async () => {
    const { user } = renderWithProviders(
      <ViewEditField value="test" onSave={vi.fn()} />
    )

    await user.click(screen.getByText('test'))
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })
})
```

## E2E Tests

E2E tests run in a real browser with Playwright. They are expensive — only test critical user paths.

### Setup

```bash
# One-time setup
npx playwright install

# Full test run (resets DB, seeds, runs tests)
npm run test:e2e:full

# Or manually:
npm run db:reset:seed    # Reset database
npm run dev              # Start server (separate terminal)
npm run test:e2e         # Run tests
```

### Test Data

E2E tests expect:

- Admin user: `admin@cascadia.local` / `Cascadia`
- The Default Program and Standard Parts Library created by the minimal seed

### Writing E2E Tests

```typescript
// tests/e2e/my-feature.spec.ts
import { test, expect } from './fixtures'

test.describe('My Feature', () => {
  test('user can create a widget', async ({ authenticatedPage: page }) => {
    await page.goto('/widgets')
    await page.getByRole('button', { name: 'New Widget' }).click()
    await page.getByLabel('Item Number').fill('WDG-001')
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(page).toHaveURL(/\/widgets\//)
  })
})
```

### Page Object Model

Encapsulate page interactions in page objects:

```typescript
// tests/e2e/pages/widgets-page.ts
export class WidgetsPage {
  constructor(private page: Page) {}

  async goto() {
    await this.page.goto('/widgets')
  }

  async createWidget(data: { itemNumber: string; name: string }) {
    await this.page.getByRole('button', { name: 'New Widget' }).click()
    await this.page.getByLabel('Item Number').fill(data.itemNumber)
    await this.page.getByLabel('Name').fill(data.name)
    await this.page.getByRole('button', { name: 'Save' }).click()
  }
}

// In the test
test('create widget', async ({ authenticatedPage: page }) => {
  const widgetsPage = new WidgetsPage(page)
  await widgetsPage.goto()
  await widgetsPage.createWidget({ itemNumber: 'WDG-001', name: 'Test' })
})
```

### Test Tiers

Tests are organized by criticality:

```
Tier 1 (@tier1) - Smoke tests, run on every PR (~2 min)
├── auth.spec.ts
├── navigation.spec.ts

Tier 2 (@tier2) - Core workflows, run on merge to main (~10 min)
├── eco-workflow.spec.ts
├── design-management.spec.ts

Tier 3 - Edge cases, run nightly
├── concurrent-edit.spec.ts
```

Run specific tiers: `npx playwright test --grep @tier1`

### Selector Strategy

Priority order:

1. **Role-based**: `page.getByRole('button', { name: 'Submit' })`
2. **Label-based**: `page.getByLabel('Username')`
3. **Test ID**: `page.getByTestId('submit-button')`
4. **Text content**: `page.getByText('Sign in')`

Avoid CSS selectors and index-based selectors.

## Test Utilities Reference

### Database (`@/__tests__/helpers/db`)

| Utility         | Description                                          |
| --------------- | ---------------------------------------------------- |
| `TestDatabase`  | Database wrapper with transaction rollback isolation |
| `setupTestDb()` | Quick setup helper                                   |

### Auth (`@/__tests__/helpers/auth`)

| Utility               | Description                     |
| --------------------- | ------------------------------- |
| `createMockRequest()` | Create mock HTTP request        |
| `createMockSession()` | Create mock session data        |
| `mockAuth()`          | Create auth context for testing |

### Fixtures (`@/__tests__/fixtures`)

| Utility                   | Description                          |
| ------------------------- | ------------------------------------ |
| `insertTestPart()`        | Create test part in database         |
| `insertTestDocument()`    | Create test document                 |
| `insertTestChangeOrder()` | Create test ECO                      |
| `createBOMRelationship()` | Create BOM link                      |
| `TestDataBuilder`         | Fluent builder for complex scenarios |

### Vault (`@/__tests__/helpers/vault`)

| Utility            | Description                    |
| ------------------ | ------------------------------ |
| `MockVaultStorage` | In-memory vault for unit tests |
| `createTestFile()` | Generate test file buffers     |

### Render (`@/__tests__/helpers/render`)

| Utility                 | Description                   |
| ----------------------- | ----------------------------- |
| `renderWithProviders()` | Render with all app providers |

## CI/CD

Tests run in GitHub Actions with a real PostgreSQL service container. See the workflow in `.github/workflows/test.yml`.

Key CI concerns:

- Tests use forked process pool for parallelization (`singleFork: false` is required)
- Each test file gets its own worker process, isolating database connections
- `idle_in_transaction_session_timeout = 30s` auto-kills stuck test transactions
