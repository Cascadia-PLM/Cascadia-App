import { X } from 'lucide-react'
import { RevisionSchemeSelector } from './RevisionSchemeSelector'
import type {
  LifecyclePhaseConfig,
  RevisionScheme,
} from '@/lib/types/lifecycle'
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

interface PhasePropertiesPanelProps {
  phase: LifecyclePhaseConfig
  onUpdate: (phase: LifecyclePhaseConfig) => void
  onDelete: (phaseId: string) => void
  onClose: () => void
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

export function PhasePropertiesPanel({
  phase,
  onUpdate,
  onDelete,
  onClose,
}: PhasePropertiesPanelProps) {
  const handleChange = (updates: Partial<LifecyclePhaseConfig>) => {
    onUpdate({ ...phase, ...updates })
  }

  return (
    <Card className="w-80 shadow-lg">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Phase Properties</CardTitle>
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
        {/* Phase Name */}
        <div className="space-y-1.5">
          <Label htmlFor="phaseName" className="text-xs">
            Name
          </Label>
          <Input
            id="phaseName"
            value={phase.name}
            onChange={(e) => handleChange({ name: e.target.value })}
            className="h-8 text-sm"
            placeholder="e.g., Prototype, Production"
          />
        </div>

        {/* Color */}
        <div className="space-y-1.5">
          <Label className="text-xs">Color</Label>
          <Select
            value={phase.color || 'gray'}
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

        {/* Order */}
        <div className="space-y-1.5">
          <Label htmlFor="phaseOrder" className="text-xs">
            Order
          </Label>
          <Input
            id="phaseOrder"
            type="number"
            value={phase.order}
            onChange={(e) =>
              handleChange({ order: parseInt(e.target.value) || 0 })
            }
            className="h-8 text-sm"
            min={0}
          />
        </div>

        {/* Revision Scheme */}
        <RevisionSchemeSelector
          value={phase.revisionScheme}
          onChange={(scheme: RevisionScheme) =>
            handleChange({ revisionScheme: scheme })
          }
        />

        {/* Reset Revision on Entry */}
        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={phase.resetRevisionOnEntry || false}
              onChange={(e) =>
                handleChange({ resetRevisionOnEntry: e.target.checked })
              }
              className="rounded border-slate-300 dark:border-slate-600"
            />
            <span className="text-sm text-slate-700 dark:text-slate-300">
              Reset revision on entry
            </span>
          </label>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            When items enter this phase, their revision starts over
          </p>
        </div>

        {/* Delete Phase */}
        <div className="pt-2 border-t">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="w-full"
            onClick={() => onDelete(phase.id)}
          >
            Delete Phase
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
