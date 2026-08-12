// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * All user-facing copy for the first-time setup wizard, kept in one
 * place so a future i18n pass is mechanical.
 */

export const strings = {
  pageTitle: 'Welcome to Cascadia',
  pageSubtitle:
    'A few quick steps will get your team set up. You can revisit this from Admin → Run setup wizard at any time.',

  steps: {
    org: {
      label: 'Organization',
      title: 'Tell us about your company',
      description:
        'These details show up in headers, exported reports, and audit logs.',
    },
    users: {
      label: 'Users',
      title: 'Invite your team',
      description:
        'Add the people who will work in Cascadia and assign their roles. You can always add more later from Admin → Users.',
    },
    ai: {
      label: 'AI providers',
      title: 'Connect an AI provider',
      description:
        'API keys power the chatbot, BOM drafting, and design engine. Keys are stored encrypted at rest. You can skip this and add keys later.',
    },
    programs: {
      label: 'Programs & data',
      title: 'Bootstrap your data',
      description:
        'Create your first program, design, and part — or load a sample standard catalog so you can see the system in action.',
    },
    tools: {
      label: 'Tools',
      title: 'Add your shop equipment',
      description:
        'Record the machines you build with — 3D printers, CNC mills, saws, welders, measurement gear. Their capabilities constrain what the design engine proposes. You can always add more later from Tools → Create Tool.',
    },
    summary: {
      label: 'Summary',
      title: "You're set up",
      description:
        'Everything below is editable from the admin pages or by re-running this wizard.',
    },
  },

  actions: {
    skipStep: 'Skip step',
    skipWizard: 'Skip wizard',
    back: 'Back',
    next: 'Next',
    finish: 'Finish setup',
    saving: 'Saving…',
    saved: 'Saved',
  },
} as const

export type WizardStep =
  'org' | 'users' | 'ai' | 'programs' | 'tools' | 'summary'

export const STEP_ORDER: ReadonlyArray<WizardStep> = [
  'org',
  'users',
  'ai',
  'programs',
  'tools',
  'summary',
]
