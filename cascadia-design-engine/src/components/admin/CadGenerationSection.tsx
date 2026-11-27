// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { CadGenerationSettingsCard } from './CadGenerationSettingsCard'

/**
 * The CAD generation section of the admin AI settings page.
 *
 * Carries its own heading and description rather than letting core supply them,
 * so the whole section disappears on an instance without this package instead
 * of leaving an empty headed block behind.
 */
export function CadGenerationSection() {
  return (
    <div className="border-t border-slate-200 dark:border-slate-800 pt-8 mt-4">
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-slate-900 dark:text-white">
          CAD Generation
        </h2>
        <p className="text-slate-600 dark:text-slate-400 mt-1">
          AI-written FreeCAD scripts, run by the FreeCAD worker, for the
          collaborative design engine and the part &ldquo;Generate CAD&rdquo;
          action. Uses the AI provider configured above.
        </p>
      </div>
      <div className="space-y-6">
        <CadGenerationSettingsCard />
      </div>
    </div>
  )
}
