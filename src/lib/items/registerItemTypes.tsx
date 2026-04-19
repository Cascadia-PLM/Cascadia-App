/**
 * Client-Side Item Type Registration
 *
 * Registers all item types for client-side use (forms, tables, detail views).
 * Shared definitions come from item-type-definitions.ts; this file only
 * adds the real React components (or placeholders for types without them yet).
 */

import { ItemTypeRegistry } from './registry'
import { ITEM_TYPE_DEFINITIONS } from './item-type-definitions'
import { PartForm } from '@/components/parts/PartForm'
import { PartTable } from '@/components/parts/PartTable'
import { TaskForm } from '@/components/tasks/TaskForm'
import { TaskTable } from '@/components/tasks/TaskTable'
import { ChangeOrderForm, ChangeOrderTable } from '@/components/change-orders'
import { ToolForm } from '@/components/tools/ToolForm'
import { ToolTable } from '@/components/tools/ToolTable'

// Placeholder components for types without dedicated UI yet
const PlaceholderDetail = ({ item }: any) => (
  <div>{item?.itemNumber ?? 'Detail'}</div>
)
const PlaceholderForm = () => <div>Form not implemented</div>
const PlaceholderTable = () => <div>Table not implemented</div>

/** Real components for types that have them */
const clientComponents: Record<string, { form: any; table: any; detail: any }> =
  {
    Part: { form: PartForm, table: PartTable, detail: PlaceholderDetail },
    Task: { form: TaskForm, table: TaskTable, detail: PlaceholderDetail },
    ChangeOrder: {
      form: ChangeOrderForm,
      table: ChangeOrderTable,
      detail: PlaceholderDetail,
    },
    Tool: {
      form: ToolForm,
      table: ToolTable,
      detail: PlaceholderDetail,
    },
  }

const placeholder = {
  form: PlaceholderForm,
  table: PlaceholderTable,
  detail: PlaceholderDetail,
}

for (const def of Object.values(ITEM_TYPE_DEFINITIONS)) {
  ItemTypeRegistry.register({
    ...def,
    components: clientComponents[def.name] || placeholder,
  })
}
