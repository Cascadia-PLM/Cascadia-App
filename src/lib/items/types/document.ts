import { z } from 'zod'
import { baseItemSchema, commonStates } from './base'
import type { BaseItem } from './base'

// Document-specific interface
export interface Document extends BaseItem {
  itemType: 'Document'
  designId: string // Required for Documents - links to versioning system
  description?: string
  fileId?: string
  fileName?: string
  fileSize?: number
  mimeType?: string
  storagePath?: string

  // Usage/Definition pattern fields (populated by search with includeUsageCount)
  usageOf?: string // If set, this is a usage referencing a definition
  usageCount?: number // Number of designs using this definition
}

// Document validation schema
export const documentSchema = baseItemSchema.extend({
  itemType: z.literal('Document'),
  designId: z.string().uuid({ message: 'Design is required' }), // Required for Documents
  description: z.string().max(5000).optional(),
  fileId: z.string().uuid().optional(),
  fileName: z.string().max(500).optional(),
  fileSize: z.number().int().min(0).optional(),
  mimeType: z.string().max(100).optional(),
  storagePath: z.string().optional(),
})

// Document-specific states (using common states)
export const documentStates = commonStates

// Document relationships
export const documentRelationships = [
  {
    type: 'Part',
    label: 'Related Parts',
    targetTypes: ['Part'],
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
export type DocumentInput = z.infer<typeof documentSchema>
