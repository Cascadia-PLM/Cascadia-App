// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { baseItemSchema, commonStates } from './base'
import type { BaseItem } from './base'
import type { Make, OptionModel } from '@/lib/types/variants'
import { makesSchema, optionModelSchema } from '@/lib/types/variants'

// Part classification. Exported as a schema so the AI/MCP tool schemas can
// advertise exactly the values this type accepts (see requirement.ts).
export const partTypeSchema = z.enum([
  'Manufacture',
  'Purchase',
  'Software',
  'Phantom',
])
export type PartType = z.infer<typeof partTypeSchema>

// Part-specific interface
export interface Part extends BaseItem {
  itemType: 'Part'
  designId: string // Required for Parts - links to versioning system
  description?: string
  partType?: PartType
  trackingMode?: 'none' | 'lot' | 'serial'
  material?: string
  weight?: string
  weightUnit?: string
  cost?: string
  costCurrency?: string
  leadTimeDays?: number

  // Product variants (see docs/proposals/product-variants.md). A part with an
  // option model is configurable; its makes are named, complete selections.
  optionModel?: OptionModel | null
  makes?: Array<Make> | null

  // Usage/Definition pattern fields (populated by search with includeUsageCount)
  usageOf?: string // If set, this is a usage referencing a definition
  usageCount?: number // Number of designs using this definition
}

// Part validation schema
export const partSchema = baseItemSchema.extend({
  itemType: z.literal('Part'),
  designId: z.string().uuid({ message: 'Design is required' }), // Required for Parts
  description: z.string().max(5000).optional(),
  partType: partTypeSchema.optional(),
  trackingMode: z.enum(['none', 'lot', 'serial']).optional(),
  material: z.string().max(100).optional(),
  weight: z.string().optional(),
  weightUnit: z.string().max(10).optional().default('kg'),
  cost: z.string().optional(),
  costCurrency: z.string().length(3).optional().default('USD'),
  leadTimeDays: z.number().int().min(0).optional(),
  optionModel: optionModelSchema.nullable().optional(),
  makes: makesSchema.nullable().optional(),
})

// Part-specific states (using common states)
export const partStates = commonStates

// Part relationships
export const partRelationships = [
  {
    type: 'BOM',
    label: 'Bill of Materials',
    targetTypes: ['Part'],
    allowMultiple: true,
  },
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
  // Links a BOM-line Part (partType 'Software') to the Software configuration
  // item(s) behind it - a software part may aggregate bootloader + app image.
  {
    type: 'Software',
    label: 'Software',
    targetTypes: ['Software'],
    allowMultiple: true,
  },
]

// Export type for use in other modules
export type PartInput = z.infer<typeof partSchema>
