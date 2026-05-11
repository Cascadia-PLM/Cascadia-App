// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { CheckCircle2, Circle } from 'lucide-react'
import { STEP_ORDER, strings } from './strings'
import type { WizardStep } from './strings'
import type { SetupProgressState } from './hooks/useSetupStatus'
import { cn } from '@/lib/utils'

interface SetupSidebarProps {
  current: WizardStep
  progress: SetupProgressState
  onSelect: (step: WizardStep) => void
}

const stepKeys: Record<WizardStep, keyof SetupProgressState | null> = {
  org: 'orgInfo',
  users: 'users',
  ai: 'ai',
  programs: 'programs',
  summary: null,
}

export function SetupSidebar({
  current,
  progress,
  onSelect,
}: SetupSidebarProps) {
  return (
    <nav className="w-full md:w-72 shrink-0 border-r border-slate-200 dark:border-slate-800 p-6 bg-slate-50 dark:bg-slate-900">
      <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-4">
        Setup steps
      </h2>
      <ol className="space-y-1">
        {STEP_ORDER.map((step, index) => {
          const progressKey = stepKeys[step]
          const completed =
            progressKey !== null && progress[progressKey] === true
          const isActive = step === current
          return (
            <li key={step}>
              <button
                type="button"
                onClick={() => onSelect(step)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2 rounded text-left text-sm transition-colors',
                  isActive
                    ? 'bg-white dark:bg-slate-800 shadow-sm text-slate-900 dark:text-slate-100 font-medium'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-white/60 dark:hover:bg-slate-800/60',
                )}
              >
                {completed ? (
                  <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />
                ) : (
                  <Circle
                    className={cn(
                      'w-4 h-4 shrink-0',
                      isActive
                        ? 'text-slate-900 dark:text-slate-100'
                        : 'text-slate-400',
                    )}
                  />
                )}
                <span className="flex-1">
                  <span className="text-xs text-slate-500 dark:text-slate-400 mr-2">
                    {index + 1}.
                  </span>
                  {strings.steps[step].label}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
