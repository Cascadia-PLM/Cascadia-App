// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Freeform capability text <-> capabilities record.
 *
 * Tool subtypes without a dedicated editor (including "other") fall back to a
 * plain-text capabilities field. The syntax is deliberately forgiving so a
 * non-technical user never has to type JSON punctuation:
 *
 *   Build volume: 250 x 210 x 220
 *   Materials: PLA, PETG, ABS
 *   Heated bed: yes
 *   Max power: 60
 *   Enclosed, Filtered exhaust
 *
 * Rules:
 *  - One capability per line, `key: value` or `key = value`.
 *  - Commas inside a value make a list; `A x B x C` numbers make a dimension.
 *  - A line with no separator becomes yes/no flags (comma-separated).
 *  - `yes`/`no`/`true`/`false` become booleans, bare numbers become numbers.
 *  - Quotes are optional, but JSON is still accepted verbatim so previously
 *    saved data (nested objects, pasted JSON) round-trips without loss.
 */

const TRUE_WORDS = new Set(['true', 'yes', 'y'])
const FALSE_WORDS = new Set(['false', 'no', 'n'])

// ============================================================================
// Low-level scanning helpers
// ============================================================================

/** Split on top-level commas — commas inside quotes or brackets are kept. */
function splitTopLevel(input: string): Array<string> {
  const parts: Array<string> = []
  let current = ''
  let depth = 0
  let quote: string | null = null

  for (let i = 0; i < input.length; i++) {
    const ch = input.charAt(i)

    if (quote) {
      current += ch
      if (ch === '\\' && i + 1 < input.length) {
        current += input.charAt(i + 1)
        i++
      } else if (ch === quote) {
        quote = null
      }
      continue
    }

    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }

    current += ch
  }

  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

/** Index of the first top-level `:` or `=`, or -1 when the line has neither. */
function findSeparator(line: string): number {
  let depth = 0
  let quote: string | null = null

  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i)

    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }

    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if ((ch === ':' || ch === '=') && depth === 0) return i
  }

  return -1
}

function isNumeric(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value)
}

/** Strip a matching pair of surrounding quotes, if present. */
function unquote(value: string): string {
  const first = value.charAt(0)
  if (
    value.length >= 2 &&
    (first === '"' || first === "'") &&
    value.endsWith(first)
  ) {
    return value.slice(1, -1)
  }
  return value
}

// ============================================================================
// Parsing
// ============================================================================

function coerceScalar(raw: string): string | number | boolean {
  const value = unquote(raw.trim())
  if (value === '') return ''

  const lower = value.toLowerCase()
  if (TRUE_WORDS.has(lower)) return true
  if (FALSE_WORDS.has(lower)) return false
  if (isNumeric(value)) return Number(value)
  return value
}

function coerceValue(raw: string): unknown {
  const value = raw.trim()
  if (value === '') return ''

  // Verbatim JSON — the only way to express nested structures.
  if (/^[[{"]/.test(value)) {
    try {
      return JSON.parse(value) as unknown
    } catch {
      // Not valid JSON (likely mid-typing) — fall through to plain parsing.
    }
  }

  // Dimension shorthand: "250 x 210 x 220" -> [250, 210, 220]
  const dims = value.split(/\s*[x×]\s*/i)
  if (dims.length > 1 && dims.every(isNumeric)) return dims.map(Number)

  const parts = splitTopLevel(value)
  if (parts.length > 1) return parts.map(coerceScalar)
  return coerceScalar(value)
}

function normalizeKey(raw: string): string {
  return unquote(raw.trim()).replace(/\s+/g, ' ').trim()
}

/**
 * Parse freeform capability text into a capabilities record.
 * Never throws — partially typed input yields a partial record.
 */
export function parseCapabilityText(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  if (trimmed === '') return {}

  // A whole pasted JSON object is taken as-is.
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Not (yet) valid JSON — parse it line by line instead.
    }
  }

  const result: Record<string, unknown> = {}

  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine
      .replace(/^\s*[-*•]\s+/, '') // bullet prefixes
      .replace(/[,;]+$/, '') // trailing list punctuation
      .trim()
    if (line === '') continue

    const separator = findSeparator(line)

    // No separator: every comma-separated token is a yes-flag.
    if (separator === -1) {
      for (const token of splitTopLevel(line)) {
        const key = normalizeKey(token)
        if (key !== '') result[key] = true
      }
      continue
    }

    const key = normalizeKey(line.slice(0, separator))
    if (key === '') continue
    result[key] = coerceValue(line.slice(separator + 1))
  }

  return result
}

// ============================================================================
// Formatting
// ============================================================================

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

/** Render a scalar so that parsing it again returns the same value. */
function formatScalar(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'number') return String(value)
  if (value === '') return ''
  // Quote strings that would otherwise parse back as another type or split.
  if (coerceScalar(value) !== value || /[,\n:=]/.test(value)) {
    return JSON.stringify(value)
  }
  return value
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (isScalar(value)) return formatScalar(value)
  if (Array.isArray(value) && value.every(isScalar)) {
    return value.map(formatScalar).join(', ')
  }
  return JSON.stringify(value)
}

/**
 * Render a capabilities record back into freeform text.
 * An empty record yields an empty string — never a bare `{}`.
 */
export function formatCapabilityText(
  capabilities: Record<string, unknown>,
): string {
  return Object.entries(capabilities)
    .map(([key, value]) => {
      const safeKey = /[:=\n]/.test(key) ? JSON.stringify(key) : key
      const rendered = formatValue(value)
      return rendered === '' ? `${safeKey}: ` : `${safeKey}: ${rendered}`
    })
    .join('\n')
}

// ============================================================================
// Display helpers (read-only rendering)
// ============================================================================

/** `buildVolume` / `build_volume` -> `Build Volume`; human labels pass through. */
export function humanizeCapabilityKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  if (spaced === '') return key
  return spaced
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** Human-readable value for read-only display (not round-trip safe). */
export function displayCapabilityValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every(isScalar)) {
    // 2–3 numbers read as dimensions: 250 × 210 × 220
    if (
      value.length >= 2 &&
      value.length <= 3 &&
      value.every(Number.isFinite)
    ) {
      return value.join(' × ')
    }
    return value
      .map((entry) =>
        typeof entry === 'boolean' ? (entry ? 'Yes' : 'No') : entry,
      )
      .join(', ')
  }
  return JSON.stringify(value)
}
