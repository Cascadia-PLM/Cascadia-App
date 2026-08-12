// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Static provider/model catalog.
 *
 * This is the **fallback**, not the source of truth. Every provider we support
 * exposes a list-models endpoint (see `model-discovery.ts`) and the admin UI
 * populates its picker from that at runtime. This catalog covers the cases
 * discovery cannot: no API key entered yet (the setup wizard), the provider
 * being unreachable, or an air-gapped deployment.
 *
 * Because it is a fallback it *will* drift — a hand-maintained list of vendor
 * model ids always does. Prefer discovery; treat a stale entry here as a
 * cosmetic bug, not a broken feature.
 *
 * Deliberately free of server imports (no `db`, no drizzle) so the SPA bundle
 * can import it directly. `ProviderType` in `@/lib/db/schema/ai` is the same
 * union; it is redeclared here rather than imported to keep that boundary.
 */

export const AI_PROVIDERS = ['openai', 'anthropic', 'gemini', 'ollama'] as const

export type AiProviderType = (typeof AI_PROVIDERS)[number]

export function isAiProviderType(value: unknown): value is AiProviderType {
  return (
    typeof value === 'string' &&
    (AI_PROVIDERS as ReadonlyArray<string>).includes(value)
  )
}

export const PROVIDER_LABELS: Record<AiProviderType, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  ollama: 'Ollama (local)',
}

/**
 * A model as offered to the user, from discovery or from the fallback list.
 * `label` is the vendor's human-readable name where one is available and the
 * raw id otherwise.
 */
export interface AiModelOption {
  id: string
  label: string
}

/**
 * Fallback model ids, most-capable first. Verified against vendor docs on
 * 2026-08-05. Retired ids are removed rather than kept for compatibility —
 * offering a model that 404s is worse than offering a shorter list.
 */
export const FALLBACK_MODELS: Record<AiProviderType, Array<string>> = {
  openai: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
  anthropic: [
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-haiku-4-5',
  ],
  gemini: [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
  ],
  // Ollama runs whatever the operator has pulled, so this list is a guess about
  // someone else's disk. Discovery via /api/tags is the real answer here.
  ollama: ['llama3.3', 'qwen2.5', 'qwen2.5-coder', 'mistral'],
}

/**
 * Model selected when a provider is first chosen. Deliberately the balanced
 * mid-tier rather than `FALLBACK_MODELS[provider][0]` — the picker leads with
 * the most capable model, but nobody should land on the most expensive one by
 * accident.
 */
export const DEFAULT_MODEL: Record<AiProviderType, string> = {
  openai: 'gpt-5.6-terra',
  anthropic: 'claude-sonnet-5',
  gemini: 'gemini-3.6-flash',
  ollama: 'llama3.3',
}

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'

/** Fallback list shaped as picker options. */
export function fallbackModelOptions(
  provider: AiProviderType,
): Array<AiModelOption> {
  return FALLBACK_MODELS[provider].map((id) => ({ id, label: id }))
}
