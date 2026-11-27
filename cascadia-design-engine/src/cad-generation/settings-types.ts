// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Shared types for the AI CAD generation settings.
 *
 * This file is intentionally dependency-free (no db / node / fetch imports) so
 * it can be imported from both the client bundle and server code without
 * pulling server-only modules into the SPA build.
 *
 * There is no provider and no API key here. Generation is driven by the
 * instance's AI provider — the same one the chatbot and the design engine's
 * drafting stages resolve through `loadProviderConfig` — and the geometry is
 * built by the FreeCAD worker. What an administrator configures is whether
 * that pipeline runs at all, and how hard the agent may try per part.
 */

export interface CadGenerationConfig {
  /** Master switch for AI CAD generation (design engine stages + part dialog). */
  enabled: boolean
  /** FreeCAD script attempts the agent may make for one part. */
  maxIterations?: number
  /** Wall-clock budget for one FreeCAD script execution, in seconds. */
  scriptTimeoutSeconds?: number
}

/** `CadGenerationConfig` with every optional knob filled in and clamped. */
export interface ResolvedCadGenerationSettings {
  enabled: boolean
  maxIterations: number
  scriptTimeoutSeconds: number
}

/**
 * Enabled by default: nothing external has to be bought or configured for
 * generation to work beyond the AI provider the rest of the product already
 * needs, so an instance that composes this module gets the feature. The
 * hosted-demo provisioning writes an explicit `enabled: false`.
 */
export const CAD_GENERATION_DEFAULTS: ResolvedCadGenerationSettings = {
  enabled: true,
  maxIterations: 6,
  scriptTimeoutSeconds: 120,
}

/**
 * Bounds the admin form and the resolver both enforce. The script timeout
 * ceiling sits well under the `generation.cad.freecad` job timeout, so the
 * worker's watchdog never fires before the script's own deadline does.
 */
export const CAD_GENERATION_LIMITS = {
  maxIterations: { min: 1, max: 12 },
  scriptTimeoutSeconds: { min: 15, max: 300 },
} as const

function clampInt(
  value: unknown,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

/**
 * Apply defaults and limits to a stored config blob.
 *
 * Tolerates the shape this setting had before FreeCAD replaced the external
 * text-to-CAD provider — `{ provider, apiKey, enabled }` — by reading only
 * the field the two shapes share. An instance that had generation switched
 * off stays off; one that had it on stays on.
 */
export function resolveCadGenerationConfig(
  stored: Partial<CadGenerationConfig> | null | undefined,
): ResolvedCadGenerationSettings {
  return {
    enabled:
      typeof stored?.enabled === 'boolean'
        ? stored.enabled
        : CAD_GENERATION_DEFAULTS.enabled,
    maxIterations: clampInt(
      stored?.maxIterations,
      CAD_GENERATION_DEFAULTS.maxIterations,
      CAD_GENERATION_LIMITS.maxIterations,
    ),
    scriptTimeoutSeconds: clampInt(
      stored?.scriptTimeoutSeconds,
      CAD_GENERATION_DEFAULTS.scriptTimeoutSeconds,
      CAD_GENERATION_LIMITS.scriptTimeoutSeconds,
    ),
  }
}
