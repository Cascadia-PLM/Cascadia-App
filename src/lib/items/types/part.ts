import { z } from 'zod'
import { baseItemSchema, commonStates } from './base'
import type { BaseItem } from './base'

// Part-specific interface
export interface Part extends BaseItem {
  itemType: 'Part'
  designId: string // Required for Parts - links to versioning system
  description?: string
  partType?: 'Manufacture' | 'Purchase' | 'Software' | 'Phantom'
  material?: string
  weight?: string
  weightUnit?: string
  cost?: string
  costCurrency?: string
  leadTimeDays?: number

  // Usage/Definition pattern fields (populated by search with includeUsageCount)
  usageOf?: string // If set, this is a usage referencing a definition
  usageCount?: number // Number of designs using this definition
}

// Part validation schema
export const partSchema = baseItemSchema.extend({
  itemType: z.literal('Part'),
  designId: z.string().uuid({ message: 'Design is required' }), // Required for Parts
  description: z.string().max(5000).optional(),
  partType: z
    .enum(['Manufacture', 'Purchase', 'Software', 'Phantom'])
    .optional(),
  material: z.string().max(100).optional(),
  weight: z.string().optional(),
  weightUnit: z.string().max(10).optional().default('kg'),
  cost: z.string().optional(),
  costCurrency: z.string().length(3).optional().default('USD'),
  leadTimeDays: z.number().int().min(0).optional(),
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
]

// Export type for use in other modules
export type PartInput = z.infer<typeof partSchema>
