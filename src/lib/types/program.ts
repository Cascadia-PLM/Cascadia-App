import type { programs } from '@/lib/db/schema/programs'

export type Program = typeof programs.$inferSelect & {
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
