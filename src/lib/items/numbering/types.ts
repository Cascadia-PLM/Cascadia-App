/**
 * Segment types for building item number patterns.
 * Numbers are composed of segments joined by a separator.
 */
export type NumberSegment =
  | { type: 'literal'; value: string }
  | {
      type: 'sequence'
      scope?: SequenceScope
      padding?: number
      startAt?: number
    }
  | { type: 'design-code' }
  | { type: 'field'; field: string; transform?: 'uppercase' | 'lowercase' }
  | {
      type: 'lookup'
      field: string
      map: Record<string, string>
      default?: string
    }
  | { type: 'date'; format: 'YYYY' | 'YYMM' | 'YYYYMM' }
  | { type: 'family-sequence'; padding?: number }

/**
 * Determines when a sequence counter resets.
 */
export type SequenceScope =
  | 'global' // One sequence for all items of this type
  | 'design' // Resets per design
  | 'prefix' // Resets when preceding segments change
  | 'yearly' // Resets each calendar year

/**
 * Complete numbering scheme for an item type.
 */
export interface NumberingScheme {
  /** The segments that make up the number */
  segments: Array<NumberSegment>

  /** Separator between segments (default: '-') */
  separator?: string

  /** Allow users to manually enter numbers instead of auto-generating */
  allowManualEntry?: boolean

  /** Validate manual entries match a pattern */
  manualPattern?: RegExp
}

/**
 * Configuration for family variant numbering (e.g., PN-000001-001).
 * Used when creating variants of an existing item.
 */
export interface FamilyNumberingConfig {
  /** Enable family variants for this item type */
  enabled: boolean

  /** Separator before family sequence (default: '-') */
  separator?: string

  /** Padding for family sequence (default: 3) */
  padding?: number
}

/**
 * Context passed to NumberingService for generating numbers.
 */
export interface NumberingContext {
  /** Design ID for design-scoped numbering */
  designId?: string | null

  /** Design code for design-code segment */
  designCode?: string | null

  /** Item fields for field/lookup segments */
  fields?: Record<string, unknown>
}
