// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { ArrowLeft, ArrowRight } from 'lucide-react'
import { strings } from './strings'
import type { WizardStep } from './strings'
import { Button } from '@/components/ui'

interface SetupNavProps {
  current: WizardStep
  onBack?: () => void
  onNext?: () => void
  onSkipStep?: () => void
  canBack: boolean
  canNext: boolean
}

export function SetupNav({
  current,
  onBack,
  onNext,
  onSkipStep,
  canBack,
  canNext,
}: SetupNavProps) {
  if (current === 'summary') return null

  return (
    <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-800 pt-6">
      <Button
        variant="ghost"
        onClick={onSkipStep}
        disabled={!onSkipStep}
        size="sm"
      >
        {strings.actions.skipStep}
      </Button>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={!canBack}
          size="sm"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          {strings.actions.back}
        </Button>
        <Button onClick={onNext} disabled={!canNext} size="sm">
          {strings.actions.next}
          <ArrowRight className="w-4 h-4 ml-1" />
        </Button>
      </div>
    </div>
  )
}
