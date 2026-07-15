/**
 * Provider adapters do not throw when the AI API rejects a request. The
 * Anthropic adapter's `chatStream` catches the failure and yields a terminal
 * `{ type: 'error' }` chunk instead. A stage loop that only inspects `content`
 * and tool chunks therefore sees an empty stream and concludes the model chose
 * to say nothing — turning a 400 into a silently empty artifact.
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

export function streamChunkError(chunk: unknown): StreamChunkError | null {
  if (typeof chunk !== 'object' || chunk === null) return null
  const record = chunk as {
    type?: unknown
    error?: { message?: unknown; code?: unknown }
  }
  if (record.type !== 'error') return null

  const message =
    typeof record.error?.message === 'string' && record.error.message
      ? record.error.message
      : 'The AI provider returned an unspecified error'
  const code =
    typeof record.error?.code === 'string' ? record.error.code : undefined

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
  'api_error',
  'timeout',
  'econnreset',
  'etimedout',
])

export function isTransientStreamError(error: StreamChunkError): boolean {
  if (error.code && TRANSIENT_CODES.has(error.code.toLowerCase())) return true
  return TRANSIENT_MESSAGE_PATTERN.test(error.message)
}
