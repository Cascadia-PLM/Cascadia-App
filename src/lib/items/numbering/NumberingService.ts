import { sql } from 'drizzle-orm'
import { familyNumberingConfig, numberingSchemes } from './schemes'
import type { NumberSegment, NumberingContext, SequenceScope } from './types'
import { db } from '@/lib/db'

/**
 * Service for generating and validating item numbers.
 * Supports configurable segment-based patterns with scoped sequences.
 */
export class NumberingService {
  /**
   * Generate the next item number for an item type.
   */
  static async generate(
    itemType: string,
    context: NumberingContext = {},
  ): Promise<string> {
    const scheme = numberingSchemes[itemType]
    if (!scheme) {
      throw new Error(`No numbering scheme defined for ${itemType}`)
    }

    const parts: Array<string> = []
    let prefixForScope = '' // Accumulates for 'prefix' scope

    for (const segment of scheme.segments) {
      const value = await this.resolveSegment(
        segment,
        itemType,
        prefixForScope,
        context,
      )
      parts.push(value)

      // Track prefix for scope calculations
      if (segment.type !== 'sequence') {
        prefixForScope +=
          (prefixForScope ? (scheme.separator ?? '-') : '') + value
      }
    }

    return parts.join(scheme.separator ?? '-')
  }

  /**
   * Resolve a single segment to its string value.
   */
  private static async resolveSegment(
    segment: NumberSegment,
    itemType: string,
    currentPrefix: string,
    context: NumberingContext,
  ): Promise<string> {
    switch (segment.type) {
      case 'literal':
        return segment.value

      case 'sequence': {
        const scopeKey = this.computeScopeKey(
          segment.scope ?? 'global',
          itemType,
          currentPrefix,
          context,
        )
        const nextVal = await this.getNextSequence(
          itemType,
          scopeKey,
          segment.startAt ?? 1,
        )
        return String(nextVal).padStart(segment.padding ?? 6, '0')
      }

      case 'design-code':
        if (!context.designCode) {
          throw new Error('Design code required for numbering but not provided')
        }
        return context.designCode

      case 'field': {
        const value = context.fields?.[segment.field]
        if (value === undefined || value === null) {
          throw new Error(
            `Field '${segment.field}' required for numbering but not provided`,
          )
        }
        const str = String(value)
        if (segment.transform === 'uppercase') return str.toUpperCase()
        if (segment.transform === 'lowercase') return str.toLowerCase()
        return str
      }

      case 'lookup': {
        const value = context.fields?.[segment.field]
        const str = value !== undefined && value !== null ? String(value) : ''
        const mapped = segment.map[str]
        if (mapped) return mapped
        if (segment.default) return segment.default
        throw new Error(
          `No mapping for '${segment.field}' value '${str}' and no default provided`,
        )
      }

      case 'date': {
        const now = new Date()
        switch (segment.format) {
          case 'YYYY':
            return String(now.getFullYear())
          case 'YYMM':
            return `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}`
          case 'YYYYMM':
            return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`
        }
        break
      }

      case 'family-sequence':
        // This is handled separately via generateFamilyVariant()
        throw new Error(
          'family-sequence should not appear in base numbering scheme',
        )

      default:
        throw new Error(
          `Unknown segment type: ${(segment as { type: string }).type}`,
        )
    }

    // TypeScript exhaustiveness check fallback
    throw new Error('Unreachable code in resolveSegment')
  }

  /**
   * Compute the scope key for sequence lookup.
   */
  private static computeScopeKey(
    scope: SequenceScope,
    itemType: string,
    currentPrefix: string,
    context: NumberingContext,
  ): string {
    switch (scope) {
      case 'global':
        return itemType
      case 'design':
        return `${itemType}:design:${context.designId ?? 'none'}`
      case 'prefix':
        return `${itemType}:prefix:${currentPrefix}`
      case 'yearly':
        return `${itemType}:year:${new Date().getFullYear()}`
    }
  }

  /**
   * Atomic sequence increment using PostgreSQL upsert.
   * Returns the next sequence value (increments by 1 or starts at startAt).
   */
  private static async getNextSequence(
    itemType: string,
    scopeKey: string,
    startAt: number,
  ): Promise<number> {
    // Use a single atomic upsert with RETURNING
    // On conflict: increment current_value by 1
    // On insert: set current_value to startAt
    const result = await db.execute(sql`
      INSERT INTO number_sequences (id, item_type, scope_key, current_value, modified_at)
      VALUES (gen_random_uuid(), ${itemType}, ${scopeKey}, ${startAt}, NOW())
      ON CONFLICT (item_type, scope_key)
      DO UPDATE SET
        current_value = number_sequences.current_value + 1,
        modified_at = NOW()
      RETURNING current_value
    `)

    // db.execute returns rows directly as an array
    const rows = result as unknown as Array<{ current_value: number }>
    return rows[0].current_value
  }

  /**
   * Generate a family variant number (e.g., PN-000001-002).
   * Used when creating variants of an existing item.
   */
  static async generateFamilyVariant(
    baseNumber: string,
    options: { separator?: string; padding?: number } = {},
  ): Promise<string> {
    const separator = options.separator ?? '-'
    const padding = options.padding ?? 3

    // Scope key is the base number itself
    const scopeKey = `family:${baseNumber}`
    const nextVal = await this.getNextSequence('family', scopeKey, 1)

    return `${baseNumber}${separator}${String(nextVal).padStart(padding, '0')}`
  }

  /**
   * Check if manual entry is allowed for an item type.
   */
  static allowsManualEntry(itemType: string): boolean {
    return numberingSchemes[itemType]?.allowManualEntry ?? false
  }

  /**
   * Validate a manually entered number against the scheme's pattern.
   */
  static validateManualNumber(itemType: string, number: string): boolean {
    const scheme = numberingSchemes[itemType]
    if (!scheme?.manualPattern) return true
    return scheme.manualPattern.test(number)
  }

  /**
   * Check if family variants are enabled for an item type.
   */
  static familyVariantsEnabled(itemType: string): boolean {
    return familyNumberingConfig[itemType]?.enabled ?? false
  }

  /**
   * Get the numbering scheme for an item type.
   * Returns undefined if no scheme is defined.
   */
  static getScheme(itemType: string) {
    return numberingSchemes[itemType]
  }
}
