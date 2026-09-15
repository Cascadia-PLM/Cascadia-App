// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Runtime model discovery.
 *
 * All four providers expose a list-models endpoint, so the admin picker does
 * not have to ship a hand-maintained list of vendor model ids that goes stale
 * every few months. Each provider's response is normalised to `AiModelOption`.
 *
 * The three hosted providers differ in how much they hand back:
 *
 * - **Anthropic** — chat models only, already newest-first, with display names.
 *   Nothing to filter.
 * - **OpenAI** — every model the key can reach, including embeddings, audio,
 *   image and moderation families, with no capability metadata. Non-chat
 *   families have to be excluded by name.
 * - **Gemini** — everything, but each entry declares `supportedGenerationMethods`,
 *   so embeddings drop out structurally. Image/TTS variants still support
 *   `generateContent` and need excluding by name.
 *
 * Server-only: this module handles plaintext API keys and must never reach the
 * client bundle.
 */

import { DEFAULT_OLLAMA_BASE_URL } from './model-catalog'
import type { AiModelOption, AiProviderType } from './model-catalog'

const REQUEST_TIMEOUT_MS = 10_000

/**
 * Cap on paginated follow-up requests. Anthropic and Gemini both accept a
 * 1000-item page size, so one page is realistically always enough; this exists
 * so a misbehaving cursor cannot spin forever.
 */
const MAX_PAGES = 5

export interface ModelDiscoveryConfig {
  provider: AiProviderType
  apiKey?: string
  baseURL?: string
}

export interface ModelDiscoveryResult {
  models: Array<AiModelOption>
  /** Where the list came from, for display: 'Anthropic', 'Ollama', … */
  source: string
}

/** Thrown when the provider is reachable-but-unhappy, or unreachable. */
export class ModelDiscoveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelDiscoveryError'
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
  providerName: string,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (cause) {
    const err = cause as Error
    const detail =
      err.name === 'TimeoutError'
        ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : err.message
    throw new ModelDiscoveryError(
      `Could not reach ${providerName} to list models: ${detail}`,
    )
  }

  if (!response.ok) {
    // Vendors put the useful part in the body; a bare status tells the admin
    // nothing about whether the key is wrong, expired, or lacks a scope.
    const body = await response.text().catch(() => '')
    throw new ModelDiscoveryError(
      `${providerName} returned ${response.status} listing models${
        body ? `: ${body.slice(0, 300)}` : ''
      }`,
    )
  }

  return response.json()
}

/** Narrow an unknown JSON value to an array of records. */
function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null,
  )
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// ============================================
// Anthropic
// ============================================

/**
 * `GET /v1/models` — chat models only, ordered most-recently-released first,
 * cursor-paginated on `after_id`.
 */
async function listAnthropicModels(
  apiKey: string,
): Promise<Array<AiModelOption>> {
  const models: Array<AiModelOption> = []
  let afterId: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://api.anthropic.com/v1/models')
    url.searchParams.set('limit', '1000')
    if (afterId) url.searchParams.set('after_id', afterId)

    const json = (await fetchJson(
      url.toString(),
      {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      },
      'Anthropic',
    )) as {
      data?: unknown
      has_more?: unknown
      last_id?: unknown
    }

    for (const entry of asRecordArray(json.data)) {
      const id = asString(entry.id)
      if (!id) continue
      models.push({ id, label: asString(entry.display_name) ?? id })
    }

    const lastId = asString(json.last_id)
    if (json.has_more !== true || !lastId) break
    afterId = lastId
  }

  return models
}

// ============================================
// OpenAI
// ============================================

/**
 * Model families that are not chat completions. OpenAI's list endpoint returns
 * everything the key can reach with no capability metadata, so exclusion by
 * name is the only filter available.
 *
 * Excluding known non-chat families beats allow-listing `gpt-*`, because new
 * chat model names appear constantly while these families are stable — an
 * allow-list would silently hide next month's flagship.
 */
const OPENAI_NON_CHAT_PATTERNS = [
  'embedding',
  'tts',
  'whisper',
  'audio',
  'transcribe',
  'dall-e',
  'moderation',
  'image',
  'realtime',
  'sora',
  'davinci',
  'babbage',
  '-instruct', // legacy completions endpoint, not chat
]

function isOpenAiChatModel(id: string): boolean {
  const lower = id.toLowerCase()
  return !OPENAI_NON_CHAT_PATTERNS.some((pattern) => lower.includes(pattern))
}

/** `GET /v1/models` — unordered, unpaginated, everything the key can see. */
async function listOpenAiModels(
  apiKey: string,
  baseURL: string | undefined,
): Promise<Array<AiModelOption>> {
  const base = (baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '')

  const json = (await fetchJson(
    `${base}/models`,
    { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
    'OpenAI',
  )) as { data?: unknown }

  return asRecordArray(json.data)
    .flatMap((entry) => {
      const id = asString(entry.id)
      if (!id || !isOpenAiChatModel(id)) return []
      const created = typeof entry.created === 'number' ? entry.created : 0
      return [{ id, label: id, created }]
    })
    .sort((a, b) => b.created - a.created || a.id.localeCompare(b.id))
    .map(({ id, label }) => ({ id, label }))
}

// ============================================
// Gemini
// ============================================

/**
 * Models that support `generateContent` but are not text chat — image
 * generation, speech, and video variants all share the method.
 */
const GEMINI_NON_CHAT_PATTERNS = [
  'image',
  'tts',
  'veo',
  'imagen',
  'embedding',
  'aqa',
]

function isGeminiChatModel(id: string, methods: Array<string>): boolean {
  if (!methods.includes('generateContent')) return false
  const lower = id.toLowerCase()
  return !GEMINI_NON_CHAT_PATTERNS.some((pattern) => lower.includes(pattern))
}

/**
 * `GET /v1beta/models` — the native endpoint, not the OpenAI-compatible one at
 * `/v1beta/openai/models`. Both work, but the native shape carries
 * `supportedGenerationMethods` and display names; the compat shape is the
 * stripped OpenAI `{id, created}`.
 *
 * The key goes in the `x-goog-api-key` header rather than the documented `?key=`
 * query parameter, so it stays out of request logs and proxy access logs.
 */
async function listGeminiModels(apiKey: string): Promise<Array<AiModelOption>> {
  const models: Array<AiModelOption> = []
  let pageToken: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(
      'https://generativelanguage.googleapis.com/v1beta/models',
    )
    url.searchParams.set('pageSize', '1000')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const json = (await fetchJson(
      url.toString(),
      { method: 'GET', headers: { 'x-goog-api-key': apiKey } },
      'Gemini',
    )) as { models?: unknown; nextPageToken?: unknown }

    for (const entry of asRecordArray(json.models)) {
      // `name` is the resource path — `models/gemini-3.6-flash` — but the API
      // takes the bare id.
      const id = asString(entry.name)?.replace(/^models\//, '')
      if (!id) continue
      const methods = Array.isArray(entry.supportedGenerationMethods)
        ? entry.supportedGenerationMethods.filter(
            (m): m is string => typeof m === 'string',
          )
        : []
      if (!isGeminiChatModel(id, methods)) continue
      models.push({ id, label: asString(entry.displayName) ?? id })
    }

    const next = asString(json.nextPageToken)
    if (!next) break
    pageToken = next
  }

  return models
}

// ============================================
// Ollama
// ============================================

/**
 * `GET /api/tags` — what the operator has actually pulled locally. The
 * user-facing base URL may or may not carry the `/v1` the OpenAI-compatible
 * adapter needs, so strip it for the native endpoint (same handling as the
 * connection test in `src/server/routes/admin.ts`).
 */
async function listOllamaModels(
  baseURL: string | undefined,
): Promise<Array<AiModelOption>> {
  const raw = (baseURL || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '')
  const base = raw.endsWith('/v1') ? raw.slice(0, -3) : raw

  const json = (await fetchJson(
    `${base}/api/tags`,
    { method: 'GET' },
    `Ollama at ${base}`,
  )) as { models?: unknown }

  return asRecordArray(json.models).flatMap((entry) => {
    const id = asString(entry.name) ?? asString(entry.model)
    if (!id) return []
    // Tags are `name:tag`; `:latest` is noise in a picker but must stay in the
    // id, which is what gets sent to the API.
    return [{ id, label: id.replace(/:latest$/, '') }]
  })
}

// ============================================
// Entry point
// ============================================

const PROVIDER_DISPLAY_NAMES: Record<AiProviderType, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama',
}

/**
 * List the models the given credentials can actually reach.
 *
 * Throws `ModelDiscoveryError` when the provider is unreachable or rejects the
 * request; callers are expected to fall back to `FALLBACK_MODELS`.
 */
export async function listProviderModels(
  config: ModelDiscoveryConfig,
): Promise<ModelDiscoveryResult> {
  const source = PROVIDER_DISPLAY_NAMES[config.provider]

  // Handled first: it is the one provider that needs no credentials, and
  // returning here narrows `apiKey` to required for everything below.
  if (config.provider === 'ollama') {
    return { models: await listOllamaModels(config.baseURL), source }
  }

  const { apiKey } = config
  if (!apiKey) {
    throw new ModelDiscoveryError(
      `An API key is required to list ${source} models`,
    )
  }

  switch (config.provider) {
    case 'anthropic':
      return { models: await listAnthropicModels(apiKey), source }
    case 'openai':
      return { models: await listOpenAiModels(apiKey, config.baseURL), source }
    case 'gemini':
      return { models: await listGeminiModels(apiKey), source }
  }
}
