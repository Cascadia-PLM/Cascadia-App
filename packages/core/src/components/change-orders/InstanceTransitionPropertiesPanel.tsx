// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Trash2, X } from 'lucide-react'
import type { InstanceWorkflowTransition } from '@/lib/workflows/types'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@/components/ui'

interface InstanceTransitionPropertiesPanelProps {
  transition: InstanceWorkflowTransition
  onUpdate: (transition: InstanceWorkflowTransition) => void
  onDelete: (transitionId: string) => void
  onClose: () => void
  readOnly?: boolean
}

export function InstanceTransitionPropertiesPanel({
  transition,
  onUpdate,
  onDelete,
  onClose,
  readOnly = false,
}: InstanceTransitionPropertiesPanelProps) {
  const handleChange = (updates: Partial<InstanceWorkflowTransition>) => {
    onUpdate({ ...transition, ...updates })
  }

  return (
    <Card className="w-80 shadow-lg">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Transition Properties</CardTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-6 w-6"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Transition Name */}
        <div className="space-y-1.5">
          <Label htmlFor="transitionName" className="text-xs">
            Name
          </Label>
          <Input
            id="transitionName"
            value={transition.name}
            onChange={(e) => handleChange({ name: e.target.value })}
            className="h-8 text-sm"
            placeholder="e.g., Submit for Review"
            disabled={readOnly}
          />
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <Label htmlFor="transitionDescription" className="text-xs">
            Description
          </Label>
          <textarea
            id="transitionDescription"
            value={transition.description || ''}
            onChange={(e) => handleChange({ description: e.target.value })}
            className="w-full h-16 px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 resize-none disabled:opacity-50"
            placeholder="What happens when this transition is taken?"
            disabled={readOnly}
          />
        </div>

        {/* Minimum approvals (WI-4.2) — enforced by the server: the
            transition is blocked until this many distinct users have an
            active approved vote at the source state. Composes with any
            named approvers configured on the source state. */}
        <div className="space-y-1.5">
          <Label htmlFor="requiredApprovals" className="text-xs">
            Minimum approvals to leave source state
          </Label>
          <Input
            id="requiredApprovals"
            type="number"
            min={0}
            value={transition.approvalRequirement?.requiredCount ?? 0}
            onChange={(e) => {
              const count = Math.max(
                0,
                Number.parseInt(e.target.value, 10) || 0,
              )
              handleChange({
                approvalRequirement:
                  count > 0 ? { requiredCount: count } : undefined,
              })
            }}
            className="h-8 text-sm"
            disabled={readOnly}
          />
          <p className="text-xs text-slate-500">
            0 disables the count gate. Named approvers on the source state are
            checked in addition, and each must approve before the workflow can
            move on.
          </p>
        </div>

        {/* Info about instance-level limitations */}
        <div className="p-2 bg-slate-50 dark:bg-slate-800 rounded-md">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Ad-hoc transitions cannot carry guards or actions. Approvals are
            enforced through the minimum above and the approvers configured on
            the source state.
          </p>
        </div>

        {/* Delete button */}
        {!readOnly && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => onDelete(transition.id)}
            className="w-full"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete Transition
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
