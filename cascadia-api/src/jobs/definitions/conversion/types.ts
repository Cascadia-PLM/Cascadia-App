// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'

/** The derivative formats the CAD converter can store. */
export const CAD_OUTPUT_FORMATS = ['glb', 'stl'] as const
export type CadOutputFormat = (typeof CAD_OUTPUT_FORMATS)[number]

/**
 * What a deployment stores when `CAD_DEFAULT_OUTPUT_FORMATS` is unset: both,
 * as every conversion did before the setting existed. The Python worker's
 * payload model carries the same pair for rows queued before `outputFormats`.
 */
const BUILTIN_CAD_OUTPUT_FORMATS: ReadonlyArray<CadOutputFormat> = [
  'glb',
  'stl',
]

/**
 * A non-empty list of derivative formats, for the API body and the job
 * payload alike: an empty one would queue a job that finishes "successfully"
 * having been asked to store nothing.
 */
export const cadOutputFormatsSchema = z.array(z.enum(CAD_OUTPUT_FORMATS)).min(1)

function isCadOutputFormat(value: string): value is CadOutputFormat {
  return (CAD_OUTPUT_FORMATS as ReadonlyArray<string>).includes(value)
}

/**
 * Parse a `CAD_DEFAULT_OUTPUT_FORMATS` value: a comma-separated list of
 * {@link CAD_OUTPUT_FORMATS}, case-insensitive.
 *
 * Unset or blank means "not configured" and yields the built-in pair — blank
 * included, because a compose file passing the variable through as
 * `${CAD_DEFAULT_OUTPUT_FORMATS:-}` delivers an empty string when the operator
 * set nothing. Anything else must name at least one known format and nothing
 * unknown, or this throws an error naming the variable: a typo (`gltf`) or a
 * list with no entries (`,`) is a misconfiguration to stop on, not one to
 * guess around.
 */
export function parseCadOutputFormats(
  raw: string | undefined,
): Array<CadOutputFormat> {
  const trimmed = raw?.trim()
  if (!trimmed) return [...BUILTIN_CAD_OUTPUT_FORMATS]

  const entries = trimmed
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '')
  const unknown = entries.filter((value) => !isCadOutputFormat(value))
  if (entries.length === 0 || unknown.length > 0) {
    throw new Error(
      `CAD_DEFAULT_OUTPUT_FORMATS must be a comma-separated list of ` +
        `${CAD_OUTPUT_FORMATS.join(', ')} naming at least one format ` +
        `(got ${JSON.stringify(raw)}` +
        (unknown.length > 0 ? `; unknown: ${unknown.join(', ')}` : '') +
        '). Unset it to store both.',
    )
  }
  return [...new Set(entries.filter(isCadOutputFormat))]
}

/** The deployment's default derivative formats, from the environment. */
export function configuredCadOutputFormats(): Array<CadOutputFormat> {
  return parseCadOutputFormats(process.env.CAD_DEFAULT_OUTPUT_FORMATS)
}

/**
 * The `outputFormats` a conversion job is submitted with: the formats asked
 * for, deduplicated, plus STL whenever the assembly is decomposed — its
 * manifest is keyed by each part's STL file id, so decomposition cannot run
 * without one.
 */
export function cadJobOutputFormats(
  formats: ReadonlyArray<CadOutputFormat>,
  decompose: boolean,
): Array<CadOutputFormat> {
  const resolved = new Set(formats)
  if (decompose) resolved.add('stl')
  return [...resolved]
}

export const cadConversionPayloadSchema = z.object({
  vaultFileId: z.string().uuid(),
  itemId: z.string().uuid(),
  outputBranchId: z.string().uuid().nullable().optional(),
  outputFormat: z.string().default('stl'),
  /**
   * Required, with no default: the submitter resolves the deployment's
   * default (`configuredCadOutputFormats`) so the queued payload records
   * exactly what this job stores, and a submitter that forgets fails here
   * rather than silently ignoring `CAD_DEFAULT_OUTPUT_FORMATS`. Rows queued
   * before the field existed carry none; the worker reads those as both.
   */
  outputFormats: cadOutputFormatsSchema,
  meshQuality: z.enum(['preview', 'standard', 'high']).default('standard'),
  decompose: z.boolean().default(false),
  userId: z.string().uuid(),
})

export type CadConversionPayload = z.infer<typeof cadConversionPayloadSchema>

export const cadConversionResultSchema = z.object({
  outputFileIds: z.array(z.string().uuid()),
  totalParts: z.number().int().min(0),
  polygonCount: z.number().int().min(0),
  boundingBox: z
    .object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
    })
    .optional(),
  conversionTimeMs: z.number().int().min(0),
  thumbnailFileId: z.string().uuid().optional(),
  glbFileIds: z.array(z.string().uuid()).optional(),
  manifest: z
    .array(
      z.object({
        name: z.string(),
        stlFileId: z.string().uuid(),
        polygonCount: z.number().int(),
        boundingBox: z
          .object({
            x: z.number(),
            y: z.number(),
            z: z.number(),
          })
          .optional(),
        transform: z.array(z.number()).optional(),
        glbFileId: z.string().uuid().optional(),
        color: z.array(z.number()).length(3).optional(),
      }),
    )
    .optional(),
})

export type CadConversionResult = z.infer<typeof cadConversionResultSchema>
