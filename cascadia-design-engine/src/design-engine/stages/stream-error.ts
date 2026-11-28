// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Provider adapters do not throw when the AI API rejects a request. The
 * failure is caught inside the adapter and the stream ends on a terminal
 * `RUN_ERROR` event instead. A stage loop that only inspects text and tool
 * events therefore sees an empty stream and concludes the model chose to say
 * nothing — turning a 400 into a silently empty artifact.
 *
 * Every stage that consumes a chat stream must inspect each chunk with
 * `streamChunkError` and act on the result.
 */

/** Cutoff at the token cap. Partial work is still valid, so this is not fatal. */
export const MAX_TOKENS_CODE = 'max_tokens'

export interface StreamChunkError {
  message: string
  code?: string
  /** A truncated response still carries usable output; a rejected request does not. */
  fatal: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined
}

/**
 * Read a `RUN_ERROR` event. `message` and `code` sit at the top level; an
 * adapter also keeps a nested `error: { message, code }` copy, which is the
 * fallback. `code` is the provider's own where it has one (Anthropic's
 * `max_tokens`) and otherwise the HTTP status, so the provider's error *type*
 * (`overloaded_error`, `rate_limit_exceeded`) is read from
 * `metadata.tanstack.errorType`, where `chat()` files it, and used when there
 * is no code at all.
 */
export function streamChunkError(chunk: unknown): StreamChunkError | null {
  if (!isRecord(chunk) || chunk.type !== 'RUN_ERROR') return null
  const nested = isRecord(chunk.error) ? chunk.error : {}
  const metadata = isRecord(chunk.metadata) ? chunk.metadata : {}
  const tanstack = isRecord(metadata.tanstack) ? metadata.tanstack : {}

  const message =
    nonEmptyString(chunk.message) ??
    nonEmptyString(nested.message) ??
    'The AI provider returned an unspecified error'
  const rawCode = chunk.code ?? nested.code
  const code =
    nonEmptyString(rawCode) ??
    (typeof rawCode === 'number' ? String(rawCode) : undefined) ??
    nonEmptyString(tanstack.errorType) ??
    nonEmptyString(chunk.errorType)

  return { message, code, fatal: code !== MAX_TOKENS_CODE }
}

/** Error thrown into a stage's catch block, which converts it to an `error` StageEvent. */
export function streamChunkErrorToError(error: StreamChunkError): Error {
  return new Error(
    error.code
      ? `AI provider error (${error.code}): ${error.message}`
      : `AI provider error: ${error.message}`,
  )
}

/**
 * Transient failures — a dropped socket, a timeout, provider overload — are
 * worth retrying: the request itself was valid and a fresh attempt usually
 * succeeds. `terminated` is undici's error when the streaming connection is cut
 * mid-response (e.g. a headers/body timeout on a slow or oversized request).
 * These differ from 4xx rejections (bad model, malformed request), which fail
 * identically on retry and must surface immediately instead of looping.
 */
const TRANSIENT_MESSAGE_PATTERN =
  /\bterminated\b|socket|econnreset|econnrefused|etimedout|timeout|network|fetch failed|overloaded|rate.?limit|\b(?:429|500|502|503|504|529)\b/i

const TRANSIENT_CODES = new Set([
  'overloaded_error',
  'rate_limit_error',
  'rate_limit_exceeded',
  'api_error',
  'timeout',
  'econnreset',
  'etimedout',
  // `code` is the HTTP status when the provider gave no code of its own.
  '429',
  '500',
  '502',
  '503',
  '504',
  '529',
])

export function isTransientStreamError(error: StreamChunkError): boolean {
  if (error.code && TRANSIENT_CODES.has(error.code.toLowerCase())) return true
  return TRANSIENT_MESSAGE_PATTERN.test(error.message)
}
