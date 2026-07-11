/**
 * BomDraftPanel - Renders the BOM draft tree with optional inline editing.
 *
 * During `bom_drafting` and `bom_review`, users can edit a node's core fields
 * (name, quantity, partType, material), delete a node (its children are
 * re-parented to its parent), and add a new child under any node.
 */

import { useState } from 'react'
import {
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Package,
  Pencil,
  Plus,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react'
import { InterfaceIndicator } from './InterfaceIndicator'
import { RequirementsCoverage } from './RequirementsCoverage'
import { ReviewStatusChip } from './RequirementsPanel'
import type {
  BomDraft,
  BomNodeDraft,
  BomRejectionEntry,
  DesignSessionStage,
  RequirementDraft,
  ReviewStatus,
} from '@/lib/design-engine/types'
import { effectiveReviewStatus } from '@/lib/design-engine/types'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'
import { cn } from '@/lib/utils'

const PART_TYPES: ReadonlyArray<NonNullable<BomNodeDraft['partType']>> = [
  'Manufacture',
  'Purchase',
  'Software',
  'Phantom',
]

interface BomDraftPanelProps {
  bom: BomDraft | null
  currentStage: DesignSessionStage
  totalRequirements: number
  requirements: Array<RequirementDraft>
  bomRejections?: Array<BomRejectionEntry>
  onConfirm?: (options?: { force?: boolean }) => void
  onUpdateNode?: (tempId: string, patch: Partial<BomNodeDraft>) => void
  onRejectNode?: (tempId: string, reason?: string) => void
  onSetNodeReviewStatus?: (tempId: string, status: ReviewStatus) => void
  onAcceptAllNodes?: () => void
  onAddChild?: (parentTempId: string, data: Partial<BomNodeDraft>) => void
}

function countUnresolvedNodes(bom: BomDraft): number {
  let count = 0
  const walk = (node: BomNodeDraft, isRoot: boolean) => {
    if (!isRoot && effectiveReviewStatus(node) === 'proposed') count++
    for (const child of node.children) walk(child, false)
  }
  walk(bom.rootAssembly, true)
  return count
}

export function BomDraftPanel({
  bom,
  currentStage,
  totalRequirements,
  requirements,
  bomRejections,
  onConfirm,
  onUpdateNode,
  onRejectNode,
  onSetNodeReviewStatus,
  onAcceptAllNodes,
  onAddChild,
}: BomDraftPanelProps) {
  const [showRejected, setShowRejected] = useState(false)
  const canConfirm = currentStage === 'bom_review' && bom !== null
  const canEdit =
    currentStage === 'bom_review' || currentStage === 'bom_drafting'

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
  const rootTempId = bom.rootAssembly.tempId
  const unresolvedCount = countUnresolvedNodes(bom)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          Bill of Materials
        </h3>
        {canEdit && unresolvedCount > 0 && onAcceptAllNodes && (
          <Button
            variant="outline"
            size="sm"
            onClick={onAcceptAllNodes}
            className="h-7 text-xs gap-1"
            title="Accept all unreviewed BOM items"
          >
            <CheckCheck className="h-3 w-3" />
            Accept all
          </Button>
        )}
      </div>

      {/* BOM Tree */}
      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
        <div className="bg-slate-50 dark:bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-400 flex">
          <span className="flex-1">Item</span>
          <span className="w-12 text-center">Qty</span>
          <span className="w-16 text-center">Type</span>
          {canEdit && <span className="w-28 text-right" />}
        </div>
        <BomNodeRow
          node={bom.rootAssembly}
          depth={0}
          rootTempId={rootTempId}
          canEdit={canEdit && (!!onUpdateNode || !!onRejectNode || !!onAddChild)}
          onUpdateNode={onUpdateNode}
          onRejectNode={onRejectNode}
          onSetNodeReviewStatus={onSetNodeReviewStatus}
          onAddChild={onAddChild}
        />
      </div>

      {/* Rejected parts (tombstones fed back to the AI) */}
      {bomRejections && bomRejections.length > 0 && (
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg">
          <button
            onClick={() => setShowRejected(!showRejected)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800/50"
          >
            {showRejected ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Rejected parts ({bomRejections.length})
          </button>
          {showRejected && (
            <div className="px-3 pb-2 space-y-1">
              {bomRejections.map((r) => (
                <div
                  key={`${r.tempId}-${r.rejectedAt}`}
                  className="text-xs text-slate-500 dark:text-slate-400"
                >
                  <span className="line-through">{r.name}</span>
                  {r.partType && (
                    <span className="ml-1.5 text-slate-400">
                      [{r.partType}]
                    </span>
                  )}
                  {r.reason && (
                    <span className="ml-1.5 text-red-500 dark:text-red-400">
                      — {r.reason}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
        <div className="space-y-1.5">
          <Button
            variant="default"
            onClick={() => onConfirm?.()}
            className="w-full"
            disabled={hasErrors || unresolvedCount > 0}
            title={
              unresolvedCount > 0
                ? 'Accept, edit, or reject every proposed item to confirm'
                : undefined
            }
          >
            <Check className="h-4 w-4 mr-2" />
            {unresolvedCount > 0
              ? `Confirm BOM (${unresolvedCount} unreviewed)`
              : 'Confirm BOM'}
          </Button>
          {unresolvedCount > 0 && !hasErrors && (
            <Button
              variant="ghost"
              onClick={() => onConfirm?.({ force: true })}
              className="w-full text-xs text-slate-500 dark:text-slate-400"
            >
              Confirm anyway — skip per-item review
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

interface BomNodeRowProps {
  node: BomNodeDraft
  depth: number
  rootTempId: string
  canEdit: boolean
  onUpdateNode?: (tempId: string, patch: Partial<BomNodeDraft>) => void
  onRejectNode?: (tempId: string, reason?: string) => void
  onSetNodeReviewStatus?: (tempId: string, status: ReviewStatus) => void
  onAddChild?: (parentTempId: string, data: Partial<BomNodeDraft>) => void
}

function BomNodeRow({
  node,
  depth,
  rootTempId,
  canEdit,
  onUpdateNode,
  onRejectNode,
  onSetNodeReviewStatus,
  onAddChild,
}: BomNodeRowProps) {
  const [expanded, setExpanded] = useState(depth < 2)
  const [editing, setEditing] = useState(false)
  const [addingChild, setAddingChild] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const hasChildren = node.children.length > 0
  const isRoot = node.tempId === rootTempId
  const reviewStatus = effectiveReviewStatus(node)

  const submitReject = () => {
    onRejectNode?.(node.tempId, rejectReason.trim() || undefined)
    setRejecting(false)
    setRejectReason('')
  }

  if (editing) {
    return (
      <BomNodeEditRow
        node={node}
        depth={depth}
        onSave={(patch) => {
          onUpdateNode?.(node.tempId, patch)
          setEditing(false)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <>
      <div
        className={cn(
          'group flex items-center px-3 py-1.5 text-sm border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50',
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
          {!isRoot && (
            <span className="ml-1.5">
              <ReviewStatusChip status={reviewStatus} />
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
        {canEdit && (
          <span className="w-28 flex justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {onSetNodeReviewStatus && !isRoot && reviewStatus === 'proposed' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSetNodeReviewStatus(node.tempId, 'accepted')}
                className="h-6 w-6 p-0 text-green-600 hover:text-green-700"
                title="Accept"
              >
                <Check className="h-3 w-3" />
              </Button>
            )}
            {onAddChild && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAddingChild(true)
                  setExpanded(true)
                }}
                className="h-6 w-6 p-0"
                title="Add child"
              >
                <Plus className="h-3 w-3" />
              </Button>
            )}
            {onUpdateNode && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
                className="h-6 w-6 p-0"
                title="Edit"
              >
                <Pencil className="h-3 w-3" />
              </Button>
            )}
            {onRejectNode && !isRoot && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRejecting(true)}
                className="h-6 w-6 p-0 text-red-500 hover:text-red-700"
                title="Reject (removes the part; the AI is told not to re-propose it)"
              >
                <XCircle className="h-3 w-3" />
              </Button>
            )}
          </span>
        )}
      </div>
      {rejecting && (
        <div
          className="flex items-center gap-1.5 px-3 py-1.5 border-t border-dashed border-red-200 dark:border-red-900 bg-red-50/40 dark:bg-red-900/10"
          style={{ paddingLeft: 12 + depth * 20 }}
        >
          <Input
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            className="text-xs h-7 flex-1"
            placeholder={`Why reject "${node.name}"? (optional — the AI learns from it)`}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitReject()
              if (e.key === 'Escape') setRejecting(false)
            }}
          />
          <Button
            variant="default"
            size="sm"
            onClick={submitReject}
            className="h-7 text-xs"
          >
            Reject
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRejecting(false)}
            className="h-7 w-7 p-0"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
      {expanded &&
        hasChildren &&
        node.children.map((child) => (
          <BomNodeRow
            key={child.tempId}
            node={child}
            depth={depth + 1}
            rootTempId={rootTempId}
            canEdit={canEdit}
            onUpdateNode={onUpdateNode}
            onRejectNode={onRejectNode}
            onSetNodeReviewStatus={onSetNodeReviewStatus}
            onAddChild={onAddChild}
          />
        ))}
      {addingChild && onAddChild && (
        <BomNodeEditRow
          depth={depth + 1}
          onSave={(data) => {
            onAddChild(node.tempId, data)
            setAddingChild(false)
          }}
          onCancel={() => setAddingChild(false)}
        />
      )}
    </>
  )
}

interface BomNodeEditRowProps {
  node?: BomNodeDraft
  depth: number
  onSave: (data: Partial<BomNodeDraft>) => void
  onCancel: () => void
}

function BomNodeEditRow({ node, depth, onSave, onCancel }: BomNodeEditRowProps) {
  const [name, setName] = useState(node?.name ?? '')
  const [quantity, setQuantity] = useState(String(node?.quantity ?? 1))
  const [partType, setPartType] = useState<NonNullable<BomNodeDraft['partType']>>(
    node?.partType ?? 'Manufacture',
  )
  const [material, setMaterial] = useState(node?.material ?? '')

  const save = () => {
    if (!name.trim()) return
    const qty = Number(quantity)
    onSave({
      name: name.trim(),
      quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
      partType,
      material: material.trim() || undefined,
    })
  }

  return (
    <div
      className={cn(
        'flex items-start gap-2 px-3 py-2 border-t border-dashed border-cyan-300 dark:border-cyan-700 bg-cyan-50/40 dark:bg-cyan-900/10',
      )}
    >
      <div style={{ width: depth * 20 }} className="flex-shrink-0" />
      <div className="flex-1 grid grid-cols-[2fr_60px_110px_1fr_auto] gap-1.5 items-center">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          className="h-7 text-xs"
          autoFocus
        />
        <Input
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          placeholder="Qty"
          className="h-7 text-xs"
        />
        <Select
          value={partType}
          onValueChange={(v) =>
            setPartType(v as NonNullable<BomNodeDraft['partType']>)
          }
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PART_TYPES.map((t) => (
              <SelectItem key={t} value={t} className="text-xs">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={material}
          onChange={(e) => setMaterial(e.target.value)}
          placeholder="Material (optional)"
          className="h-7 text-xs"
        />
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={save}
            className="h-7 w-7 p-0"
            disabled={!name.trim()}
          >
            <Check className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="h-7 w-7 p-0"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  )
}
