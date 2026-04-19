import type { KnownToolSubtype } from '@/lib/items/types/tool'
import { Badge } from '@/components/ui'
import { TOOL_SUBTYPES } from '@/lib/items/types/tool'

interface ToolRow {
  id?: string
  itemNumber?: string
  name?: string
  toolType?: string
  toolSubtype?: string
  manufacturer?: string
  model?: string
  toolStatus?: string
  location?: string
}

interface ToolTableProps {
  items: Array<ToolRow>
  onSelect?: (item: ToolRow) => void
}

const STATUS_COLORS: Record<string, string> = {
  available: 'bg-green-500/10 text-green-400 border-green-500/20',
  in_use: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  maintenance: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  retired: 'bg-red-500/10 text-red-400 border-red-500/20',
}

function subtypeLabel(subtype?: string): string {
  if (!subtype) return ''
  const known = TOOL_SUBTYPES[subtype as KnownToolSubtype]
  return known?.label ?? subtype
}

export function ToolTable({ items, onSelect }: ToolTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
            <th className="px-3 py-2">Item Number</th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Subtype</th>
            <th className="px-3 py-2">Manufacturer</th>
            <th className="px-3 py-2">Model</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Location</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              className="cursor-pointer border-b border-zinc-800/50 hover:bg-zinc-800/30"
              onClick={() => onSelect?.(item)}
            >
              <td className="px-3 py-2 font-mono text-xs text-cyan-400">
                {item.itemNumber}
              </td>
              <td className="px-3 py-2">{item.name}</td>
              <td className="px-3 py-2 text-zinc-400">
                {subtypeLabel(item.toolSubtype)}
              </td>
              <td className="px-3 py-2 text-zinc-400">{item.manufacturer}</td>
              <td className="px-3 py-2 text-zinc-400">{item.model}</td>
              <td className="px-3 py-2">
                {item.toolStatus && (
                  <Badge
                    variant="outline"
                    className={STATUS_COLORS[item.toolStatus] ?? ''}
                  >
                    {item.toolStatus}
                  </Badge>
                )}
              </td>
              <td className="px-3 py-2 text-zinc-500">{item.location}</td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-zinc-500">
                No tools found
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
