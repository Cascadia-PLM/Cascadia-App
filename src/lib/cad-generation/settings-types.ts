// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Shared types for CAD generation provider settings.
 *
 * This file is intentionally dependency-free (no db / node / fetch imports) so
 * it can be imported from both the client bundle and server code without
 * pulling server-only modules into the SPA build.
 *
 * Zoo (zoo.dev) is the only Text-to-CAD provider today; the `provider` field
 * exists so additional vendors can be added later without a schema change.
 */

export type CadProvider = 'zoo'

export interface CadGenerationConfig {
  provider: CadProvider
  /** Encrypted at rest when ENCRYPTION_KEY is set; plaintext otherwise. */
  apiKey?: string
  enabled: boolean
}

export const CAD_PROVIDERS: Record<CadProvider, string> = {
  zoo: 'Zoo (zoo.dev)',
}

export const CAD_PROVIDER_KEYS = Object.keys(
  CAD_PROVIDERS,
) as Array<CadProvider>
