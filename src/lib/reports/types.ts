import { z } from 'zod'

// Filter operators for report filters
export const filterOperators = [
  'eq', // Equal
  'ne', // Not equal
  'gt', // Greater than
  'lt', // Less than
  'gte', // Greater than or equal
  'lte', // Less than or equal
  'like', // Contains (case-insensitive)
  'not_like', // Does not contain
  'in', // In list
  'not_in', // Not in list
  'is_null', // Is null
  'is_not_null', // Is not null
  'starts_with', // Starts with
  'ends_with', // Ends with
  'between', // Between two values
] as const

export type FilterOperator = (typeof filterOperators)[number]

export type SortDirection = 'asc' | 'desc'

export const formatTypes = [
  'text',
  'number',
  'currency',
  'date',
  'datetime',
  'boolean',
  'email',
  'url',
  'percentage',
] as const

export type FormatType = (typeof formatTypes)[number]

export const exportFormats = ['csv', 'json', 'xlsx'] as const

export type ExportFormat = (typeof exportFormats)[number]

// Report Column interface
export interface ReportColumn {
  id?: string
  reportId?: string
  fieldPath: string
  label: string
  displayOrder: number
  formatType?: FormatType | null
  isVisible: boolean
  width?: number | null
}

// Report Filter interface
export interface ReportFilter {
  id?: string
  reportId?: string
  fieldPath: string
  operator: FilterOperator
  value?: string | null
  value2?: string | null // For 'between' operator
  displayOrder: number
}

// Report Sort interface
export interface ReportSort {
  id?: string
  reportId?: string
  fieldPath: string
  direction: SortDirection
  priority: number
}

// Report interface
export interface Report {
  id?: string
  name: string
  description?: string | null
  itemType: string
  isPublic: boolean
  sharedWithRoles?: Array<string> | null
  sharedWithUsers?: Array<string> | null

  config?: Record<string, any> | null
  createdAt?: Date
  createdBy?: string
  modifiedAt?: Date
  modifiedBy?: string
  // Enriched relations
  columns?: Array<ReportColumn>
  filters?: Array<ReportFilter>
  sorts?: Array<ReportSort>
}

// Report execution result
export interface ReportExecutionResult {
  reportId: string
  reportName: string
  executedAt: Date
  durationMs: number
  executionId?: string
  totalRows: number
  columns: Array<ReportColumn>
  rows: Array<Record<string, unknown>>
  pagination?: {
    limit: number
    offset: number
    hasMore: boolean
  }
}

// Report execution options
export interface ReportExecutionOptions {
  limit?: number
  offset?: number
  // Override filters at execution time
  runtimeFilters?: Array<{
    fieldPath: string
    operator: FilterOperator
    value?: string
    value2?: string
  }>
}

// Field definition for UI
export interface FieldDefinition {
  path: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'datetime'
  table?: string
}

// Zod Schemas
export const reportColumnSchema = z.object({
  id: z.string().uuid().optional(),
  reportId: z.string().uuid().optional(),
  fieldPath: z.string().min(1).max(255),
  label: z.string().min(1).max(255),
  displayOrder: z.number().int().min(0),
  formatType: z.enum(formatTypes).nullable().optional(),
  isVisible: z.boolean().default(true),
  width: z.number().int().positive().nullable().optional(),
})

export const reportFilterSchema = z.object({
  id: z.string().uuid().optional(),
  reportId: z.string().uuid().optional(),
  fieldPath: z.string().min(1).max(255),
  operator: z.enum(filterOperators),
  value: z.string().nullable().optional(),
  value2: z.string().nullable().optional(),
  displayOrder: z.number().int().min(0),
})

export const reportSortSchema = z.object({
  id: z.string().uuid().optional(),
  reportId: z.string().uuid().optional(),
  fieldPath: z.string().min(1).max(255),
  direction: z.enum(['asc', 'desc']),
  priority: z.number().int().min(0),
})

export const reportSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  itemType: z.string().min(1).max(50),
  isPublic: z.boolean().default(false),
  sharedWithRoles: z.array(z.string()).nullable().optional(),
  sharedWithUsers: z.array(z.string().uuid()).nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  columns: z
    .array(reportColumnSchema)
    .min(1, 'At least one column is required'),
  filters: z.array(reportFilterSchema).optional().default([]),
  sorts: z.array(reportSortSchema).optional().default([]),
})

export const reportExecutionOptionsSchema = z.object({
  limit: z.number().int().positive().max(1000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
  runtimeFilters: z
    .array(
      z.object({
        fieldPath: z.string().min(1),
        operator: z.enum(filterOperators),
        value: z.string().optional(),
        value2: z.string().optional(),
      }),
    )
    .optional(),
})

// Type inference helpers
export type ReportCreateInput = z.infer<typeof reportSchema>
export type ReportColumnInput = z.infer<typeof reportColumnSchema>
export type ReportFilterInput = z.infer<typeof reportFilterSchema>
export type ReportSortInput = z.infer<typeof reportSortSchema>
export type ReportExecutionOptionsInput = z.infer<
  typeof reportExecutionOptionsSchema
>
