import { X } from 'lucide-react'
import type { InstanceWorkflowState } from '@/lib/workflows/types'
import {
  Badge,
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

interface InstanceStatePropertiesPanelProps {
  state: InstanceWorkflowState
  isCurrent: boolean
  onUpdate: (state: InstanceWorkflowState) => void
  onClose: () => void
  readOnly?: boolean
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

export function InstanceStatePropertiesPanel({
  state,
  isCurrent,
  onUpdate,
  onClose,
  readOnly = false,
}: InstanceStatePropertiesPanelProps) {
  const handleChange = (updates: Partial<InstanceWorkflowState>) => {
    onUpdate({ ...state, ...updates })
  }

  return (
    <Card className="w-80 shadow-lg">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">State Properties</CardTitle>
            {isCurrent && (
              <Badge variant="default" className="text-xs">
                Current
              </Badge>
            )}
          </div>
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
            placeholder="e.g., Eng Review, Quality Review"
            disabled={readOnly || state.isInitial || state.isFinal}
          />
        </div>

        {/* Color */}
        <div className="space-y-1.5">
          <Label className="text-xs">Color</Label>
          <Select
            value={state.color || 'gray'}
            onValueChange={(value) => handleChange({ color: value })}
            disabled={readOnly}
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

        {/* Instructions */}
        <div className="space-y-1.5">
          <Label htmlFor="stateInstructions" className="text-xs">
            Instructions
          </Label>
          <textarea
            id="stateInstructions"
            value={state.instructions || ''}
            onChange={(e) => handleChange({ instructions: e.target.value })}
            className="w-full h-20 px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 resize-none disabled:opacity-50"
            placeholder="Instructions for reviewers at this step..."
            disabled={readOnly}
          />
        </div>

        {/* Final state toggle (only for non-initial states) */}
        {!state.isInitial && !readOnly && (
          <div className="space-y-2">
            <Label className="text-xs">State Type</Label>
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={state.isFinal || false}
                  onChange={(e) => handleChange({ isFinal: e.target.checked })}
                  className="rounded border-slate-300 dark:border-slate-600"
                  disabled={isCurrent}
                />
                <span className="text-sm text-slate-700 dark:text-slate-300">
                  Final State
                </span>
                <span className="text-xs text-slate-500">
                  (completes workflow)
                </span>
              </label>
            </div>
          </div>
        )}

        {/* Warning if current state */}
        {isCurrent && (
          <div className="p-2 bg-blue-50 dark:bg-blue-900/20 rounded-md">
            <p className="text-xs text-blue-700 dark:text-blue-300">
              This is the current state. It cannot be removed.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
