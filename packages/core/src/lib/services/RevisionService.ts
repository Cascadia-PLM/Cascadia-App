// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Service for configurable revision scheme logic.
 *
 * Supports multiple revision schemes:
 * - alpha: A, B, C, ..., Z, AA, AB, ... (default, traditional PLM)
 * - numeric: 1, 2, 3, ...
 * - prefixed-numeric: X1, X2, X3, ... (prefix + numeric)
 * - none: No revision tracking
 */

import type { RevisionScheme } from '../types/lifecycle'

export class RevisionService {
  /**
   * Get the next revision value based on the current revision and scheme.
   * Defaults to alpha scheme when no scheme is provided (backward compatibility).
   */
  static getNextRevision(
    currentRevision: string,
    scheme?: RevisionScheme,
  ): string {
    const resolvedScheme = scheme ?? { type: 'alpha' as const }

    switch (resolvedScheme.type) {
      case 'alpha':
        return this.nextAlpha(currentRevision)
      case 'numeric':
        return this.nextNumeric(currentRevision)
      case 'prefixed-numeric':
        return this.nextPrefixedNumeric(currentRevision, resolvedScheme.prefix)
      case 'none':
        return currentRevision || ''
    }
  }

  /**
   * Get the initial revision value for a scheme.
   * This is the first revision assigned when an item is first released.
   */
  static getInitialRevision(scheme?: RevisionScheme): string {
    const resolvedScheme = scheme ?? { type: 'alpha' as const }

    switch (resolvedScheme.type) {
      case 'alpha':
        return 'A'
      case 'numeric':
        return '1'
      case 'prefixed-numeric':
        return `${resolvedScheme.prefix}1`
      case 'none':
        return ''
    }
  }

  /**
   * The revision an unreleased working copy carries on a branch.
   *
   * Branch-scoped by construction: the items unique constraint is
   * (item_number, revision, design_id, item_type), so two branches holding a
   * working copy of the same item must not share a revision string. A fixed
   * marker like 'DRAFT' collides; `-{branchId8}` does not.
   *
   * Every writer of an unreleased version uses this, and the merge decides
   * "is this a working copy?" with `isWorkingRevision` rather than sniffing
   * for a leading '-' - those two have to agree or the merge takes its
   * legacy path and mints a revision from the literal marker text.
   */
  static getWorkingRevision(branchId: string): string {
    return `-${branchId.substring(0, 8)}`
  }

  /**
   * Whether a revision marks an unreleased working copy rather than a real
   * released revision. Covers the branch placeholder, the historical 'DRAFT'
   * and '-' markers, and empty values.
   */
  static isWorkingRevision(revision: string | null | undefined): boolean {
    if (!revision) return true
    return revision === 'DRAFT' || revision === '-' || revision.startsWith('-')
  }

  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Alpha revision: A → B → ... → Z → AA → AB → ...
   * Extracted from ChangeOrderMergeService.getNextRevision()
   */
  private static nextAlpha(currentRevision: string): string {
    // Handle initial/empty revisions and placeholders (e.g., "-abc12345")
    if (
      !currentRevision ||
      currentRevision === 'DRAFT' ||
      currentRevision.startsWith('-')
    ) {
      return 'A'
    }

    const chars = currentRevision.toUpperCase().split('')
    let i = chars.length - 1

    while (i >= 0) {
      if (chars[i] === 'Z') {
        chars[i] = 'A'
        i--
      } else {
        chars[i] = String.fromCharCode(chars[i]!.charCodeAt(0) + 1)
        return chars.join('')
      }
    }

    // All characters were 'Z', need to add another character
    return 'A' + chars.join('') // ZZ -> AAA
  }

  /**
   * Numeric revision: 1 → 2 → 3 → ...
   */
  private static nextNumeric(currentRevision: string): string {
    if (
      !currentRevision ||
      currentRevision === 'DRAFT' ||
      currentRevision.startsWith('-')
    ) {
      return '1'
    }

    const num = parseInt(currentRevision, 10)
    if (isNaN(num)) {
      return '1'
    }

    return String(num + 1)
  }

  /**
   * Prefixed-numeric revision: X1 → X2 → X3 → ...
   * Strips the prefix, increments the number, re-adds the prefix.
   */
  private static nextPrefixedNumeric(
    currentRevision: string,
    prefix: string,
  ): string {
    if (
      !currentRevision ||
      currentRevision === 'DRAFT' ||
      currentRevision.startsWith('-')
    ) {
      return `${prefix}1`
    }

    // Strip the prefix if present
    const numPart = currentRevision.startsWith(prefix)
      ? currentRevision.slice(prefix.length)
      : currentRevision

    const num = parseInt(numPart, 10)
    if (isNaN(num)) {
      return `${prefix}1`
    }

    return `${prefix}${num + 1}`
  }
}
