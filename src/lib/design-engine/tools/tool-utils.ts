/**
 * Shared helpers for design-engine stage tools.
 */

/**
 * Extract a safe, model-facing message from a thrown tool error.
 *
 * I/O tools (searches, catalog/BOM lookups) wrap their body in try/catch and
 * return a schema-valid empty result carrying this message under an `error`
 * field, so a transient failure lets the model recover instead of failing the
 * whole design session.
 */
export function toolErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Tool execution failed'
}

function codePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * Decode HTML entities that the model sometimes emits inside plain-text tool
 * arguments — e.g. a part named "Frame & Chassis" comes back as the literal
 * "Frame &amp; Chassis". Left as-is that literal is stored, shown in the BOM
 * table, and materialized onto the real PLM item's name. `&amp;` is decoded
 * last so a value like "&amp;lt;" resolves to "&lt;" rather than over-decoding
 * to "<".
 */
export function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      codePoint(parseInt(hex, 16)),
    )
    .replace(/&amp;/gi, '&')
}

/** Decode entities in an optional string, preserving `undefined`. */
export function decodeEntitiesMaybe(
  value: string | undefined,
): string | undefined {
  return value === undefined ? undefined : decodeEntities(value)
}
