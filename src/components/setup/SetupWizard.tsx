// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { useEffect, useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, X } from 'lucide-react'
import cascadiaLogo from '/cascadia-plm-logo-icon.svg'
import { SetupSidebar } from './SetupSidebar'
import { SetupNav } from './SetupNav'
import { OrgInfoStep } from './steps/OrgInfoStep'
import { UsersStep } from './steps/UsersStep'
import { AiKeysStep } from './steps/AiKeysStep'
import { ProgramsStep } from './steps/ProgramsStep'
import { SummaryStep } from './steps/SummaryStep'
import { useSetupStatus } from './hooks/useSetupStatus'
import {
  nextStep as computeNextStep,
  previousStep as computePreviousStep,
  firstIncompleteStep,
  useCompleteSetup,
  useSetProgress,
} from './hooks/useSetupProgress'
import { strings } from './strings'
import type { SetupProgressState } from './hooks/useSetupStatus'
import type { WizardStep } from './strings'
import { Button } from '@/components/ui'

interface SetupWizardProps {
  step: WizardStep
}

export function SetupWizard({ step }: SetupWizardProps) {
  const navigate = useNavigate()
  const statusQuery = useSetupStatus()
  const setProgress = useSetProgress()
  const completeSetup = useCompleteSetup()

  const progress: SetupProgressState = useMemo(
    () =>
      statusQuery.data?.progress ?? {
        orgInfo: false,
        users: false,
        ai: false,
        programs: false,
        dismissedAt: null,
      },
    [statusQuery.data?.progress],
  )

  // If the URL says ?step=org but the user has already completed it, leave
  // them there — they may be re-running the wizard. But if no step was
  // requested explicitly and the wizard is freshly opened, jump to the
  // first incomplete step. The route handler also picks an initial step
  // when none is provided.
  useEffect(() => {
    // Effect intentionally left blank — initial step selection happens
    // in the route's beforeLoad (see src/routes/setup.tsx).
  }, [])

  const goTo = (next: WizardStep) => {
    void navigate({
      to: '/setup',
      search: { step: next },
      replace: true,
    })
  }

  const markStepCompleted = async (key: keyof SetupProgressState) => {
    if (key === 'dismissedAt') return
    if (progress[key]) return
    const updated: SetupProgressState = { ...progress, [key]: true }
    try {
      await setProgress.mutateAsync(updated)
    } catch {
      // Persistence failed — allow advancing anyway, the wizard is
      // resumable via the same flag on next mount.
    }
  }

  const advanceFrom = async (current: WizardStep) => {
    const map: Record<WizardStep, keyof SetupProgressState | null> = {
      org: 'orgInfo',
      users: 'users',
      ai: 'ai',
      programs: 'programs',
      summary: null,
    }
    const key = map[current]
    if (key) await markStepCompleted(key)
    goTo(computeNextStep(current))
  }

  const handleSkipStep = () => {
    goTo(computeNextStep(step))
  }

  const handleBack = () => {
    goTo(computePreviousStep(step))
  }

  const handleNext = () => {
    void advanceFrom(step)
  }

  const handleSkipWizard = async () => {
    try {
      await completeSetup.mutateAsync('skip')
    } catch {
      // Ignore — at worst the redirect re-fires next session.
    }
    void navigate({ to: '/' })
  }

  const handleFinish = async () => {
    try {
      await completeSetup.mutateAsync('finish')
    } catch {
      // Ignore — at worst the redirect re-fires next session.
    }
    void navigate({ to: '/' })
  }

  if (statusQuery.isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-slate-500" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-white dark:bg-slate-950 flex flex-col">
      <header className="border-b border-slate-200 dark:border-slate-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src={cascadiaLogo} alt="Cascadia" className="h-7 w-7" />
          <div>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white">
              {strings.pageTitle}
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {strings.pageSubtitle}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSkipWizard}
          disabled={completeSetup.isPending}
        >
          <X className="w-4 h-4 mr-1" />
          {strings.actions.skipWizard}
        </Button>
      </header>

      <div className="flex flex-col md:flex-row flex-1">
        <SetupSidebar
          current={step}
          progress={progress}
          onSelect={(s) => goTo(s)}
        />

        <main className="flex-1 p-6 md:p-10 max-w-5xl space-y-8">
          {step === 'org' && (
            <OrgInfoStep onCompleted={() => void advanceFrom('org')} />
          )}
          {step === 'users' && (
            <UsersStep onCompleted={() => void advanceFrom('users')} />
          )}
          {step === 'ai' && (
            <AiKeysStep onCompleted={() => void advanceFrom('ai')} />
          )}
          {step === 'programs' && (
            <ProgramsStep onCompleted={() => void advanceFrom('programs')} />
          )}
          {step === 'summary' && (
            <SummaryStep
              progress={progress}
              onFinish={() => void handleFinish()}
              finishing={completeSetup.isPending}
            />
          )}

          <SetupNav
            current={step}
            onBack={handleBack}
            onNext={handleNext}
            onSkipStep={handleSkipStep}
            canBack={step !== 'org'}
            canNext={step !== 'summary'}
          />
        </main>
      </div>
    </div>
  )
}

export { firstIncompleteStep }
