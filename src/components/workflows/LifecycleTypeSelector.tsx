import { Info } from 'lucide-react'
import type { LifecycleType } from '@/lib/workflows/types'

interface LifecycleTypeSelectorProps {
  value: LifecycleType
  onChange: (type: LifecycleType) => void
  disabled?: boolean
}

const lifecycleTypeInfo: Record<
  LifecycleType,
  { label: string; description: string; examples: string }
> = {
  Free: {
    label: 'Free',
    description: 'Self-controlled with manual transitions',
    examples: 'Programs, Projects, Designs',
  },
  Driven: {
    label: 'Driven',
    description: 'Controlled by ECOs (states only, no transitions)',
    examples: 'Parts, Documents, Requirements',
  },
  Driving: {
    label: 'Driving',
    description: 'ECO-type that controls Driven lifecycles',
    examples: 'Change Orders (ECO, XCO, MCO)',
  },
}

export function LifecycleTypeSelector({
  value,
  onChange,
  disabled = false,
}: LifecycleTypeSelectorProps) {
  return (
    <div className="space-y-3">
      <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
        Lifecycle Type
      </label>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(Object.keys(lifecycleTypeInfo) as Array<LifecycleType>).map(
          (type) => {
            const info = lifecycleTypeInfo[type]
            const isSelected = value === type
            return (
              <button
                key={type}
                type="button"
                disabled={disabled}
                onClick={() => onChange(type)}
                className={`
                  p-4 rounded-lg border-2 text-left transition-all
                  ${
                    isSelected
                      ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-950/30'
                      : 'border-slate-300 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
                  }
                  ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                `}
              >
                <div className="font-medium text-slate-900 dark:text-white">
                  {info.label}
                </div>
                <div className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                  {info.description}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-500 mt-2 flex items-center gap-1">
                  <Info className="h-3 w-3" />
                  {info.examples}
                </div>
              </button>
            )
          },
        )}
      </div>
      {value === 'Driven' && (
        <div className="text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 p-3 rounded-lg">
          Driven lifecycles only define valid states. Transitions are handled
          automatically when ECOs move affected items between states.
        </div>
      )}
      {value === 'Driving' && (
        <div className="text-sm text-cyan-600 dark:text-cyan-400 bg-cyan-50 dark:bg-cyan-950/30 p-3 rounded-lg">
          Driving lifecycles can include &quot;Transition Driven Item&quot;
          actions on their transitions to move affected items to target states.
        </div>
      )}
    </div>
  )
}
