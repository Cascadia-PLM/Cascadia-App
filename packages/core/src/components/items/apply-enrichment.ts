// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * How a create form takes in enrichment suggestions. Shared by the Part and
 * Tool forms so the two cannot drift on the one rule that matters: a
 * suggestion fills what the user has not touched, and never what they have.
 */

import type { EnrichmentSources } from './enrichment-sources'
import type { EnrichmentResult } from './useDropEnrichment'

/**
 * Suggested attributes under the existing ones (existing keys win), plus the
 * source link as provenance — unless a usable `link` is already there.
 * Attributes can hold any JSON, and a structured value is not a link.
 */
export function mergeEnrichmentAttributes(
  prev: Record<string, unknown>,
  result: EnrichmentResult,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...result.attributes, ...prev }
  if (result.link && (typeof merged.link !== 'string' || !merged.link.trim())) {
    merged.link = result.link
  }
  return merged
}

/**
 * Suggested field values into the fields that are still empty or at their
 * create-form default. Anything the user has typed stays.
 */
export function fillEmptyFields<T extends object>(
  prev: T,
  defaults: T,
  fields: Record<string, unknown>,
): T {
  const prevRecord = prev as unknown as Record<string, unknown>
  const defaultRecord = defaults as unknown as Record<string, unknown>
  const next: Record<string, unknown> = { ...prevRecord }
  for (const [key, value] of Object.entries(fields)) {
    const current = prevRecord[key]
    if (
      current === undefined ||
      current === null ||
      current === '' ||
      current === defaultRecord[key]
    ) {
      next[key] = value
    }
  }
  return next as unknown as T
}

export interface EnrichmentNotice {
  variant: 'success' | 'info'
  title: string
  description: string
}

/** What was dropped, for the notice: "the link", "the image", "the images". */
function sourceLabel(sources: EnrichmentSources): string {
  if (sources.images.length > 1) return 'images'
  if (sources.images.length === 1) return 'image'
  return 'link'
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/** The toast a form shows once suggestions have been merged. */
export function describeEnrichment(
  result: EnrichmentResult,
  sources: EnrichmentSources,
): EnrichmentNotice {
  const what = sourceLabel(sources)
  const linkSaved = result.link
    ? ' The link was saved as a custom attribute.'
    : ''

  if (!result.aiEnabled) {
    return {
      variant: 'info',
      title: result.link ? 'Link saved' : 'AI isn’t connected',
      description: `AI isn’t connected, so nothing was read from the ${what}.${linkSaved} Connect AI in settings to auto-fill from links and images.`,
    }
  }

  if (result.extractionFailed) {
    const textOnly =
      sources.images.length > 0
        ? ' A text-only model cannot read images — check the model in AI settings.'
        : ''
    return {
      variant: 'info',
      title: `Couldn’t read the ${what}`,
      description: `The AI model returned an error.${textOnly}${linkSaved}`,
    }
  }

  const fieldCount = Object.keys(result.fields).length
  const attrCount = Object.keys(result.attributes).length
  const capCount = Object.keys(result.capabilities ?? {}).length
  const warning = result.warning ? ` ${result.warning}.` : ''

  if (fieldCount + attrCount + capCount === 0) {
    return {
      variant: 'info',
      title: `Nothing found in the ${what}`,
      description: `Couldn’t pull any details from the ${what}.${warning}${linkSaved}`,
    }
  }

  const filled = [count(fieldCount, 'field'), count(attrCount, 'attribute')]
  if (capCount > 0) filled.push(count(capCount, 'capability', 'capabilities'))
  const truncated = result.attributesTruncated
    ? ' Some attributes were left out — there were more than fit.'
    : ''

  return {
    variant: 'success',
    title: 'Details added',
    description: `Filled ${filled.join(', ')} from the ${what}.${truncated}${warning}`,
  }
}
