// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { baseItemSchema, commonStates } from './base'
import type { RefinementCtx } from 'zod'
import type { BaseItem, RelationshipConfig } from './base'

// ============================================================================
// Software - firmware/embedded software configuration item
//
// A Software item is the configuration item behind a BOM line: the Part with
// partType 'Software' occupies the product structure, and links here via the
// Part's 'Software' relationship. See docs/features/software-management.md.
// ============================================================================

export const SOFTWARE_TYPES = [
  'firmware',
  'application',
  'library',
  'configuration',
  'fpga',
] as const

export type SoftwareType = (typeof SOFTWARE_TYPES)[number]

/**
 * Where the source of truth for development lives.
 * - 'internal': the source tree is stored in Cascadia (blobs + manifest)
 * - 'external': a pinned ref in an external repo (GitHub etc., later phase)
 */
export const SOURCE_MODES = ['internal', 'external'] as const

export type SourceMode = (typeof SOURCE_MODES)[number]

const emptyValueToUndefined = (value: unknown) =>
  value === null || (typeof value === 'string' && value.trim() === '')
    ? undefined
    : value

const softwareSourceFields = {
  sourceMode: z.enum(SOURCE_MODES).optional().default('internal'),
  externalRepositoryUrl: z.preprocess(
    emptyValueToUndefined,
    z
      .string()
      .trim()
      .max(2048)
      .url({ message: 'Repository URL must be a valid URL' })
      .refine((value) => /^https?:\/\//i.test(value), {
        message: 'Repository URL must use http:// or https://',
      })
      .optional(),
  ),
  externalRef: z.preprocess(
    emptyValueToUndefined,
    z.string().trim().max(300).optional(),
  ),
  externalCommitSha: z.preprocess(
    emptyValueToUndefined,
    z
      .string()
      .trim()
      .regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/i, {
        message: 'Commit SHA must contain 40 or 64 hexadecimal characters',
      })
      .optional(),
  ),
}

function requireExternalSource(
  data: {
    sourceMode?: SourceMode
    externalRepositoryUrl?: string
    externalRef?: string
  },
  ctx: RefinementCtx,
) {
  if (data.sourceMode !== 'external') return

  if (!data.externalRepositoryUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['externalRepositoryUrl'],
      message: 'Repository URL is required for external source mode',
    })
  }
  if (!data.externalRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['externalRef'],
      message: 'Pinned reference is required for external source mode',
    })
  }
}

/** Source fields also used by the persistence handler for partial updates. */
export const softwareSourceSchema = z
  .object(softwareSourceFields)
  .superRefine(requireExternalSource)

export interface Software extends BaseItem {
  itemType: 'Software'
  designId: string // Required - Software participates in versioning
  description?: string
  softwareType?: SoftwareType
  sourceMode?: SourceMode
  // Manually recorded external source metadata. Provider-backed repository
  // connections, ref resolution and mirroring remain a later phase.
  externalRepositoryUrl?: string | null
  externalRef?: string | null
  externalCommitSha?: string | null
  // User-managed version metadata, distinct from the PLM revision letter
  version?: string
  targetHardware?: string
  toolchain?: string
  // Immutable source-tree snapshot for THIS item version (internal mode)
  manifestId?: string | null
  // In-progress (uncommitted) edits on a working copy
  draftManifestId?: string | null
  // Primary build artifact (vault file)
  buildArtifactFileId?: string | null
}

export const softwareSchema = baseItemSchema
  .extend({
    itemType: z.literal('Software'),
    designId: z.string().uuid({ message: 'Design is required' }),
    description: z.string().max(5000).optional(),
    softwareType: z.enum(SOFTWARE_TYPES).optional(),
    ...softwareSourceFields,
    version: z.string().max(50).optional(),
    targetHardware: z.string().max(200).optional(),
    toolchain: z.string().max(200).optional(),
    manifestId: z.string().uuid().nullable().optional(),
    draftManifestId: z.string().uuid().nullable().optional(),
    buildArtifactFileId: z.string().uuid().nullable().optional(),
  })
  .superRefine(requireExternalSource)

// Software uses the standard driven lifecycle (ECO-controlled), like Parts
export const softwareStates = commonStates

export const softwareRelationships: Array<RelationshipConfig> = [
  {
    type: 'Document',
    label: 'Documents',
    targetTypes: ['Document'],
    allowMultiple: true,
  },
  {
    type: 'Change',
    label: 'Change Orders',
    targetTypes: ['ChangeOrder'],
    allowMultiple: true,
  },
]

export type SoftwareInput = z.infer<typeof softwareSchema>
