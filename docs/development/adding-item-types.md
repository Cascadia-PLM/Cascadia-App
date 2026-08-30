# Adding Item Types

This guide walks through adding a new item type to Cascadia PLM. Item types are the core data model — Parts, Documents, Requirements, etc. are all item types.

## Overview

Adding an item type requires changes in 6 areas:

1. Database schema (type-specific table)
2. Migration
3. Zod validation schema + TypeScript interface
4. Registry registration
5. API schemas (create/update)
6. Form component

## Step 1: Add Database Schema

Create a type-specific table in `packages/core/src/lib/db/schema/items.ts`. This table holds fields unique to your item type, with a foreign key back to the shared `items` table.

```typescript
// packages/core/src/lib/db/schema/items.ts

export const widgets = pgTable('widgets', {
  // Primary key that references the base items table
  itemId: uuid('item_id')
    .primaryKey()
    .references(() => items.id, { onDelete: 'cascade' }),

  // Type-specific fields
  description: text('description'),
  widgetCategory: varchar('widget_category', { length: 50 }),
  serialNumber: varchar('serial_number', { length: 100 }),
  calibrationDate: timestamp('calibration_date', { withTimezone: true }),
  isActive: boolean('is_active').default(true),
})
```

Export the new table from the schema index:

```typescript
// packages/core/src/lib/db/schema/index.ts
export { widgets } from './items'
```

## Step 2: Apply the Schema

```bash
npm run db:push       # Applies to dev database
```

Apply the change to your dev database with `npm run db:push` (interactive — drizzle-kit prompts), then mint the migrations that ship it for **both editions**: `npm run db:generate` and `CASCADIA_APP=cascadia npm run db:generate`, and commit what appears under `apps/*/drizzle/` — CI's drift gate fails on schema/migration drift. Committed migrations are the upgrade path for released installs (`npm run db:migrate`); `db:push` is dev/CI/demo only. See [database-patterns.md](./database-patterns.md#migration-workflow) and docs/deployment/upgrading.md.

## Step 3: Create Type Definition

Create `packages/core/src/lib/items/types/widget.ts` with the TypeScript interface and Zod schema.

```typescript
// packages/core/src/lib/items/types/widget.ts
import { z } from 'zod'
import { baseItemSchema, commonStates } from './base'
import type { BaseItem } from './base'

// TypeScript interface extending BaseItem
export interface Widget extends BaseItem {
  itemType: 'Widget'
  designId: string
  description?: string
  widgetCategory?: 'Standard' | 'Premium' | 'Custom'
  serialNumber?: string
  calibrationDate?: Date
  isActive?: boolean
}

// Zod validation schema extending the base schema
export const widgetSchema = baseItemSchema.extend({
  itemType: z.literal('Widget'),
  designId: z.string().uuid({ message: 'Design is required' }),
  description: z.string().max(5000).optional(),
  widgetCategory: z.enum(['Standard', 'Premium', 'Custom']).optional(),
  serialNumber: z.string().max(100).optional(),
  calibrationDate: z.date().optional(),
  isActive: z.boolean().optional().default(true),
})

// States — use commonStates or define custom ones
export const widgetStates = commonStates

// Relationships — what this type can link to
export const widgetRelationships = [
  {
    type: 'Document',
    label: 'Documents',
    targetTypes: ['Document'],
    allowMultiple: true,
  },
  {
    type: 'Change',
    label: 'Change Orders',
    targetTypes: ['ChangeOrder'],
    allowMultiple: true,
  },
]

export type WidgetInput = z.infer<typeof widgetSchema>
```

## Step 4: Register the Item Type

### Server-Side Registration

Add the registration to `packages/core/src/lib/items/registerItemTypes.server.ts`:

```typescript
import { widgetRelationships, widgetSchema, widgetStates } from './types/widget'

// Dummy components for server-side registration
const DummyComponent = () => null

ItemTypeRegistry.register({
  name: 'Widget',
  label: 'Widget',
  pluralLabel: 'Widgets',
  icon: 'Wrench', // Lucide icon name
  table: 'widgets', // Database table name
  schema: widgetSchema,
  states: widgetStates, // seed-source palette; the lifecycle is the authority at runtime
  lifecycleDefinitionId: LIFECYCLE_IDS.part, // Use existing lifecycle or create new one
  relationships: widgetRelationships,
  components: {
    form: DummyComponent as any,
    table: DummyComponent as any,
    detail: DummyComponent as any,
  },
  permissions: {
    create: ['*'],
    read: ['*'],
    update: ['*'],
    delete: ['Admin', 'Engineer'],
  },
  searchableFields: ['itemNumber', 'name', 'description', 'serialNumber'],
  displayField: 'itemNumber',
})
```

### Client-Side Registration

Add to `packages/core/src/lib/items/registerItemTypes.tsx` with actual form components:

```typescript
import { WidgetForm } from '@/components/widgets/WidgetForm'
import { widgetRelationships, widgetSchema, widgetStates } from './types/widget'

ItemTypeRegistry.register({
  name: 'Widget',
  label: 'Widget',
  // ... same as server-side, but with real components:
  components: {
    form: WidgetForm,
    table: DummyComponent as any,
    detail: DummyComponent as any,
  },
})
```

### Lifecycle Definition

**Every item type must have a lifecycle** — there is no literal default state anywhere in the services; `ItemService.create` resolves the lifecycle's `isInitial` state, and the type's released family, branch-protection exemption and final states all derive from the lifecycle's flags and mappings. A new type needs:

1. A well-known ID in `packages/core/src/lib/items/lifecycle-ids.ts`.
2. A default definition in `packages/core/src/lib/items/default-lifecycles.ts` — added to `DEFAULT_ITEM_LIFECYCLES` and linked in `DEFAULT_LIFECYCLE_LINKS` — which the app seed, the test global-setup and the fixtures all seed. Or reuse one: Software links to `LIFECYCLE_IDS.part`.
3. `lifecycleDefinitionId` in the registration above pointing at it.

Pick the lifecycle type by how the item changes state: **Driven** (state changes only through ECO release; define `release`/`revise`/`obsolete` mappings — these are what make a state "released"), **Free** (manual transitions through `POST /api/v1/items/:id/transition`), or the degenerate Free lifecycle — one state flagged both `isInitial` and `isFinal`, named something like `Current` — for a type with no meaningful flow. Finals on Free lifecycles may declare `finalKind: 'complete' | 'cancel'` when something (like the work-order traveler gate) needs to tell success from abandonment.

Never gate on a state's name in code; ask `LifecycleService` (`isReleasedFamilyState`, `isInitialState`, `getFinalStateIds`, `getFinalKind`) and render with `StateBadge`.

## Step 5: Update ItemService Type-Specific Methods

`ItemService` handles the two-table insert/update pattern. You need to add your type to the type-specific data handlers.

In `packages/core/src/lib/items/services/ItemService.ts`, add cases for your type in:

### insertTypeSpecificData

```typescript
private static async insertTypeSpecificData(
  type: string,
  itemId: string,
  data: any,
  tx: TransactionClient,
) {
  switch (type) {
    case 'Part':
      await tx.insert(parts).values({ itemId, ... })
      break
    case 'Document':
      await tx.insert(documents).values({ itemId, ... })
      break
    // Add your type:
    case 'Widget':
      await tx.insert(widgets).values({
        itemId,
        description: data.description,
        widgetCategory: data.widgetCategory,
        serialNumber: data.serialNumber,
        calibrationDate: data.calibrationDate,
        isActive: data.isActive,
      })
      break
  }
}
```

### updateTypeSpecificData

Same pattern for updates — add a case that updates the `widgets` table.

### findById / search

The `findById` method joins the base `items` table with the type-specific table. Add a case for your new table.

## Step 6: Add API Schemas

Add create and update schemas to `packages/core/src/lib/api/schemas.ts`:

```typescript
// packages/core/src/lib/api/schemas.ts

export const widgetCreateSchema = z.object({
  itemNumber: z.string().min(1, 'Item number is required').max(100),
  // Optional: a create never states a revision - the server assigns it from
  // the type's lifecycle. See docs/features/versioning.md.
  revision: z.string().min(1).max(10).optional(),
  name: z.string().max(500).optional(),
  designId: z.string().uuid('Design is required'),
  description: z.string().max(5000).optional(),
  widgetCategory: z.enum(['Standard', 'Premium', 'Custom']).optional(),
  serialNumber: z.string().max(100).optional(),
  branchId: z.string().uuid().optional(),
})

export const widgetUpdateSchema = z.object({
  name: z.string().max(500).optional(),
  description: z.string().max(5000).optional(),
  widgetCategory: z.enum(['Standard', 'Premium', 'Custom']).optional(),
  serialNumber: z.string().max(100).optional(),
  state: z.string().max(50).optional(),
  commitMessage: z.string().max(500).optional(),
})

export type WidgetCreate = z.infer<typeof widgetCreateSchema>
export type WidgetUpdate = z.infer<typeof widgetUpdateSchema>
```

## Step 7: Create API Routes

Create a route file at `packages/core/src/server/routes/widgets.ts`:

```typescript
// packages/core/src/server/routes/widgets.ts
import { Hono } from 'hono'
import { adapt } from '../adapter'
import { ItemService } from '@/lib/items/services/ItemService'
import { NotFoundError } from '@/lib/errors'
import { apiHandler } from '@/lib/api/handler'
import '@/lib/items/registerItemTypes.server'

const app = new Hono()

// GET /api/v1/widgets/:id
app.get(
  '/:id',
  adapt(
    apiHandler({ permission: ['widgets', 'read'] }, async ({ params }) => {
      const widget = await ItemService.findById(params.id)
      if (!widget) throw new NotFoundError('Widget', params.id)
      return { widget }
    }),
  ),
)

// PUT /api/v1/widgets/:id
app.put(
  '/:id',
  adapt(
    apiHandler(
      { permission: ['widgets', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()
        const widget = await ItemService.update(params.id, data, user.id)
        return { widget }
      },
    ),
  ),
)

// DELETE /api/v1/widgets/:id
app.delete(
  '/:id',
  adapt(
    apiHandler({ permission: ['widgets', 'delete'] }, async ({ params }) => {
      await ItemService.delete(params.id)
      return { success: true }
    }),
  ),
)

export default app
```

Then mount the route in `packages/core/src/server/index.ts`:

```typescript
import widgets from './routes/widgets'

app.route('/api/v1/widgets', widgets)
```

## Step 8: Create Form Component

Create `packages/core/src/components/widgets/WidgetForm.tsx`:

```typescript
import { useForm } from '@tanstack/react-form'
import { zodValidator } from '@/lib/form-validation'
import { widgetCreateSchema } from '@/lib/api/schemas'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'

export function WidgetForm({ onSubmit, item, disabled }: WidgetFormProps) {
  const form = useForm({
    defaultValues: {
      itemNumber: item?.itemNumber ?? '',
      name: item?.name ?? '',
      description: item?.description ?? '',
      widgetCategory: item?.widgetCategory ?? '',
      serialNumber: item?.serialNumber ?? '',
    },
    validators: {
      onSubmit: zodValidator(widgetCreateSchema),
    },
    onSubmit: async ({ value }) => {
      await onSubmit(value)
    },
  })

  return (
    <form onSubmit={(e) => { e.preventDefault(); form.handleSubmit() }}>
      <form.Field name="itemNumber">
        {(field) => (
          <FormField
            label="Item Number"
            required
            error={field.state.meta.errors?.[0] as string | undefined}
          >
            <Input
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
            />
          </FormField>
        )}
      </form.Field>
      {/* ... more fields */}
      <Button type="submit" disabled={disabled}>Save</Button>
    </form>
  )
}
```

## Checklist

- [ ] Type-specific table in `packages/core/src/lib/db/schema/items.ts`
- [ ] Export from `packages/core/src/lib/db/schema/index.ts`
- [ ] Migration generated and applied
- [ ] Type definition in `packages/core/src/lib/items/types/widget.ts`
- [ ] Registered in `registerItemTypes.server.ts`
- [ ] Registered in `registerItemTypes.tsx`
- [ ] RBAC resource mapping in `packages/core/src/lib/items/item-type-resources.ts`
      (a test fails if the mapping is missing) and the new resource granted
      in `ROLE_DEFINITIONS` (`packages/core/src/lib/auth/permissions.ts`)
- [ ] Cases added to `ItemService` type-specific methods
- [ ] API schemas in `packages/core/src/lib/api/schemas.ts`
- [ ] API routes in `packages/core/src/server/routes/widgets.ts`
- [ ] Form component
- [ ] Seed data (if needed for testing)

The AI chatbot and MCP tool schemas need **no changes**: `search_items` and
`create_item` derive their item-type coverage from `ITEM_TYPE_DEFINITIONS`
automatically, and per-type permission checks flow through the resource
mapping above.

## Existing Item Types for Reference

| Type            | Table               | Schema File                 | Lifecycle                      |
| --------------- | ------------------- | --------------------------- | ------------------------------ |
| Part            | `parts`             | `types/part.ts`             | Driven (ECO-controlled)        |
| Document        | `documents`         | `types/document.ts`         | Driven                         |
| Requirement     | `requirements`      | `types/requirement.ts`      | Driven                         |
| ChangeOrder     | `change_orders`     | `types/change-order.ts`     | Driving (controls others)      |
| Task            | `tasks`             | `types/task.ts`             | Free (self-controlled)         |
| TestPlan        | `test_plans`        | `types/testplan.ts`         | Free                           |
| TestCase        | `test_cases`        | `types/testcase.ts`         | Free                           |
| Issue           | `issues`            | `types/issue.ts`            | Free                           |
| WorkInstruction | `work_instructions` | `types/work-instruction.ts` | Free                           |
| Tool            | `tools`             | `types/tool.ts`             | Free                           |
| Software        | `software`          | `types/software.ts`         | Driven (shares Part lifecycle) |
