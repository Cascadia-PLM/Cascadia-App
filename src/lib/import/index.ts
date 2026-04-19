// Types
export type {
  ImportContext,
  ImportItemType,
  ColumnMapping,
  RowValidationError,
  RowValidationWarning,
  ValidatedRow,
  ParsedFile,
  ImportRowResult,
  ImportResult,
  ImportPartRow,
  ImportPartsRequest,
  ImportPartsResponse,
  // BOM types
  BomFormat,
  BomDetectionResult,
  BomRelationship,
  BomValidationResult,
  BomImportResult,
  BomRelationshipRequest,
  ImportPartsWithBomRequest,
} from './types'

export {
  importPartRowSchema,
  importPartsRequestSchema,
  importPartsResponseSchema,
  // BOM schemas
  bomRelationshipSchema,
  importPartsWithBomRequestSchema,
} from './types'

// Document import types
export type {
  ImportDocumentRow,
  ImportDocumentsRequest,
} from './types/document'

export {
  importDocumentRowSchema,
  importDocumentsRequestSchema,
} from './types/document'

// Issue import types
export type { ImportIssueRow, ImportIssuesRequest } from './types/issue'

export { importIssueRowSchema, importIssuesRequestSchema } from './types/issue'

// Field configs
export type { ItemFieldConfig, ImportTypeConfig } from './field-configs'

export {
  getImportConfig,
  getFieldsForItemType,
  getAllFieldsForItemType,
  getFieldConfigForType,
  getRequiredFieldsForType,
  getAutoGenerateFieldsForType,
  DOCUMENT_FIELDS,
  ISSUE_FIELDS,
} from './field-configs'

// Constants (backwards compatible + new type-aware functions)
export {
  PART_FIELDS,
  BOM_FIELDS,
  getAllFields,
  getFieldsForType,
  getFieldConfig,
  getFieldByType,
  getRequiredFields,
  getRequiredFieldsByType,
  getAutoGenerateFields,
  getAutoGenerateFieldsByType,
  ACCEPTED_FILE_TYPES,
  ACCEPTED_EXTENSIONS,
  MAX_IMPORT_ROWS,
  MAX_FILE_SIZE,
} from './constants'

/** @deprecated Use ItemFieldConfig from './field-configs' instead */
export type { PartFieldConfig } from './constants'

// Parser
export { parseFile, ParseError, isValidFileType, getFileType } from './parser'

// Mapper
export type { ApplyMappingsOptions } from './mapper'
export {
  autoDetectMappings,
  applyMappings,
  updateMapping,
  getMappedFields,
  checkRequiredFieldsMapped,
  sanitizeAttributeKey,
  getUnmappedColumns,
} from './mapper'

// Validator
export {
  validateRows,
  getValidationSummary,
  getValidRows,
  getInvalidRows,
  checkRequiredFieldsPresent,
  validateBomStructure,
} from './validator'

// BOM Parser
export {
  detectBomFormat,
  extractBomRelationships,
  getBomSummary,
} from './bom-parser'
