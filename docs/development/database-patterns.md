# Database Patterns

This guide covers the database conventions used in Cascadia, built on PostgreSQL 18+ with Drizzle ORM.

## Core Principles

1. **Always use Drizzle ORM** — never write raw SQL (except for migrations via `db.execute(sql\`...\`)`)
2. **Parameterized queries** — Drizzle handles parameterization automatically; never interpolate user input
3. **Use `.returning()`** — for `INSERT` and `UPDATE` operations to get the result back
4. **Use transactions** — for multi-step operations that must succeed or fail together

## Schema Conventions

Schema files live in `packages/core/src/lib/db/schema/`. Each file defines related tables.

### The Two-Table Pattern

Cascadia uses a **two-table pattern** for items: a shared `items` table holds common fields, and type-specific tables hold type-specific fields.

```
items (base fields)          parts (type-specific)
┌──────────────────┐         ┌──────────────────┐
│ id (PK)          │    ┌───>│ itemId (PK, FK)  │
│ masterId         │    │    │ description      │
│ itemNumber       │    │    │ partType         │
│ revision         │────┘    │ material         │
│ itemType         │         │ weight           │
│ name             │         │ cost             │
│ state            │         │ leadTimeDays     │
│ designId (FK)    │         └──────────────────┘
│ commitId (FK)    │
│ createdBy (FK)   │    documents (type-specific)
│ modifiedBy (FK)  │    ┌──────────────────┐
│ attributes (JSONB)│──>│ itemId (PK, FK)  │
│ isDeleted        │    │ description      │
│ ...              │    │ fileId           │
└──────────────────┘    │ fileName         │
                        └──────────────────┘
```

The `items` table:

```typescript
// packages/core/src/lib/db/schema/items.ts
export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    masterId: uuid('master_id').notNull(),
    itemNumber: varchar('item_number', { length: 100 }).notNull(),
    revision: varchar('revision', { length: 10 }).notNull(),
    itemType: varchar('item_type', { length: 50 }).notNull(),
    name: varchar('name', { length: 500 }),
    state: varchar('state', { length: 50 }).notNull().default('Draft'),
    isCurrent: boolean('is_current').default(true),
    designId: uuid('design_id').references(() => designs.id),
    commitId: uuid('commit_id').references(() => commits.id),
    attributes: jsonb('attributes')
      .$type<Record<string, unknown>>()
      .default({}),
    isDeleted: boolean('is_deleted').default(false),
    // ... timestamps, audit fields
  },
  (table) => [
    unique().on(
      table.itemNumber,
      table.revision,
      table.designId,
      table.itemType,
    ),
    index('idx_master_id').on(table.masterId),
    index('idx_item_type_state').on(table.itemType, table.state),
    index('idx_item_attributes').using('gin', table.attributes),
  ],
)
```

Type-specific tables reference `items.id` as their primary key:

```typescript
export const parts = pgTable('parts', {
  itemId: uuid('item_id')
    .primaryKey()
    .references(() => items.id, { onDelete: 'cascade' }),
  description: text('description'),
  partType: varchar('part_type', { length: 20 }),
  material: varchar('material', { length: 100 }),
  weight: decimal('weight', { precision: 10, scale: 3 }),
  cost: decimal('cost', { precision: 10, scale: 2 }),
  leadTimeDays: integer('lead_time_days'),
  // ...
})
```

### Column Type Conventions

| Data Type   | Drizzle Column                                  | Notes                               |
| ----------- | ----------------------------------------------- | ----------------------------------- |
| Primary key | `uuid('id').primaryKey().defaultRandom()`       | Always UUID, auto-generated         |
| Foreign key | `uuid('field').references(() => table.id)`      | With cascade where appropriate      |
| Short text  | `varchar('field', { length: N })`               | Use for constrained strings         |
| Long text   | `text('field')`                                 | Use for descriptions, content       |
| Money       | `decimal('field', { precision: 10, scale: 2 })` | Never use `float` for money         |
| Booleans    | `boolean('field').default(false)`               | Always provide a default            |
| Timestamps  | `timestamp('field', { withTimezone: true })`    | Always use timezone-aware           |
| JSON data   | `jsonb('field').$type<T>().default({})`         | Type the JSONB shape with `$type<>` |
| Enums       | `varchar('field', { length: 20 })`              | Use varchar, not pgEnum             |

### Index Conventions

Define indexes in the third argument to `pgTable`:

```typescript
export const items = pgTable('items', {/* columns */}, (table) => [
  unique().on(table.itemNumber, table.revision, table.designId, table.itemType),
  index('idx_master_id').on(table.masterId),
  index('idx_item_type_state').on(table.itemType, table.state),
  index('idx_item_attributes').using('gin', table.attributes), // GIN for JSONB
])
```

### Soft Delete Pattern

Items use soft deletes via `isDeleted`, `deletedAt`, and `deletedBy` columns. Use the `notDeleted()` filter helper:

```typescript
import { notDeleted } from '../db/filters'

// Always filter out soft-deleted items
const result = await db
  .select()
  .from(items)
  .where(and(eq(items.designId, designId), notDeleted()))
```

**`isDeleted` is the marker; `deletedAt`/`deletedBy` are the audit stamp that rides it.** Filter on `isDeleted` — via `notDeleted()`, the one spelling of the predicate, which treats NULL as "not deleted" because the column is nullable even though nothing writes NULL into it — and never on `deletedAt`. All three are written together in exactly one place: `ChangeOrderMergeService`'s `changeType === 'deleted'` arm, which obsoletes an item when its ECO merges. Nothing reads `deletedAt` or `deletedBy`; they exist to record who deleted the item and when. A soft-deleted row is history the system deliberately keeps, so treating the timestamp as a second visibility gate would invent a rule nothing else follows.

Soft-deletion is a visibility rule, not an authorization one. `requireItemAccess` in `lib/auth/access.ts` consults none of the three columns by design — a soft-deleted row keeps its `designId`, so the access boundary it draws is still correct, and whether the caller should _see_ the row stays with the reader that fetches it.

## Common Query Patterns

### Import Operators

Import Drizzle operators explicitly — do not import unused ones:

```typescript
import { and, eq, or, desc, inArray, isNotNull } from 'drizzle-orm'
```

### Select with Filter

```typescript
const result = await db
  .select()
  .from(branches)
  .where(
    and(
      eq(branches.designId, designId),
      eq(branches.branchType, 'eco'),
      eq(branches.isArchived, false),
    ),
  )
  .orderBy(desc(branches.createdAt))
```

### Select Specific Columns

```typescript
const result = await db
  .select({
    id: branches.id,
    name: branches.name,
    designName: designs.name,
  })
  .from(branches)
  .innerJoin(designs, eq(branches.designId, designs.id))
  .where(eq(branches.ownerId, userId))
```

### Insert with Returning

Always use `.returning()` to get the inserted row back:

```typescript
const [branch] = await db
  .insert(branches)
  .values({
    designId,
    name: branchName,
    branchType: 'eco',
    changeOrderItemId,
    createdBy: userId,
  })
  .returning()
```

### Update with Returning

```typescript
const [updated] = await db
  .update(branchItems)
  .set({
    checkedOutBy: userId,
    checkedOutAt: new Date(),
  })
  .where(eq(branchItems.id, bi.id))
  .returning()
```

### Upsert (Insert or Update)

```typescript
await db
  .insert(itemTypeConfigs)
  .values({ itemType: 'Part', config: newConfig })
  .onConflictDoUpdate({
    target: itemTypeConfigs.itemType,
    set: { config: newConfig },
  })
```

### Delete

```typescript
await db.delete(branchItems).where(eq(branchItems.id, bi.id))
```

### Conditional Query Building

Build where conditions dynamically using an array:

```typescript
const conditions = [eq(branches.designId, designId)]

if (filters?.branchType) {
  conditions.push(eq(branches.branchType, filters.branchType))
}
if (!filters?.includeArchived) {
  conditions.push(eq(branches.isArchived, false))
}

const result = await db
  .select()
  .from(branches)
  .where(and(...conditions))
```

### Query with Relational API

Drizzle provides a relational query API for simple lookups:

```typescript
const design = await db.query.designs.findFirst({
  where: eq(designs.id, designId),
  columns: { code: true },
})
```

### IN Clause

```typescript
import { inArray } from 'drizzle-orm'

await db.delete(items).where(inArray(items.id, itemIds))
```

## Transaction Usage

### Basic Transaction

```typescript
return db.transaction(async (tx) => {
  // Use 'tx' instead of 'db' for all queries inside the transaction
  const [item] = await tx
    .insert(items)
    .values({ ... })
    .returning()

  await tx.insert(parts).values({ itemId: item.id, ... })

  return item
})
```

### Transaction with Isolation Level

For operations requiring stronger consistency guarantees:

```typescript
return db.transaction(async (tx) => {
  const [branch] = await tx
    .insert(branches)
    .values({ ... })
    .returning()
  return branch
}, { isolationLevel: 'repeatable read' })
```

### Transaction Gotchas

- **Compose with `withTx`, never with bare `db.transaction()` in callees**: a service method accepts an optional trailing `tx?: TransactionClient`, threads it to callees, and wraps its own writes in `withTx(tx, fn)` from `@/lib/db`. A callee that ignores the caller's `tx` and opens its own transaction commits independently on another pooled connection — the caller's rollback leaves those writes behind, and the test suite cannot show it (its single-connection pool turns the mistake into a savepoint). See the `withTx` docblock in `packages/core/src/lib/db/index.ts`.
- **Use `tx` consistently**: Inside a transaction callback, always use the `tx` parameter, not the global `db` instance.
- **Keep transactions short**: Long-running transactions hold locks. Do preparation work before starting the transaction.

## Migration Workflow

Migration SQL is emitted into the app's own `drizzle/` directory, next to the
config — app-relative for the same reason the config lives in the app: the
schema is composed there, in `modules.schema.ts`, so the migration history it
generates belongs to that composition.

### Schema Change Workflow

1. **Edit schema** in `packages/core/src/lib/db/schema/*.ts`
2. **Apply to dev database**: `npm run db:push` (pushes schema directly)
3. **Keep seeds truthful**: if the change affects seeded data shapes, update
   `scripts/seed-minimal.ts` in the same commit — fresh databases are built
   from push + seeds, so seeds are the source of correct data

### Adding a Column

Edit the schema file:

```typescript
// In packages/core/src/lib/db/schema/items.ts
export const parts = pgTable('parts', {
  // ... existing columns
  newField: varchar('new_field', { length: 100 }), // Add new column
})
```

Then apply:

```bash
npm run db:push       # Applies to dev database
```

### Manual Migrations

For complex migrations (data backfills, index changes), create a temporary script:

```typescript
// scripts/migrate-xyz.ts
import { db } from '../src/lib/db'
import { sql } from 'drizzle-orm'

await db.execute(sql`ALTER TABLE parts ADD COLUMN new_field VARCHAR(100)`)
await db.execute(
  sql`UPDATE parts SET new_field = 'default' WHERE new_field IS NULL`,
)
```

Run with: `npx tsx scripts/migrate-xyz.ts`

### Self-Referencing Foreign Keys

Drizzle has issues with circular references. For self-referencing FKs, use a plain `uuid()` column without `.references()` and add the FK constraint via raw SQL migration:

```typescript
// In schema — no .references()
parentId: (uuid('parent_id'),
  // In migration script
  await db.execute(sql`
  ALTER TABLE my_table
  ADD CONSTRAINT fk_parent
  FOREIGN KEY (parent_id) REFERENCES my_table(id)
`))
```

## Database Reset and Seeding

For development and testing:

```bash
npm run db:reset              # Truncate all tables
npm run db:reset:seed         # Truncate + minimal seed (admin, roles, lifecycles)
```

Always truncate before reseeding to avoid duplicate key violations. Seed scripts use `onConflictDoNothing()` for idempotency, but complex seeds with multiple related records can still conflict on unique constraints.

## Drizzle Studio

For visual database exploration during development:

```bash
npm run db:studio
```

Opens a web UI at `https://local.drizzle.studio` for browsing tables, running queries, and inspecting data.
