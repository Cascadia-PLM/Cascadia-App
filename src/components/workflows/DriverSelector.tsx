import { useEffect, useState } from 'react'
import { Check, Loader2, X } from 'lucide-react'
import type { WorkflowDefinition } from '@/lib/workflows/types'
import { Badge } from '@/components/ui/Badge'

interface DriverSelectorProps {
  selectedDriverIds: Array<string>
  onChange: (driverIds: Array<string>) => void
  disabled?: boolean
}

export function DriverSelector({
  selectedDriverIds,
  onChange,
  disabled = false,
}: DriverSelectorProps) {
  const [drivingLifecycles, setDrivingLifecycles] = useState<
    Array<WorkflowDefinition>
  >([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadDrivingLifecycles = async () => {
      try {
        // Load all workflows and filter for Driving type
        const response = await fetch('/api/workflows')
        if (response.ok) {
          const { data } = await response.json()
          const workflows = data?.workflows || []
          // Filter for Driving lifecycles (ECO workflows)
          const driving = workflows.filter(
            (w: WorkflowDefinition) =>
              w.lifecycleType === 'Driving' ||
              (w.definitionType === 'workflow' && !w.lifecycleType),
          )
          setDrivingLifecycles(driving)
        }
      } catch (error) {
        console.error('Error loading driving lifecycles:', error)
      } finally {
        setLoading(false)
      }
    }
    loadDrivingLifecycles()
  }, [])

  const toggleDriver = (driverId: string) => {
    if (disabled) return
    if (selectedDriverIds.includes(driverId)) {
      onChange(selectedDriverIds.filter((id) => id !== driverId))
    } else {
      onChange([...selectedDriverIds, driverId])
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-500 py-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading available drivers...</span>
      </div>
    )
  }

  if (drivingLifecycles.length === 0) {
    return (
      <div className="text-sm text-slate-500 dark:text-slate-400 py-4">
        No Driving lifecycles found. Create an ECO workflow first.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
        Allowed Drivers
      </label>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Select which ECO workflows can control items using this lifecycle.
        {selectedDriverIds.length === 0 && (
          <span className="block mt-1 text-amber-600 dark:text-amber-400">
            If none selected, any ECO can control items on this lifecycle.
          </span>
        )}
      </p>
      <div className="space-y-2">
        {drivingLifecycles.map((lifecycle) => {
          const isSelected = selectedDriverIds.includes(lifecycle.id)
          return (
            <button
              key={lifecycle.id}
              type="button"
              disabled={disabled}
              onClick={() => toggleDriver(lifecycle.id)}
              className={`
                w-full p-3 rounded-lg border text-left transition-all flex items-center justify-between
                ${
                  isSelected
                    ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-950/30'
                    : 'border-slate-300 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
                }
                ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              `}
            >
              <div>
                <div className="font-medium text-slate-900 dark:text-white">
                  {lifecycle.name}
                </div>
                {lifecycle.description && (
                  <div className="text-sm text-slate-500 dark:text-slate-400">
                    {lifecycle.description}
                  </div>
                )}
                {lifecycle.applicableItemTypes &&
                  lifecycle.applicableItemTypes.length > 0 && (
                    <div className="flex gap-1 mt-1">
                      {lifecycle.applicableItemTypes.map((type) => (
                        <Badge key={type} variant="outline">
                          {type}
                        </Badge>
                      ))}
                    </div>
                  )}
              </div>
              <div
                className={`
                h-5 w-5 rounded-full border-2 flex items-center justify-center
                ${
                  isSelected
                    ? 'border-cyan-500 bg-cyan-500 text-white'
                    : 'border-slate-300 dark:border-slate-600'
                }
              `}
              >
                {isSelected && <Check className="h-3 w-3" />}
              </div>
            </button>
          )
        })}
      </div>
      {selectedDriverIds.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedDriverIds.map((id) => {
            const lifecycle = drivingLifecycles.find((l) => l.id === id)
            return (
              <Badge key={id} variant="secondary" className="gap-1">
                {lifecycle?.name || id}
                <button
                  type="button"
                  onClick={() => toggleDriver(id)}
                  disabled={disabled}
                  className="hover:text-red-500"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )
          })}
        </div>
      )}
    </div>
  )
}
