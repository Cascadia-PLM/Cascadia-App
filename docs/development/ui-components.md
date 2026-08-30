# UI Component Patterns

This guide covers the UI component conventions, base primitives, and common patterns used in Cascadia's React frontend.

## Technology Stack

- **Styling**: Tailwind CSS 4
- **Primitives**: Radix UI (accessible, unstyled components)
- **Forms**: TanStack Form + Zod validation
- **Tables**: TanStack Table (via DataGrid wrapper)
- **Icons**: Lucide React

## Base Components

Base UI primitives live in `packages/core/src/components/ui/`. These are low-level building blocks used throughout the application.

### Available Components

| Component        | File                 | Description                   |
| ---------------- | -------------------- | ----------------------------- |
| `Button`         | `Button.tsx`         | Standard button with variants |
| `Input`          | `Input.tsx`          | Text input field              |
| `Textarea`       | `Textarea.tsx`       | Multi-line text input         |
| `Select`         | `Select.tsx`         | Dropdown select (Radix)       |
| `Checkbox`       | `Checkbox.tsx`       | Checkbox (Radix)              |
| `Switch`         | `Switch.tsx`         | Toggle switch (Radix)         |
| `RadioGroup`     | `RadioGroup.tsx`     | Radio button group (Radix)    |
| `Label`          | `Label.tsx`          | Form label (Radix)            |
| `FormField`      | `FormField.tsx`      | Label + input + error wrapper |
| `Card`           | `Card.tsx`           | Content card container        |
| `Badge`          | `Badge.tsx`          | Status/label badges           |
| `Dialog`         | `Dialog.tsx`         | Modal dialog (Radix)          |
| `AlertDialog`    | `AlertDialog.tsx`    | Confirmation dialog (Radix)   |
| `Popover`        | `Popover.tsx`        | Floating popover (Radix)      |
| `Tooltip`        | `Tooltip.tsx`        | Hover tooltip (Radix)         |
| `DropdownMenu`   | `DropdownMenu.tsx`   | Dropdown menu (Radix)         |
| `ContextMenu`    | `ContextMenu.tsx`    | Right-click menu (Radix)      |
| `Tabs`           | `Tabs.tsx`           | Tab navigation (Radix)        |
| `Table`          | `Table.tsx`          | Raw HTML table primitives     |
| `DataGrid`       | `DataGrid.tsx`       | Full-featured data table      |
| `Skeleton`       | `Skeleton.tsx`       | Loading skeleton              |
| `LoadingSpinner` | `LoadingSpinner.tsx` | Spinner animation             |
| `Progress`       | `Progress.tsx`       | Progress bar (Radix)          |
| `Avatar`         | `Avatar.tsx`         | User avatar (Radix)           |

### Import Pattern

Import from the component file directly:

```typescript
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { FormField } from '@/components/ui/FormField'
import { Card, CardHeader, CardContent } from '@/components/ui/Card'
```

Or from the barrel export:

```typescript
import { Button, Input, Card } from '@/components/ui'
```

## The cn() Utility

Use `cn()` from `@/lib/utils` to merge class names. It wraps `clsx` for conditional and composable class strings:

```typescript
import { cn } from '@/lib/utils'

function MyComponent({ className, isActive }: Props) {
  return (
    <div className={cn(
      'rounded-lg border p-4',        // Base classes
      isActive && 'border-blue-500',    // Conditional class
      className,                        // Allow overrides from parent
    )}>
      ...
    </div>
  )
}
```

## FormField Component

`FormField` wraps a form control with a label, error message, and help text. It automatically handles accessibility attributes (`aria-invalid`, `aria-describedby`, `aria-required`):

```typescript
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'

<FormField label="Part Number" required error={errors.partNumber}>
  <Input
    value={value}
    onChange={(e) => setValue(e.target.value)}
  />
</FormField>
```

## Forms with TanStack Form + Zod

### The zodValidator Wrapper

Zod v4 does not implement `StandardSchemaV1` which TanStack Form expects. Use the `zodValidator()` wrapper from `packages/core/src/lib/form-validation.ts`:

```typescript
import { useForm } from '@tanstack/react-form'
import { zodValidator } from '@/lib/form-validation'
import { partCreateSchema } from '@/lib/api/schemas'

function PartForm({ onSubmit }: Props) {
  const form = useForm({
    defaultValues: {
      itemNumber: '',
      name: '',
      description: '',
      partType: '',
    },
    validators: {
      onSubmit: zodValidator(partCreateSchema),
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
              onBlur={field.handleBlur}
            />
          </FormField>
        )}
      </form.Field>

      <Button type="submit" disabled={form.state.isSubmitting}>
        Save
      </Button>
    </form>
  )
}
```

### Getting Field Error Messages

Errors are strings, not objects. Cast them directly:

```typescript
// CORRECT
error={field.state.meta.errors?.[0] as string | undefined}

// WRONG — .message does not exist
error={field.state.meta.errors?.[0]?.message}
```

### Accessing Form State with useStore

`form.useStore()` does not exist. Import `useStore` and pass `form.store`:

```typescript
import { useForm, useStore } from '@tanstack/react-form'

const form = useForm({ ... })

// CORRECT — import useStore and pass form.store
const partType = useStore(form.store, (state) => state.values.partType)

// WRONG — form.useStore() does not exist
const partType = form.useStore((state) => state.values.partType)
```

### Helper Functions

`packages/core/src/lib/form-validation.ts` exports additional helpers:

```typescript
import { zodValidator, getFieldError, hasErrors } from '@/lib/form-validation'

// Get error for a specific field from the error array
const nameError = getFieldError(form.state.errors, 'name')

// Check if there are any validation errors
if (hasErrors(form.state.errors)) {
  // Show error summary
}
```

## DataGrid Component

`DataGrid` in `packages/core/src/components/ui/DataGrid.tsx` wraps TanStack Table with sorting, filtering, pagination, global search, row expansion, and context menus.

### Basic Usage

```typescript
import { DataGrid } from '@/components/ui/DataGrid'
import type { DataGridColumn } from '@/components/ui/DataGrid'

interface Part {
  id: string
  itemNumber: string
  name: string
  state: string
}

const columns: Array<DataGridColumn<Part>> = [
  {
    id: 'itemNumber',
    header: 'Item Number',
    accessorKey: 'itemNumber',
    enableSorting: true,
    meta: { width: '150px' },
  },
  {
    id: 'name',
    header: 'Name',
    accessorKey: 'name',
    enableSorting: true,
    meta: { width: '250px' },
  },
  {
    id: 'state',
    header: 'State',
    accessorKey: 'state',
    enableFiltering: true,
    filterType: 'select',
    filterOptions: [
      { label: 'Draft', value: 'Draft' },
      { label: 'Released', value: 'Released' },
    ],
  },
  {
    id: 'actions',
    header: '',
    cell: ({ row }) => (
      <Button size="sm" onClick={() => navigate(`/parts/${row.original.id}`)}>
        View
      </Button>
    ),
    meta: { width: '80px' },
  },
]

<DataGrid
  data={parts}
  columns={columns}
  getRowId={(row) => row.id}
  enablePagination
  enableSorting
  enableGlobalFilter
/>
```

### Column Configuration

The `DataGridColumn` interface:

```typescript
interface DataGridColumn<T> {
  id: string
  header: string
  accessorKey?: keyof T | string // Simple field access
  accessorFn?: (row: T) => unknown // Custom accessor
  cell?: (props) => ReactNode // Custom cell renderer
  enableSorting?: boolean
  enableFiltering?: boolean
  enableEditing?: boolean
  filterType?: 'text' | 'select' | 'multiselect' | 'range' | 'date'
  filterOptions?: Array<{ label: string; value: string }>
  filterPlaceholder?: string
  meta?: {
    align?: 'left' | 'center' | 'right'
    width?: string // CSS width value, e.g., '150px', '20%'
  }
}
```

Column widths use `meta.width` as an inline style, not `size`/`minSize`/`maxSize`.

### DataGrid Features

| Feature           | Prop                 | Description                  |
| ----------------- | -------------------- | ---------------------------- |
| Pagination        | `enablePagination`   | Client-side page controls    |
| Server pagination | `serverPagination`   | Server-side with total count |
| Sorting           | `enableSorting`      | Column header sort           |
| Global filter     | `enableGlobalFilter` | Full-text search bar         |
| Column filter     | `enableFiltering`    | Per-column filter popover    |
| Row expansion     | `enableHierarchy`    | Expandable rows (tree/BOM)   |
| Row actions       | `enableRowActions`   | Context menu on rows         |
| Row click         | `onRowClick`         | Navigate on row click        |

### Controlled State

For URL-persisted state, pass controlled props:

```typescript
const [sorting, setSorting] = useState<SortingState>([])
const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 })

<DataGrid
  data={parts}
  columns={columns}
  sorting={sorting}
  onSortingChange={setSorting}
  pagination={pagination}
  onPaginationChange={setPagination}
  enablePagination
  enableSorting
/>
```

## Shared Type Definitions

Export types from one source and import elsewhere. Do not duplicate interfaces:

```typescript
// CORRECT — single source of truth
// In DesignPhaseIndicator.tsx
export interface DesignStatus { ... }

// In other files
import { type DesignStatus } from '@/components/versioning/DesignPhaseIndicator'

// WRONG — duplicating types
// In FormA.tsx
interface DesignStatus { ... }
// In FormB.tsx
interface DesignStatus { ... }  // Can drift
```

## Common Patterns

### Loading States

```typescript
import { Skeleton } from '@/components/ui/Skeleton'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'

// Skeleton for layout placeholders
<Skeleton className="h-8 w-48" />

// Spinner for async operations
<LoadingSpinner size="sm" />
```

### Confirmation Dialogs

```typescript
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/AlertDialog'

<AlertDialog>
  <AlertDialogTrigger asChild>
    <Button variant="destructive">Delete</Button>
  </AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete Part?</AlertDialogTitle>
      <AlertDialogDescription>
        This action cannot be undone.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

### Lifecycle State Badges

State names and colours are lifecycle configuration, so components never map them in code:

```typescript
import { StateBadge } from '@/components/items/StateBadge'

<StateBadge itemType="Part" state={part.state} />
```

`StateBadge` resolves the configured display name and colour through the per-item-type lifecycle cache. For raw spans (graph nodes), `useLifecycleState(itemType, state)` returns `{ label, className }`. `FreeTransitionControl` renders the transitions a Free-lifecycle item may take from its current state; `LifecycleStateCards` draws a list page's per-state summary cards; `useReleasedFamily(itemType, state)` answers "is this released lineage" for presentation gates (the server's `ItemEditPolicy` remains the authority); `lifecycleByItemTypeQuery` is the loader-safe query behind all of them.

## Component size, and refactor-on-touch

**New components target ~400 lines at review.** Not a lint rule — a number to
notice. Past it, ask what the file is doing twice.

A file over the line is not automatically wrong, but it needs a **named seam**:
a sentence in its header comment saying where it would split and why it has not
yet. "It is big" is not a plan; "the CAD viewer state and the field cards are
independent, split there when either grows" is.

**Touching a large file means splitting what you touch.** A PR that adds a
feature to a 1,500-line component extracts the region it is working in — not
the whole file. This is how the big ones come down: `PartDetail.tsx` went from
1,833 lines to under 1,000 by extracting the four things that were independent
of each other, and each extraction was legible on its own.

Seams worth looking for, in the order they usually pay:

1. **State with no other reader.** A dozen `useState`s that only one region
   consumes is a hook, not a component's business. Extracting the _state_
   rather than only the markup is what stops the split turning into twelve
   props down and twelve setters back up — see
   `components/parts/useCADViewerState.ts`.
2. **A mode the rest of the file does not have.** Create-only, edit-only,
   admin-only branches are usually a component the caller renders conditionally.
3. **A region with its own data.** If a block owns a query nothing else reads,
   it can own that query somewhere else. Two components reading the same query
   factory share one request — that is the layer working as designed, not a
   duplicate fetch. See
   [data-fetching.md](./data-fetching.md).
4. **Repeated field groups.** A card of `ViewEdit*` fields with its own option
   constants is a component and its constants, together.

The same rule covers mutations: a PR that rewrites a mutation handler moves it
to `useResourceMutation` (see [data-fetching.md](./data-fetching.md)). Both are
convention enforced by review, not by lint — the exceptions are too legitimate
and too varied to reach zero warnings.

## Common Pitfalls

### Zod v4 + TanStack Form

Always use `zodValidator()` wrapper. Passing a Zod schema directly does not work:

```typescript
// WRONG
validators: {
  onSubmit: myZodSchema
}

// CORRECT
validators: {
  onSubmit: zodValidator(myZodSchema)
}
```

### Error Access

Errors are strings, not objects with `.message`:

```typescript
// WRONG
error={field.state.meta.errors?.[0]?.message}

// CORRECT
error={field.state.meta.errors?.[0] as string | undefined}
```

### useStore

`form.useStore()` does not exist:

```typescript
// WRONG
const value = form.useStore((state) => state.values.fieldName)

// CORRECT
import { useStore } from '@tanstack/react-form'
const value = useStore(form.store, (state) => state.values.fieldName)
```

### Server-Only Imports in Client Code

Importing database modules in client code causes build failures. Keep database imports in `routes/api/`, services, and `*.server.ts` files only. Use `import type` when you only need the type.

### API Response Structure

API responses are wrapped in `{ data: { ... } }`. When consuming from the client:

```typescript
// CORRECT
const response = await fetch('/api/v1/parts')
const json = await response.json()
const parts = json.data?.items ?? []

// WRONG — skipping the data wrapper
const parts = json.items // undefined
```
