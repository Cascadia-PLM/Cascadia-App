import { z } from 'zod'

/**
 * Supported item types for import
 */
export type ImportItemType = 'Part' | 'Document' | 'Issue'

/**
 * Context for import operations
 */
export interface ImportContext {
  programId?: string // Optional for Issues
  designId?: string // Optional for Issues (free lifecycle)
  branchId?: string // Required for post-release designs
  designPhase?: 'pre-release' | 'post-release' // Not applicable for Issues
  itemType?: ImportItemType // Item type being imported
}

/**
 * Mapping from source column to target field
 */
export interface ColumnMapping {
  sourceColumn: string
  sourceIndex: number
  targetField: string | null // null means unmapped/skip
  confidence: number // 0-1 confidence score from auto-detection
}

/**
 * Validation result for a single row
 */
export interface RowValidationError {
  field: string
  message: string
}

export interface RowValidationWarning {
  field: string
  message: string
}

/**
 * Validated row with original and mapped data
 */
export interface ValidatedRow {
  rowNumber: number
  rawData: Record<string, unknown>
  mappedData: Record<string, unknown>
  errors: Array<RowValidationError>
  warnings: Array<RowValidationWarning>
  isValid: boolean
}

/**
 * Parsed file result
 */
export interface ParsedFile {
  headers: Array<string>
  rows: Array<Record<string, unknown>>
  totalRows: number
  fileName: string
  fileType: 'xlsx' | 'csv'
}

/**
 * Import result for a single row
 */
export interface ImportRowResult {
  rowNumber: number
  success: boolean
  itemId?: string
  itemNumber?: string
  error?: string
}

/**
 * Overall import result
 */
export interface ImportResult {
  totalRows: number
  successCount: number
  errorCount: number
  createdItems: Array<{
    rowNumber: number
    itemId: string
    itemNumber: string
  }>
  failedRows: Array<{
    rowNumber: number
    errors: Array<string>
  }>
}

// ----- BOM Types -----

/**
 * BOM format detection result
 */
export type BomFormat = 'flat' | 'level-based' | 'parent-child'

export interface BomDetectionResult {
  format: BomFormat
  hasLevel: boolean
  hasParent: boolean
  hasQuantity: boolean
  confidence: number
}

/**
 * BOM relationship extracted from file
 */
export interface BomRelationship {
  parentRowIndex: number // -1 if parent not in file (external)
  childRowIndex: number
  parentItemNumber: string
  childItemNumber: string
  quantity: number
  findNumber?: number
  referenceDesignator?: string
}

/**
 * BOM structure validation result
 */
export interface BomValidationResult {
  errors: Array<{ type: string; message: string; itemNumber?: string }>
  warnings: Array<{
    type: string
    message: string
    itemNumbers?: Array<string>
  }>
}

/**
 * Extended import result with BOM relationship tracking
 */
export interface BomImportResult extends ImportResult {
  relationshipsCreated: number
  relationshipsFailed: number
  failedRelationships: Array<{
    parentItemNumber: string
    childItemNumber: string
    error: string
  }>
}

// ----- Zod Schemas for API validation -----

/**
 * Single row data for import
 */
export const importPartRowSchema = z.object({
  itemNumber: z.string().max(100).optional(),
  name: z.string().min(1, 'Name is required').max(500),
  revision: z.string().min(1).max(10).default('-'),
  description: z.string().max(5000).optional(),
  partType: z
    .enum(['Manufacture', 'Purchase', 'Software', 'Phantom'])
    .optional(),
  material: z.string().max(100).optional(),
  weight: z.string().optional(),
  weightUnit: z.string().max(10).optional(),
  cost: z.string().optional(),
  costCurrency: z.string().length(3).optional(),
  leadTimeDays: z.number().int().min(0).optional(),
  /** Custom attributes from unmapped columns (converted to strings) */
  attributes: z.record(z.string(), z.string()).optional(),
})

export type ImportPartRow = z.infer<typeof importPartRowSchema>

/**
 * API request schema for bulk part import
 */
export const importPartsRequestSchema = z.object({
  designId: z.string().uuid({ message: 'Design ID is required' }),
  branchId: z.string().uuid().optional(),
  rows: z
    .array(importPartRowSchema)
    .min(1, 'At least one row is required')
    .max(500, 'Maximum 500 rows per import'),
  bypassBranchProtection: z.boolean().optional().default(false),
})

export type ImportPartsRequest = z.infer<typeof importPartsRequestSchema>

/**
 * API response schema for bulk part import
 */
export const importPartsResponseSchema = z.object({
  result: z.object({
    totalRows: z.number(),
    successCount: z.number(),
    errorCount: z.number(),
    createdItems: z.array(
      z.object({
        rowNumber: z.number(),
        itemId: z.string(),
        itemNumber: z.string(),
      }),
    ),
    failedRows: z.array(
      z.object({
        rowNumber: z.number(),
        errors: z.array(z.string()),
      }),
    ),
  }),
})

export type ImportPartsResponse = z.infer<typeof importPartsResponseSchema>

// ----- BOM API Schemas -----

/**
 * BOM relationship for API request
 */
export const bomRelationshipSchema = z.object({
  parentItemNumber: z.string(),
  childItemNumber: z.string(),
  quantity: z.number().min(0).default(1),
  findNumber: z.number().int().optional(),
  referenceDesignator: z.string().optional(),
})

export type BomRelationshipRequest = z.infer<typeof bomRelationshipSchema>

/**
 * Extended import request with BOM relationships
 */
export const importPartsWithBomRequestSchema = importPartsRequestSchema.extend({
  bomRelationships: z.array(bomRelationshipSchema).optional(),
})

export type ImportPartsWithBomRequest = z.infer<
  typeof importPartsWithBomRequestSchema
>
