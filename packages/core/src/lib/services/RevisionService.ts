// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Service for configurable revision scheme logic.
 *
 * Supports multiple revision schemes:
 * - alpha: A, B, C, ..., Z, AA, AB, ... (default, traditional PLM)
 * - numeric: 1, 2, 3, ...
 * - prefixed-numeric: X1, X2, X3, ... (prefix + numeric)
 * - none: No revision tracking — released items sit at `NO_REVISION` forever
 */

import { NO_REVISION_MARKER } from '../types/lifecycle'
import type { RevisionScheme } from '../types/lifecycle'

export class RevisionService {
  /**
   * The revision a released item carries under the `none` scheme.
   *
   * Deliberately non-empty: `''` is a working marker to `isWorkingRevision`
   * and to `notWorkingRevision()` in SQL, so releasing at `''` produced an
   * item that no released-item query would return. See
   * `NO_REVISION_MARKER` for the constraints the literal has to satisfy.
   *
   * It is not in `isWorkingRevision` and must not be: reading as released is
   * the entire point. The `next*` helpers do treat it as "no revision yet",
   * so switching a lifecycle off `none` mints the scheme's first revision
   * rather than incrementing the marker text.
   */
  static readonly NO_REVISION = NO_REVISION_MARKER

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
        return currentRevision || this.NO_REVISION
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
        return this.NO_REVISION
    }
  }

  /**
   * The revision an item carries before it has ever been released, when it
   * lives on main rather than a branch.
   *
   * Not a revision at all, and deliberately so: `isWorkingRevision` reads it as
   * unreleased and `getNextRevision` turns it into the scheme's first revision,
   * so the first release assigns A. The alternative every client used to reach
   * for - creating the item at 'A' - claims a released revision A that never
   * existed, and the first release then revised it to B.
   *
   * The branch counterpart is `getWorkingRevision`, which has a branch id to
   * scope with; on main there is nothing to scope against and nothing to
   * collide with, since (item_number, revision, design_id, item_type) is unique
   * and two unreleased versions of one item number in one design cannot coexist
   * there anyway.
   */
  static getUnreleasedRevision(): string {
    return '-'
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
   * Whether a revision carries no released ordinal to increment from — the
   * empty/legacy markers, a branch placeholder (e.g. "-abc12345"), or the
   * `none` scheme's fixed marker.
   *
   * The marker belongs here even though it is a *released* revision: it
   * encodes no position in any sequence, so switching a lifecycle from `none`
   * to alpha must mint 'A', not increment 'N/A' into garbage.
   */
  private static hasNoOrdinal(currentRevision: string): boolean {
    return (
      !currentRevision ||
      currentRevision === 'DRAFT' ||
      currentRevision.startsWith('-') ||
      currentRevision === this.NO_REVISION
    )
  }

  /**
   * Alpha revision: A → B → ... → Z → AA → AB → ...
   * Extracted from ChangeOrderMergeService.getNextRevision()
   */
  private static nextAlpha(currentRevision: string): string {
    if (this.hasNoOrdinal(currentRevision)) {
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
    if (this.hasNoOrdinal(currentRevision)) {
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
    if (this.hasNoOrdinal(currentRevision)) {
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
