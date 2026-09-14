# Adding Item Types

This guide walks through adding a new item type to Cascadia PLM. Item types are the core data model — Parts, Documents, Requirements, etc. are all item types.

## Overview

Adding an item type requires changes in 8 areas:

1. Database schema (type-specific table)
2. Migration
3. Zod validation schema + TypeScript interface
4. The definition entry (one record; most of the system derives from it)
5. A type handler (reads and writes the extension table)
6. A lifecycle, RBAC resource and numbering scheme
7. API schemas (create/update) and routes
8. Client pages and navigation

The checklist at the end is the authoritative list — some of these are pinned
by tests and some are not, and it says which.

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
import { baseItemSchema } from './base'
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

## Step 4: Add the Definition

Every item type is one entry in `ITEM_TYPE_DEFINITIONS`
(`packages/core/src/lib/items/item-type-definitions.ts`). There are no
per-type `register()` calls: `registerItemTypes.server.ts` loops over this
record, and the AI and MCP tool enums, the OpenAPI create union, the admin
listing and the search type filter all derive from it.

```typescript
// packages/core/src/lib/items/item-type-definitions.ts
import { widgetRelationships, widgetSchema } from './types/widget'

export const ITEM_TYPE_DEFINITIONS: Record<string, SharedItemTypeDef> = {
  // ...
  Widget: {
    name: 'Widget',
    label: 'Widget',
    pluralLabel: 'Widgets',
    icon: 'Wrench', // Lucide icon name, resolved by item-type-ui.ts
    schema: widgetSchema,
    lifecycleDefinitionId: LIFECYCLE_IDS.widget,
    relationships: widgetRelationships,
    searchableFields: ['itemNumber', 'name', 'description', 'serialNumber'],
    displayField: 'itemNumber',
  },
}
```

There is no client-side registration step. A `registerItemTypes.tsx` used to
register the same definitions with React components attached; nothing
imported it and nothing read the components, so both are gone. The browser
gets a type's icon, label and detail-route path from
`packages/core/src/lib/items/item-type-ui.ts`.

### Lifecycle Definition

**Every item type must have a lifecycle** — there is no literal default state
anywhere in the services; `ItemService.create` resolves the lifecycle's
`isInitial` state, and the type's released family, branch-protection
exemption and final states all derive from the lifecycle's flags and
mappings. A new type needs:

1. A well-known ID in `packages/core/src/lib/items/lifecycle-ids.ts`.
2. A default definition in `packages/core/src/lib/items/default-lifecycles.ts` — added to `DEFAULT_ITEM_LIFECYCLES` and linked in `DEFAULT_LIFECYCLE_LINKS` — which the app seed, the test global-setup and the fixtures all seed. Or reuse one: Software links to `LIFECYCLE_IDS.part`.
3. `lifecycleDefinitionId` in the definition above pointing at it.

Both of the first two are pinned by `default-lifecycles.test.ts`.

Pick the lifecycle type by how the item changes state: **Driven** (state
changes only through ECO release; define `release`/`revise`/`obsolete`
mappings — these are what make a state "released"), **Free** (manual
transitions through `POST /api/v1/items/:id/transition`), or the degenerate
Free lifecycle — one state flagged both `isInitial` and `isFinal`, named
something like `Current` — for a type with no meaningful flow. Finals on Free
lifecycles may declare `finalKind: 'complete' | 'cancel'` when something
(like the work-order traveler gate) needs to tell success from abandonment.

Never gate on a state's name in code; ask `LifecycleService`
(`isReleasedFamilyState`, `isInitialState`, `getFinalStateIds`,
`getFinalKind`) and render with `StateBadge`.

An administrator can reassign the lifecycle later under **Admin > Item
Types**. That is the only runtime-configurable thing about an item type;
everything else on this page is code.

## Step 5: Add a Type Handler

`ItemService` has no per-type switch. Reads and writes to an extension table
go through a `TypeHandler`, which owns the Drizzle table object and the
type's insert/get/update. Create
`packages/core/src/lib/items/type-handlers/widget.ts`:

```typescript
// packages/core/src/lib/items/type-handlers/widget.ts
import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { widgets } from '@/lib/db/schema'

registerTypeHandler('Widget', {
  table: widgets,

  async insert(itemId, data, tx) {
    const run = tx ?? db
    await run.insert(widgets).values({
      itemId,
      description: data.description || null,
      widgetCategory: data.widgetCategory || null,
      serialNumber: data.serialNumber || null,
    })
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [widget] = await run
      .select()
      .from(widgets)
      .where(eq(widgets.itemId, itemId))
      .limit(1)
    return widget
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}
    if (data.description !== undefined)
      updateData.description = data.description || null
    // ... one line per updatable column
    if (Object.keys(updateData).length > 0) {
      await run
        .update(widgets)
        .set(updateData)
        .where(eq(widgets.itemId, itemId))
    }
  },
})
```

Then add the side-effect import to
`packages/core/src/lib/items/type-handlers/init.ts`.

Registering the handler is what makes generic machinery work for the new
type: `ItemService` create/update, the version-to-version row copy, checkout,
merge, conflict detection, and the search join that carries a type's own
columns back with the base item. A type with no handler creates and then
silently loses its extension data, so the create path throws rather than
letting that happen.

If the type keeps content in child tables (as WorkInstruction does with
operations and steps), also declare `copyChildren` on the handler, so a new
version carries them.

Numbering is separate and required: add a scheme to
`packages/core/src/lib/items/numbering/schemes.ts`, or `ItemService.create`
throws for the new type.

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

Pinned by a test — CI fails if you skip it:

- [ ] Definition entry in `packages/core/src/lib/items/item-type-definitions.ts`
- [ ] Type definition in `packages/core/src/lib/items/types/widget.ts`
- [ ] Lifecycle in `default-lifecycles.ts` (`DEFAULT_ITEM_LIFECYCLES` + `DEFAULT_LIFECYCLE_LINKS`) and an ID in `lifecycle-ids.ts`
- [ ] RBAC resource in `packages/core/src/lib/items/item-type-resources.ts`, and the resource granted in `ROLE_DEFINITIONS` (`packages/core/src/lib/auth/permissions.ts`)
- [ ] Type handler in `type-handlers/`, imported from `type-handlers/init.ts`
- [ ] Numbering scheme in `packages/core/src/lib/items/numbering/schemes.ts`

Not pinned — forgetting one degrades quietly, so check them by hand:

- [ ] Detail-route path in `packages/core/src/lib/items/item-type-ui.ts` (without it, nothing can link to an item of the type)
- [ ] Icon name in that file's `ICONS_BY_NAME` (an unknown name silently renders a magnifying glass)
- [ ] Filterable/sortable columns in `ItemSearchService` (`typeSpecificColumns` and the two `typeColumnMaps`)
- [ ] If the type has no `designId`: an arm in `requireItemAccess` (`lib/auth/access.ts`) and an entry in `SELF_SCOPED_ITEM_TYPES` (`lib/db/filters.ts`) — **without these an item-level access check may not run at all**
- [ ] Import field config in `lib/import/field-configs/index.ts`, if the type should be importable
- [ ] Config row in `scripts/seed-minimal.ts`

Ordinary application work:

- [ ] Type-specific table in `packages/core/src/lib/db/schema/items.ts`, exported from `schema/index.ts`
- [ ] Migrations generated for **both** editions and committed
- [ ] API schemas in `packages/core/src/lib/api/schemas.ts` (at minimum an update schema — `itemUpdateSchemaFor` has a test that covers every type)
- [ ] API routes in `packages/core/src/server/routes/widgets.ts`, mounted in `server/index.ts`
- [ ] `npm run openapi:snapshot` and commit the result
- [ ] Client pages under `packages/core/src/routes/` and a navigation entry
- [ ] Form component
- [ ] Seed data (if needed for testing)

The AI chatbot and MCP tool schemas need **no changes**: `search_items` and
`create_item` derive their item-type coverage from `ITEM_TYPE_DEFINITIONS`
automatically, and per-type permission checks flow through the resource
mapping above. (`create_item` exposes per-type _fields_ for only a few types;
see its definition if the new type needs more than name and description.)

## Existing Item Types for Reference

| Type            | Table               | Schema File                 | Lifecycle                      |
| --------------- | ------------------- | --------------------------- | ------------------------------ |
| Part            | `parts`             | `types/part.ts`             | Driven (ECO-controlled)        |
| Document        | `documents`         | `types/document.ts`         | Driven                         |
| Requirement     | `requirements`      | `types/requirement.ts`      | Driven                         |
| Software        | `software`          | `types/software.ts`         | Driven (shares Part lifecycle) |
| ChangeOrder     | `change_orders`     | `types/change-order.ts`     | Driving (controls others)      |
| Task            | `tasks`             | `types/task.ts`             | Free (self-controlled)         |
| TestPlan        | `test_plans`        | `types/testplan.ts`         | Free                           |
| TestCase        | `test_cases`        | `types/testcase.ts`         | Free                           |
| Issue           | `issues`            | `types/issue.ts`            | Free                           |
| WorkInstruction | `work_instructions` | `types/work-instruction.ts` | Free                           |
| Tool            | `tools`             | `types/tool.ts`             | Free, non-versioned            |
| PhysicalPart    | `physical_parts`    | `types/physical-part.ts`    | Free, non-versioned            |
| WorkOrder       | `work_orders`       | `types/work-order.ts`       | Free, non-versioned            |

Item types are declared in core, in `ITEM_TYPE_DEFINITIONS` and the per-type
maps that feed off it. There is no second place they can come from.
