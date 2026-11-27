// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { CadGenerationSection } from '@/components/admin/CadGenerationSection'
import { DesignSessionsNavItem } from '@/components/design-engine/DesignSessionsNavItem'
import { PartCadActions } from '@/components/parts/PartCadActions'
import { registerDesignEngineResources } from '@/query/design-engine-resources'
import { registerSlot } from '@/ui/slot-registry'

let done = false

/**
 * Attach design-engine's client-side contributions to core.
 *
 * This module's own UI is whole routes, composed by the app's Vite config
 * rather than injected into core's screens — so the only slot it fills is the
 * sidebar entry that reaches them, which has to come from the side that owns
 * the route. The rest is cache resources, registered before anything can
 * invalidate them.
 */
export function registerDesignEngineClient(): void {
  if (done) return
  done = true

  registerDesignEngineResources()
  registerSlot('designs-nav-items', DesignSessionsNavItem)
}

let cadDone = false

/** Attach the CAD-generation UI to core. Idempotent; call before first render. */
export function registerCadGenerationClient(): void {
  if (cadDone) return
  cadDone = true

  registerSlot('admin-ai-settings-sections', CadGenerationSection)
  registerSlot('part-detail-actions', PartCadActions)
}

/** Reset the once-guard. Tests only. */
export function resetDesignEngineClientRegistration(): void {
  done = false
}

/** Reset the CAD once-guard. Tests only. */
export function resetCadGenerationClientRegistration(): void {
  cadDone = false
}
