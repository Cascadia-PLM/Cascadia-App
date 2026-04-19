/**
 * InterfaceIndicator - Badge showing interface count per BOM node
 */

import { Link2 } from 'lucide-react'
import type { BomNodeDraft } from '@/lib/design-engine/types'
import { Badge } from '@/components/ui/Badge'

interface InterfaceIndicatorProps {
  node: BomNodeDraft
}

export function InterfaceIndicator({ node }: InterfaceIndicatorProps) {
  const interfaceCount = node.interfaces?.length ?? 0
  const mappingCount = node.interfaceMappings?.length ?? 0
  const hasChildren = node.children.length > 0

  if (interfaceCount === 0 && mappingCount === 0) return null

  return (
    <Badge
      variant="outline"
      className="ml-1 text-[9px] px-1 py-0 gap-0.5 text-blue-600 border-blue-300 dark:text-blue-400 dark:border-blue-700"
      title={
        hasChildren
          ? `${mappingCount} interface mapping(s)`
          : `${interfaceCount} interface(s)`
      }
    >
      <Link2 className="h-2 w-2" />
      {hasChildren ? mappingCount : interfaceCount}
    </Badge>
  )
}
