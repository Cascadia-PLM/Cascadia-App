# Two-Table Pattern: Item Type Architecture

Cascadia uses a "two-table pattern" for all PLM items. Every item -- Part, Document, ChangeOrder, Requirement, Task, TestPlan, TestCase, Issue, WorkInstruction -- stores common fields in a shared `items` table and type-specific fields in a dedicated extension table. This document explains how it works, why it was chosen, and how to extend it.

---

## The Pattern

```
                    ┌─────────────────────────────────┐
                    │           items                  │
                    │─────────────────────────────────│
                    │ id (PK)           UUID           │
                    │ masterId          UUID           │  ← identity across revisions
                    │ itemNumber        "P-001"        │
                    │ revision          "A" / "DRAFT"  │
                    │ itemType          "Part"         │  ← discriminator
                    │ name              varchar(500)   │
                    │ state             "Draft"        │
                    │ isCurrent         boolean        │
                    │ designId          FK → designs   │
                    │ commitId          FK → commits   │
                    │ createdBy/At      audit          │
                    │ modifiedBy/At     audit          │
                    │ usageOf           UUID (nullable) │
                    │ attributes        JSONB           │
                    │ isDeleted         boolean         │
                    └──────────┬──────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼──────┐  ┌─────▼──────┐  ┌──────▼─────────┐
     │    parts       │  │  documents  │  │ change_orders   │  ...
     │───────────────│  │────────────│  │────────────────│
     │ itemId (PK/FK)│  │ itemId     │  │ itemId          │
     │ description   │  │ description│  │ changeType      │
     │ partType      │  │ fileId     │  │ priority        │
     │ material      │  │ fileName   │  │ reasonForChange │
     │ weight        │  │ fileSize   │  │ impactDescription│
     │ cost          │  │ mimeType   │  │ approvedBy      │
     │ leadTimeDays  │  │ storagePath│  │ closedAt        │
     │ ...           │  │            │  │ riskLevel       │
     └───────────────┘  └────────────┘  └─────────────────┘
```

The `itemId` column in each extension table is both the primary key and a foreign key referencing `items.id` with `ON DELETE CASCADE`. This means:

- Every extension row corresponds to exactly one `items` row
- Deleting an item cascades to its extension data
- You can always join `items` with `parts` (or any extension) on `id = itemId`

---

## The Shared `items` Table

Defined in `src/lib/db/schema/items.ts`:

```typescript
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
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    modifiedBy: uuid('modified_by')
      .notNull()
      .references(() => users.id),
    // ... timestamps, soft delete, SysML fields, JSONB attributes
  },
  (table) => [
    unique().on(
      table.itemNumber,
      table.revision,
      table.designId,
      table.itemType,
    ),
    index('idx_master_id').on(table.masterId),
    // ... additional indexes
  ],
)
```

Key columns:

| Column       | Purpose                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| `id`         | Unique to this specific _version_ of the item                                     |
| `masterId`   | Shared across all revisions of the same item -- the permanent identity            |
| `itemType`   | Discriminator: `'Part'`, `'Document'`, `'ChangeOrder'`, etc.                      |
| `revision`   | `'A'`, `'B'`, ... for released items; `'DRAFT'` while on an ECO branch            |
| `state`      | Lifecycle state: `'Draft'`, `'In Review'`, `'Released'`, `'Obsolete'`             |
| `isCurrent`  | Only the latest revision has this set to `true`                                   |
| `designId`   | Which design this item belongs to (version container)                             |
| `commitId`   | Which commit created/modified this version                                        |
| `usageOf`    | If set, this item is a "usage" referencing a "definition" item (SysML v2 pattern) |
| `attributes` | JSONB bag for extensible properties without schema changes                        |

---

## Type-Specific Extension Tables

Each item type has its own table with specialized fields. Current extension tables:

| Item Type       | Table               | Key Fields                                                                           |
| --------------- | ------------------- | ------------------------------------------------------------------------------------ |
| Part            | `parts`             | `partType`, `material`, `weight`, `cost`, `leadTimeDays`                             |
| Document        | `documents`         | `fileId`, `fileName`, `fileSize`, `mimeType`, `storagePath`                          |
| ChangeOrder     | `change_orders`     | `changeType`, `priority`, `reasonForChange`, `impactDescription`, `riskLevel`        |
| Requirement     | `requirements`      | `type`, `priority`, `verificationMethod`, `verificationStatus`, `acceptanceCriteria` |
| Task            | `tasks`             | `assignee`, `priority`, `dueDate`, `estimatedHours`, `actualHours`                   |
| TestPlan        | `test_plans`        | `scope`, `environment`, `entryCriteria`, `exitCriteria`                              |
| TestCase        | `test_cases`        | `testType`, `steps` (JSONB), `executionStatus`, `preconditions`                      |
| Issue           | `issues`            | `severity`, `category`, `rootCause`, `resolution`, `reportedBy`                      |
| WorkInstruction | `work_instructions` | (see schema)                                                                         |

All extension tables follow the same pattern:

```typescript
export const parts = pgTable('parts', {
  itemId: uuid('item_id')
    .primaryKey()
    .references(() => items.id, { onDelete: 'cascade' }),
  description: text('description'),
  partType: varchar('part_type', { length: 20 }),
  material: varchar('material', { length: 100 }),
  weight: decimal('weight', { precision: 10, scale: 3 }),
  // ...
})
```

---

## ItemService: Automatic Two-Table Handling

`ItemService` in `src/lib/items/services/ItemService.ts` handles both tables transparently. When you create or update an item, ItemService:

1. **Looks up the type config** via `ItemTypeRegistry.getType(type)` to find the extension table name
2. **Validates the full payload** against the Zod schema for that type (e.g., `partSchema`)
3. **Splits the data** into base fields (for `items`) and type-specific fields (for the extension table)
4. **Inserts/updates both tables** in a single transaction
5. **Returns merged data** -- the caller sees a flat object with all fields

When querying, `ItemService.findById()` joins `items` with the appropriate extension table based on `itemType`, returning a unified result.

---

## ItemTypeRegistry

`ItemTypeRegistry` in `src/lib/items/registry.ts` is the central registry where every item type declares its configuration:

```typescript
ItemTypeRegistry.register({
  name: 'Part',
  label: 'Part',
  pluralLabel: 'Parts',
  icon: 'Package',
  table: 'parts', // Extension table name
  schema: partSchema, // Zod validation schema
  defaultState: 'Draft',
  lifecycleDefinitionId: LIFECYCLE_IDS.part, // Which lifecycle controls state transitions
  states: partStates, // Fallback states if no lifecycle assigned
  relationships: partRelationships, // Allowed relationship types
  permissions: {
    create: ['*'],
    read: ['*'],
    update: ['*'],
    delete: ['Admin', 'Engineer'],
  },
  searchableFields: ['itemNumber', 'name', 'description', 'material'],
  displayField: 'itemNumber',
  components: { form, table, detail }, // React components for UI rendering
})
```

The registry implements a two-tier configuration system:

- **Code definitions**: Type-safe configs defined in TypeScript files (`src/lib/items/registerItemTypes.server.ts`). These include schemas, component references, and relationships.
- **Runtime configs**: Business rules loaded from the `item_type_configs` database table. These can override labels, icons, lifecycle assignment, and permissions without a code deploy.

Runtime overrides are merged on top of code defaults via `mergeConfigs()`. Components and schemas always come from code for type safety.

### Registration Flow

At server startup:

```
registerItemTypes.server.ts
    │
    ├── ItemTypeRegistry.register('Part', { ... })
    ├── ItemTypeRegistry.register('Document', { ... })
    ├── ItemTypeRegistry.register('ChangeOrder', { ... })
    ├── ... (9 item types total)
    │
    └── ItemTypeRegistry.initialize()
            │
            └── Loads runtime configs from item_type_configs table
                Merges with code definitions
                Caches merged results
```

---

## Supporting Tables

Beyond the core items + extension tables, the system includes several supporting tables that work with the two-table pattern:

### Change Order Supporting Tables

| Table                         | Purpose                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------- |
| `change_order_affected_items` | Links an ECO to the items it modifies (with change action: revise, add, delete) |
| `change_order_impacted_items` | Items indirectly affected by the change (discovered via BOM traversal)          |
| `change_order_risks`          | Risk assessments for a change order                                             |
| `change_order_impact_reports` | Generated impact analysis reports                                               |
| `change_order_designs`        | Tracks which designs an ECO affects and their branch/merge status               |

### Relationships

```typescript
export const itemRelationships = pgTable('item_relationships', {
  sourceId: uuid('source_id').references(() => items.id, {
    onDelete: 'cascade',
  }),
  targetId: uuid('target_id').references(() => items.id, {
    onDelete: 'cascade',
  }),
  relationshipType: varchar('relationship_type', { length: 50 }).notNull(),
  quantity: decimal('quantity', { precision: 10, scale: 3 }),
  // SysML 2.0 fields: isComposite, isDirected, multiplicity, usageAttributes
  // Cross-design traceability: sourceDesignId, targetDesignId, derivationMethod
})
```

BOM (Bill of Materials) relationships connect parts to sub-parts. The `relationshipType` field distinguishes BOM, Document, Requirement allocation, and other relationship types.

---

## Benefits of This Pattern

### 1. Unified Queries Across All Types

Need to find all items in a design? Query `items` once:

```typescript
const allItems = await db
  .select()
  .from(items)
  .where(eq(items.designId, designId))
```

Need to find all items changed on a branch? Join `items` with `branchItems`:

```typescript
const changed = await db
  .select()
  .from(branchItems)
  .innerJoin(items, eq(branchItems.currentItemId, items.id))
  .where(eq(branchItems.branchId, branchId))
```

No need to query 9 separate tables and union the results.

### 2. Type-Specific Integrity

Parts can have `NOT NULL` constraints on `partType`. Documents can enforce `fileId` presence. Change orders can require `changeType`. Each extension table enforces its own domain rules through database constraints.

### 3. Shared Versioning Infrastructure

The versioning system (`branches`, `commits`, `branchItems`, `itemVersions`) operates on `items.id` and `items.masterId`. It works identically for Parts, Documents, Requirements, or any future item type. No per-type versioning code.

### 4. Extensible Without Breaking

Adding a new item type requires:

1. A new extension table in the schema
2. A Zod schema and TypeScript interface
3. A `register()` call in the registry
4. Form/table/detail components

No changes to the versioning system, branching, conflict detection, or merge logic.

### 5. Efficient Storage

Type-specific columns only exist in the extension table. A ChangeOrder row does not carry empty `weight`, `material`, and `cost` columns -- those only exist in `parts`.

---

## How to Read the Schema

Start with these files:

| File                                        | Contains                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `src/lib/db/schema/items.ts`                | The `items` table + all extension tables + `itemRelationships`           |
| `src/lib/db/schema/versioning.ts`           | `branches`, `commits`, `branchItems`, `itemVersions`, `itemFieldChanges` |
| `src/lib/db/schema/designs.ts`              | `designs` table                                                          |
| `src/lib/db/schema/users.ts`                | `users`, `sessions`, `roles`, `userRoles`, `authEvents`                  |
| `src/lib/items/types/part.ts`               | Part-specific Zod schema and interface                                   |
| `src/lib/items/types/base.ts`               | `BaseItem` interface and `ItemTypeConfig` definition                     |
| `src/lib/items/registry.ts`                 | `ItemTypeRegistry` class                                                 |
| `src/lib/items/registerItemTypes.server.ts` | All item type registrations                                              |
