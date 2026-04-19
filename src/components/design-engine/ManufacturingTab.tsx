/**
 * ManufacturingTab - Persistent panel showing session toolset and tool utilization
 *
 * Visible during toolset_review and all subsequent stages.
 * Shows manufacturing scope, tools, utilization (after BOM), and outsourced operations.
 */

import { AlertTriangle, Check, ExternalLink, Wrench } from 'lucide-react'
import type {
  BomDraft,
  BomNodeDraft,
  DesignSessionStage,
  DesignSessionToolset,
} from '@/lib/design-engine/types'
import type { KnownToolSubtype } from '@/lib/items/types/tool'
import { Badge, Button } from '@/components/ui'
import { TOOL_SUBTYPES } from '@/lib/items/types/tool'

interface ManufacturingTabProps {
  toolset?: DesignSessionToolset
  bom?: BomDraft | null
  currentStage: DesignSessionStage
  onConfirmToolset?: () => void
}

const SCOPE_LABELS: Record<string, { label: string; color: string }> = {
  in_house_only: {
    label: 'In-house only',
    color: 'bg-green-500/10 text-green-400 border-green-500/20',
  },
  in_house_preferred: {
    label: 'In-house preferred',
    color: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  },
  unconstrained: {
    label: 'Unconstrained',
    color: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  },
}

const SOURCE_LABELS: Record<string, string> = {
  prompt_detected: 'Auto-detected',
  user_selected: 'Selected',
  user_freeform: 'User-added',
}

function subtypeLabel(subtype: string): string {
  const known = TOOL_SUBTYPES[subtype as KnownToolSubtype]
  return known?.label ?? subtype
}

function formatCapabilities(caps: Record<string, unknown>): string {
  const highlights: Array<string> = []

  if (caps.buildVolume && Array.isArray(caps.buildVolume)) {
    highlights.push(`${(caps.buildVolume as Array<number>).join('x')}mm`)
  }
  if (caps.workVolume && Array.isArray(caps.workVolume)) {
    highlights.push(`${(caps.workVolume as Array<number>).join('x')}mm`)
  }
  if (caps.bedSize && Array.isArray(caps.bedSize)) {
    highlights.push(`${(caps.bedSize as Array<number>).join('x')}mm bed`)
  }
  if (caps.compatibleMaterials && Array.isArray(caps.compatibleMaterials)) {
    highlights.push(
      (caps.compatibleMaterials as Array<string>).slice(0, 3).join(', '),
    )
  }
  if (caps.axes) highlights.push(`${caps.axes}-axis`)

  return highlights.join(' | ')
}

/** Collect tool utilization from BOM tree */
function collectToolUtilization(bom: BomDraft): {
  utilization: Map<string, Array<string>>
  outsourced: Array<{ name: string; notes?: string }>
  unassigned: Array<string>
} {
  const utilization = new Map<string, Array<string>>()
  const outsourced: Array<{ name: string; notes?: string }> = []
  const unassigned: Array<string> = []

  function walk(node: BomNodeDraft) {
    if (node.partType === 'Manufacture' && node.isNew) {
      if (node.assignedToolId) {
        const parts = utilization.get(node.assignedToolId) ?? []
        parts.push(node.name)
        utilization.set(node.assignedToolId, parts)
      } else if (node.manufacturingConstraints?.outsourced) {
        outsourced.push({
          name: node.name,
          notes: node.manufacturingConstraints.outsourceNotes,
        })
      } else {
        unassigned.push(node.name)
      }
    }
    for (const child of node.children) {
      walk(child)
    }
  }

  walk(bom.rootAssembly)
  return { utilization, outsourced, unassigned }
}

export function ManufacturingTab({
  toolset,
  bom,
  currentStage,
  onConfirmToolset,
}: ManufacturingTabProps) {
  if (!toolset) {
    return (
      <div className="flex items-center justify-center p-8 text-sm text-zinc-500">
        No manufacturing toolset established
      </div>
    )
  }

  const scopeInfo = SCOPE_LABELS[toolset.scope] ?? SCOPE_LABELS.unconstrained
  const showConfirm = currentStage === 'toolset_review' && onConfirmToolset
  const showUtilization = bom != null

  const utilData = bom ? collectToolUtilization(bom) : null

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-zinc-400" />
          <h3 className="text-sm font-medium">Manufacturing Toolset</h3>
        </div>
        <Badge variant="outline" className={scopeInfo.color}>
          {scopeInfo.label}
        </Badge>
      </div>

      {/* Session Tools */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-zinc-500 uppercase">
          Tools ({toolset.tools.length})
        </p>
        {toolset.tools.map((tool) => {
          const caps = formatCapabilities(tool.capabilities)
          const partCount = utilData?.utilization.get(tool.id)?.length ?? 0

          return (
            <div
              key={tool.id}
              className="rounded-md border border-zinc-800 bg-zinc-900/50 p-3"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{tool.name}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {subtypeLabel(tool.toolSubtype)}
                  </Badge>
                </div>
                <span className="text-[10px] text-zinc-500">
                  {SOURCE_LABELS[tool.source] ?? tool.source}
                </span>
              </div>
              {caps && <p className="mt-1 text-xs text-zinc-400">{caps}</p>}
              {tool.toolItemNumber && (
                <p className="mt-0.5 text-[10px] text-cyan-400 font-mono">
                  {tool.toolItemNumber}
                </p>
              )}
              {showUtilization && partCount > 0 && (
                <p className="mt-1 text-[10px] text-green-400">
                  <Check className="mr-1 inline h-3 w-3" />
                  Assigned to {partCount} part{partCount !== 1 ? 's' : ''}
                </p>
              )}
            </div>
          )
        })}

        {toolset.tools.length === 0 && (
          <p className="text-xs text-zinc-500 italic">No tools in session</p>
        )}
      </div>

      {/* Tool Utilization (after BOM) */}
      {showUtilization && utilData && (
        <>
          {utilData.outsourced.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-yellow-500 uppercase flex items-center gap-1">
                <ExternalLink className="h-3 w-3" />
                Outsourced ({utilData.outsourced.length})
              </p>
              {utilData.outsourced.map((item, i) => (
                <div
                  key={i}
                  className="rounded border border-yellow-500/20 bg-yellow-500/5 p-2 text-xs"
                >
                  <span className="font-medium">{item.name}</span>
                  {item.notes && (
                    <p className="mt-0.5 text-zinc-400">{item.notes}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {utilData.unassigned.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-orange-400 uppercase flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Unassigned ({utilData.unassigned.length})
              </p>
              {utilData.unassigned.map((name, i) => (
                <p key={i} className="text-xs text-zinc-400 pl-4">
                  {name}
                </p>
              ))}
            </div>
          )}
        </>
      )}

      {/* Confirm button (during toolset_review) */}
      {showConfirm && (
        <Button onClick={onConfirmToolset} className="w-full" size="sm">
          Confirm Toolset & Continue
        </Button>
      )}
    </div>
  )
}
