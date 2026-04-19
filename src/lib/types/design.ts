import type { designs } from '@/lib/db/schema/designs'

export type Design = typeof designs.$inferSelect

export type CreateDesignInput = {
  programId?: string | null
  name: string
  code: string
  description?: string
  designType?: 'Engineering' | 'Library' | 'Family'
  parentDesignId?: string | null
  plannedQuantity?: number
  attributes?: Record<string, unknown>
}

export type UpdateDesignInput = Partial<Omit<CreateDesignInput, 'designType'>>
