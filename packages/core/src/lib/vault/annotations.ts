// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'

/**
 * The markup vocabulary, shared by the viewer, the API, and the PDF flattener.
 *
 * Deliberately free of Node and database imports so client bundles can import
 * it — the same constraint `file-categories.ts` and `preview.ts` document.
 *
 * **Coordinates are normalized**: `0..1` measured from the top-left of the
 * unrotated page. A stroke drawn at 400% zoom on a rotated page has to land in
 * the same place when reopened at 100% unrotated, on a different screen, and
 * when stamped into the PDF by a background worker that never saw the viewport
 * — normalized coordinates are the only representation all three agree on.
 */

export const ANNOTATION_KINDS = [
  'highlight',
  'rect',
  'ink',
  'note',
  'text',
] as const

export type AnnotationKind = (typeof ANNOTATION_KINDS)[number]

/** Palette offered in the viewer. Hex so it round-trips to pdf-lib unchanged. */
export const ANNOTATION_COLORS = [
  { value: '#facc15', label: 'Yellow' },
  { value: '#4ade80', label: 'Green' },
  { value: '#60a5fa', label: 'Blue' },
  { value: '#f87171', label: 'Red' },
  { value: '#c084fc', label: 'Purple' },
] as const

export const DEFAULT_ANNOTATION_COLOR = '#facc15'

const normalized = z.number().min(0).max(1)

const pointSchema = z.object({ x: normalized, y: normalized })

const rectSchema = z.object({
  x: normalized,
  y: normalized,
  width: normalized,
  height: normalized,
})

/**
 * Highlight and rect share a geometry but not a meaning: a highlight is a
 * translucent fill (readable over scanned drawings, where there is no text
 * layer to select), a rect is an outline that circles something.
 */
export const annotationGeometrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('highlight'), rect: rectSchema }),
  z.object({ kind: z.literal('rect'), rect: rectSchema }),
  z.object({
    kind: z.literal('ink'),
    strokes: z.array(z.array(pointSchema).min(2)).min(1),
    /** Stroke width as a fraction of page width, so it scales with the page. */
    width: z.number().min(0).max(0.05),
  }),
  z.object({ kind: z.literal('note'), anchor: pointSchema }),
  z.object({
    kind: z.literal('text'),
    anchor: pointSchema,
    /** Cap height as a fraction of page height. */
    fontSize: z.number().min(0.005).max(0.2),
  }),
])

export type AnnotationGeometry = z.infer<typeof annotationGeometrySchema>
export type NormalizedRect = z.infer<typeof rectSchema>
export type NormalizedPoint = z.infer<typeof pointSchema>

export const createAnnotationSchema = z
  .object({
    pageNumber: z.number().int().min(1),
    geometry: annotationGeometrySchema,
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a #rrggbb colour'),
    contents: z.string().max(4000).nullable().optional(),
  })
  .refine(
    (value) =>
      contentsRequired(value.geometry.kind) === false ||
      Boolean(value.contents?.trim()),
    {
      message: 'This markup needs text',
      path: ['contents'],
    },
  )

/** Only the text-bearing kinds are meaningless without contents. */
export function contentsRequired(kind: AnnotationKind): boolean {
  return kind === 'text'
}

export const updateAnnotationSchema = z.object({
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a #rrggbb colour')
    .optional(),
  contents: z.string().max(4000).nullable().optional(),
  geometry: annotationGeometrySchema.optional(),
})

export type CreateAnnotationInput = z.infer<typeof createAnnotationSchema>
export type UpdateAnnotationInput = z.infer<typeof updateAnnotationSchema>

/** One piece of markup, as the API returns it. */
export interface FileAnnotation {
  id: string
  fileId: string
  itemId: string
  pageNumber: number
  kind: AnnotationKind
  geometry: AnnotationGeometry
  color: string
  contents: string | null
  authorId: string
  authorName: string | null
  createdAt: string
  updatedAt: string
}

export function isAnnotationKind(value: unknown): value is AnnotationKind {
  return (
    typeof value === 'string' &&
    (ANNOTATION_KINDS as ReadonlyArray<string>).includes(value)
  )
}

/**
 * The smallest drag that counts as a shape rather than a mis-click. Expressed
 * in normalized units, so it is the same physical slip at every zoom level.
 */
export const MIN_DRAG_EXTENT = 0.005
