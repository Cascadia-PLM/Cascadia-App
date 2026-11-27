// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Server-side resolver for the AI CAD generation settings.
 *
 * A provider and an API key used to live here, mirroring the AI provider
 * resolver in `@/ai/adapters` as a second secret for a second vendor.
 * The FreeCAD pipeline has no vendor of its own: the model is whichever
 * provider `loadProviderConfig` resolves, and the geometry is built in-house
 * by the FreeCAD worker. What remains configurable is the `cad_generation`
 * blob in the `settings` table — the master switch and the agent's budget.
 */

import { resolveCadGenerationConfig } from './settings-types'
import type {
  CadGenerationConfig,
  ResolvedCadGenerationSettings,
} from './settings-types'
import { SettingsService } from '@/config/SettingsService'
import { SettingKeys } from '@/config/SettingKeys'

/** Read the stored CAD generation config blob as written. */
export async function loadCadGenerationConfig(): Promise<CadGenerationConfig | null> {
  return SettingsService.getJsonValue<CadGenerationConfig>(
    SettingKeys.CAD_GENERATION,
  )
}

/** The effective settings: stored values with defaults and limits applied. */
export async function resolveCadGenerationSettings(): Promise<ResolvedCadGenerationSettings> {
  return resolveCadGenerationConfig(await loadCadGenerationConfig())
}

/**
 * What a caller reports when the switch is off. One string, so the design
 * engine's per-part failures and the part dialog's 400 say the same thing.
 */
export const CAD_GENERATION_DISABLED_MESSAGE =
  'AI CAD generation is disabled for this instance. An administrator can enable it under Admin → AI Assistant → CAD Generation.'
