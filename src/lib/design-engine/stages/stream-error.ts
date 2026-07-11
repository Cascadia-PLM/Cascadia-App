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
