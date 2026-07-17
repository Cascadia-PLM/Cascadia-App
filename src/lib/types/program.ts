import type { programs } from '@/lib/db/schema/programs'
import type { Serialized } from './serialized'

/**
 * A program as the client receives it: the DB row serialized over HTTP, so
 * timestamp columns arrive as ISO strings, not Date objects.
 */
export type Program = Serialized<typeof programs.$inferSelect> & {
  userRole?: string
}

export type CreateProgramInput = {
  name: string
  code: string
  description?: string
  contractNumber?: string
  customer?: string
  startDate?: Date | string
  targetEndDate?: Date | string
  status?: 'Active' | 'On Hold' | 'Completed' | 'Cancelled'
  attributes?: Record<string, unknown>
}

export type UpdateProgramInput = Partial<CreateProgramInput>
