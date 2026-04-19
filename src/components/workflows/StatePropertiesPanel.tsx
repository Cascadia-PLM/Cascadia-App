import { X } from 'lucide-react'
import { StateApproversPanel } from './StateApproversPanel'
import type { WorkflowState } from '@/lib/workflows/types'
import type { LifecyclePhaseConfig } from '@/lib/types/lifecycle'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

interface StatePropertiesPanelProps {
  state: WorkflowState
  onUpdate: (state: WorkflowState) => void
  onClose: () => void
  /** Workflow definition ID - required for managing approvers */
  workflowDefinitionId?: string
  /** Available lifecycle phases to assign to this state */
  phases?: Array<LifecyclePhaseConfig>
}

const colorOptions = [
  { value: 'gray', label: 'Gray', class: 'bg-slate-400' },
  { value: 'blue', label: 'Blue', class: 'bg-blue-400' },
  { value: 'green', label: 'Green', class: 'bg-green-400' },
  { value: 'yellow', label: 'Yellow', class: 'bg-yellow-400' },
  { value: 'orange', label: 'Orange', class: 'bg-orange-400' },
  { value: 'red', label: 'Red', class: 'bg-red-400' },
  { value: 'purple', label: 'Purple', class: 'bg-purple-400' },
  { value: 'cyan', label: 'Cyan', class: 'bg-cyan-400' },
]

export function StatePropertiesPanel({
  state,
  onUpdate,
  onClose,
  workflowDefinitionId,
  phases,
}: StatePropertiesPanelProps) {
  // Helper to update state and immediately propagate changes
  const handleChange = (updates: Partial<WorkflowState>) => {
    onUpdate({ ...state, ...updates })
  }

  return (
    <Card className="w-80 shadow-lg">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">State Properties</CardTitle>
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
        {/* State ID (readonly) */}
        <div className="space-y-1.5">
          <Label htmlFor="stateId" className="text-xs">
            State ID
          </Label>
          <Input
            id="stateId"
            value={state.id}
            disabled
            className="h-8 text-sm bg-slate-50 dark:bg-slate-900"
          />
        </div>

        {/* State Name */}
        <div className="space-y-1.5">
          <Label htmlFor="stateName" className="text-xs">
            Name
          </Label>
          <Input
            id="stateName"
            value={state.name}
            onChange={(e) => handleChange({ name: e.target.value })}
            className="h-8 text-sm"
            placeholder="e.g., Draft, Released"
          />
        </div>

        {/* Color */}
        <div className="space-y-1.5">
          <Label className="text-xs">Color</Label>
          <Select
            value={state.color || 'gray'}
            onValueChange={(value) => handleChange({ color: value })}
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {colorOptions.map((color) => (
                <SelectItem key={color.value} value={color.value}>
                  <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full ${color.class}`} />
                    {color.label}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Phase */}
        {phases && phases.length > 0 && (
          <div className="space-y-1.5">
            <Label className="text-xs">Phase</Label>
            <Select
              value={state.phaseId || '__unassigned__'}
              onValueChange={(value) =>
                handleChange({
                  phaseId: value === '__unassigned__' ? undefined : value,
                })
              }
            >
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unassigned__">Unassigned</SelectItem>
                {phases.map((phase) => (
                  <SelectItem key={phase.id} value={phase.id}>
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-2 h-2 rounded-full bg-${phase.color || 'slate'}-400`}
                      />
                      {phase.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Description */}
        <div className="space-y-1.5">
          <Label htmlFor="stateDescription" className="text-xs">
            Description
          </Label>
          <textarea
            id="stateDescription"
            value={state.description || ''}
            onChange={(e) => handleChange({ description: e.target.value })}
            className="w-full h-20 px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 resize-none"
            placeholder="What does this state represent?"
          />
        </div>

        {/* State Type Flags */}
        <div className="space-y-2">
          <Label className="text-xs">State Type</Label>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={state.isInitial || false}
                onChange={(e) =>
                  handleChange({
                    isInitial: e.target.checked,
                    // Can't be both initial and final
                    isFinal: e.target.checked ? false : state.isFinal,
                  })
                }
                className="rounded border-slate-300 dark:border-slate-600"
              />
              <span className="text-sm text-slate-700 dark:text-slate-300">
                Initial State
              </span>
              <span className="text-xs text-slate-500">
                (workflow starts here)
              </span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={state.isFinal || false}
                onChange={(e) =>
                  handleChange({
                    isFinal: e.target.checked,
                    // Can't be both initial and final
                    isInitial: e.target.checked ? false : state.isInitial,
                  })
                }
                className="rounded border-slate-300 dark:border-slate-600"
              />
              <span className="text-sm text-slate-700 dark:text-slate-300">
                Final State
              </span>
              <span className="text-xs text-slate-500">
                (workflow ends here)
              </span>
            </label>
          </div>
        </div>

        {/* Approvers Section - only shown when editing an existing workflow */}
        {workflowDefinitionId && (
          <div className="border-t pt-4">
            <StateApproversPanel
              workflowDefinitionId={workflowDefinitionId}
              stateId={state.id}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
