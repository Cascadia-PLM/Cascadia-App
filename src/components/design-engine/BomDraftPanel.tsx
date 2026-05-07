/**
 * BomDraftPanel - Renders the BOM draft tree with editing capabilities
 */

import { useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Package,
  Sparkles,
} from 'lucide-react'
import { InterfaceIndicator } from './InterfaceIndicator'
import { RequirementsCoverage } from './RequirementsCoverage'
import type {
  BomDraft,
  BomNodeDraft,
  DesignSessionStage,
  RequirementDraft,
} from '@/lib/design-engine/types'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'

interface BomDraftPanelProps {
  bom: BomDraft | null
  currentStage: DesignSessionStage
  totalRequirements: number
  requirements: Array<RequirementDraft>
  onConfirm?: () => void
}

export function BomDraftPanel({
  bom,
  currentStage,
  totalRequirements,
  requirements,
  onConfirm,
}: BomDraftPanelProps) {
  const canConfirm = currentStage === 'bom_review' && bom !== null

  if (!bom) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          Bill of Materials
        </h3>
        <p className="text-xs text-slate-400 dark:text-slate-500 py-2">
          BOM structure will appear here during the BOM stage
        </p>
      </div>
    )
  }

  const hasErrors = bom.validationIssues.some((i) => i.severity === 'error')

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
        Bill of Materials
      </h3>

      {/* BOM Tree */}
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <div className="bg-slate-50 dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-400 flex">
          <span className="flex-1">Item</span>
          <span className="w-12 text-center">Qty</span>
          <span className="w-16 text-center">Type</span>
        </div>
        <BomNodeRow node={bom.rootAssembly} depth={0} />
      </div>

      {/* Validation issues */}
      {bom.validationIssues.length > 0 && (
        <div className="space-y-1">
          {bom.validationIssues.map((issue, i) => (
            <div
              key={i}
              className={cn(
                'text-xs px-2 py-1 rounded',
                issue.severity === 'error'
                  ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                  : issue.severity === 'warning'
                    ? 'bg-yellow-50 text-yellow-700 dark:bg-yellow-900/20 dark:text-yellow-400'
                    : 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400',
              )}
            >
              {issue.message}
            </div>
          ))}
        </div>
      )}

      {/* Requirements coverage */}
      <RequirementsCoverage
        coverage={bom.requirementsCoverage}
        uncoveredRequirements={bom.uncoveredRequirements}
        requirements={requirements}
        totalRequirements={totalRequirements}
      />

      {/* Confirm button */}
      {canConfirm && (
        <Button
          variant="default"
          onClick={onConfirm}
          className="w-full"
          disabled={hasErrors}
        >
          <Check className="h-4 w-4 mr-2" />
          Confirm BOM
        </Button>
      )}
    </div>
  )
}

// Recursive BOM node renderer
function BomNodeRow({ node, depth }: { node: BomNodeDraft; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2)
  const hasChildren = node.children.length > 0

  return (
    <>
      <div
        className={cn(
          'flex items-center px-3 py-1.5 text-sm border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50',
          depth === 0 && 'font-medium',
        )}
      >
        <div className="flex-1 flex items-center min-w-0">
          <div style={{ width: depth * 20 }} className="flex-shrink-0" />
          {hasChildren ? (
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded mr-1"
            >
              {expanded ? (
                <ChevronDown className="h-3 w-3 text-slate-400" />
              ) : (
                <ChevronRight className="h-3 w-3 text-slate-400" />
              )}
            </button>
          ) : (
            <div className="w-4 mr-1" />
          )}
          <Package className="h-3.5 w-3.5 text-slate-400 mr-1.5 flex-shrink-0" />
          <span className="truncate text-slate-800 dark:text-slate-200">
            {node.name}
          </span>
          {node.isNew && (
            <Badge
              variant="default"
              className="ml-1.5 text-[9px] px-1 py-0 bg-purple-500"
            >
              <Sparkles className="h-2 w-2 mr-0.5" />
              NEW
            </Badge>
          )}
          {node.parametricSpec && (
            <Badge
              variant="success"
              className="ml-1 text-[9px] px-1 py-0"
              title={`Parametric: ${node.parametricSpec.shapeTemplate}`}
            >
              {node.parametricSpec.shapeTemplate}
            </Badge>
          )}
          <InterfaceIndicator node={node} />
          {node.existingItemNumber && (
            <span className="ml-1.5 text-xs text-slate-400 font-mono">
              {node.existingItemNumber}
            </span>
          )}
        </div>
        <span className="w-12 text-center text-xs text-slate-600 dark:text-slate-400">
          {node.quantity}
        </span>
        <span className="w-16 text-center">
          {node.partType && (
            <Badge
              variant={
                {
                  Manufacture: 'default' as const,
                  Purchase: 'secondary' as const,
                  Software: 'success' as const,
                  Phantom: 'outline' as const,
                }[node.partType]
              }
              className="text-[10px] px-1.5 py-0"
            >
              {node.partType}
            </Badge>
          )}
        </span>
      </div>
      {expanded &&
        hasChildren &&
        node.children.map((child) => (
          <BomNodeRow key={child.tempId} node={child} depth={depth + 1} />
        ))}
    </>
  )
}
