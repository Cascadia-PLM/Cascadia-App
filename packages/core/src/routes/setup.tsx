// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute, useSearch } from '@tanstack/react-router'
import { z } from 'zod'
import { SetupWizard } from '@/components/setup/SetupWizard'

const searchSchema = z.object({
  step: z
    .enum(['org', 'users', 'ai', 'programs', 'tools', 'summary'])
    .optional(),
})

export const Route = createFileRoute('/setup')({
  validateSearch: searchSchema,
  component: SetupRoute,
})

function SetupRoute() {
  const search = useSearch({ from: '/setup' })
  const step = search.step ?? 'org'
  return <SetupWizard step={step} />
}
