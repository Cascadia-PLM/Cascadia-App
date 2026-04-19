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

        {/* Approval Requirement */}
        <div className="space-y-2">
          <Label className="text-xs">Approval Requirement</Label>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!transition.approvalRequirement}
              onChange={(e) => {
                if (e.target.checked) {
                  handleChange({
                    approvalRequirement: { requiredCount: 1 },
                  })
                } else {
                  handleChange({
                    approvalRequirement: undefined,
                  })
                }
              }}
              className="rounded border-slate-300 dark:border-slate-600"
              disabled={readOnly}
            />
            <span className="text-sm text-slate-700 dark:text-slate-300">
              Require approvals
            </span>
          </div>

          {transition.approvalRequirement && (
            <div className="ml-6 space-y-2">
              <div className="flex items-center gap-2">
                <Label className="text-xs">Required count:</Label>
                <Input
                  type="number"
                  min={1}
                  value={transition.approvalRequirement.requiredCount}
                  onChange={(e) =>
                    handleChange({
                      approvalRequirement: {
                        ...transition.approvalRequirement!,
                        requiredCount: parseInt(e.target.value) || 1,
                      },
                    })
                  }
                  className="h-7 w-20 text-sm"
                  disabled={readOnly}
                />
              </div>
              <p className="text-xs text-slate-500">
                Number of approvals needed before this transition can be taken
              </p>
            </div>
          )}
        </div>

        {/* Info about instance-level limitations */}
        <div className="p-2 bg-slate-50 dark:bg-slate-800 rounded-md">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Instance-level transitions support approval requirements only. For
            guards and actions, use workflow definitions.
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
