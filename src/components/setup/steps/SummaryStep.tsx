// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { CheckCircle2, Circle, Loader2, Wrench } from 'lucide-react'
import { strings } from '../strings'
import type { SetupProgressState } from '../hooks/useSetupStatus'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'

interface SummaryStepProps {
  progress: SetupProgressState
  onFinish: () => void
  finishing: boolean
}

const ITEMS: Array<{ key: keyof SetupProgressState; label: string }> = [
  { key: 'orgInfo', label: strings.steps.org.label },
  { key: 'users', label: strings.steps.users.label },
  { key: 'ai', label: strings.steps.ai.label },
  { key: 'programs', label: strings.steps.programs.label },
]

export function SummaryStep({
  progress,
  onFinish,
  finishing,
}: SummaryStepProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
          {strings.steps.summary.title}
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {strings.steps.summary.description}
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <ul className="space-y-3">
            {ITEMS.map((item) => {
              const done = progress[item.key] === true
              return (
                <li key={item.key} className="flex items-center gap-3">
                  {done ? (
                    <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
                  ) : (
                    <Circle className="w-5 h-5 text-slate-400" />
                  )}
                  <span className="text-sm text-slate-900 dark:text-slate-100">
                    {item.label}
                  </span>
                  <span className="text-xs text-slate-500 dark:text-slate-400 ml-auto">
                    {done ? 'Done' : 'Skipped'}
                  </span>
                </li>
              )
            })}
          </ul>
        </CardContent>
      </Card>

      <Card className="opacity-80">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Wrench className="w-5 h-5 text-slate-600 dark:text-slate-400" />
            <CardTitle className="text-base">
              {strings.toolsComingSoon.title}
            </CardTitle>
          </div>
          <CardDescription>
            {strings.toolsComingSoon.description}
          </CardDescription>
        </CardHeader>
      </Card>

      <div>
        <Button onClick={onFinish} disabled={finishing}>
          {finishing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          {finishing ? strings.actions.saving : strings.actions.finish}
        </Button>
      </div>
    </div>
  )
}
