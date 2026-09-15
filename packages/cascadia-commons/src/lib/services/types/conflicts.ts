// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Wire types for merge-conflict detection and review — what the change-order
 * conflict endpoints return and the conflict UI renders. Declared apart from
 * `ConflictDetectionService` / `ChangeOrderMergeService` so the web package can
 * name them without reaching the server; both services re-export them.
 */

// ============================================
// Types
// ============================================

/**
 * Types of conflicts that can occur
 */
export type ConflictType =
  | 'checkout' // Item still checked out
  | 'concurrent_modification' // Same item modified on main since branch creation
  | 'field_conflict' // Same field modified differently on two branches
  | 'cross_eco' // Same item being modified by another active ECO
  | 'no_changes' // No changes to merge (warning, not blocking)
  | 'branch_not_found' // Invalid branch reference

/**
 * Severity levels for conflicts
 */
export type ConflictSeverity = 'error' | 'warning' | 'info'

/**
 * A field-level conflict between two versions
 */
export interface FieldConflict {
  fieldName: string
  fieldPath?: string
  baseValue: unknown // Value when branch was created
  ourValue: unknown // Value on our branch
  theirValue: unknown // Value on main/other branch
}

/**
 * A conflict on a specific item
 */
export interface ItemConflict {
  itemMasterId: string
  itemNumber: string
  itemName: string | null
  conflictType: ConflictType
  severity: ConflictSeverity

  // Our version (on the branch being checked)
  ourBranchItemId: string // The branchItem record ID (needed for API calls)
  ourItemId: string
  ourRevision: string
  ourBranchId: string
  ourBranchName: string

  // Their version (on main or conflicting branch)
  theirItemId?: string
  theirRevision?: string
  theirBranchId?: string
  theirBranchName?: string
  theirEcoId?: string
  theirEcoNumber?: string

  // Base version (common ancestor)
  baseItemId?: string
  baseRevision?: string

  // Field-level conflicts (if applicable)
  fieldConflicts: Array<FieldConflict>

  // Suggested resolution
  suggestedResolution?: 'rebase' | 'merge' | 'manual' | 'coordinate'
  resolutionNotes?: string
}

/**
 * Result of conflict detection for an ECO or branch
 */
export interface ConflictDetectionResult {
  hasConflicts: boolean
  hasBlockingConflicts: boolean // Conflicts that must be resolved before proceeding
  conflicts: Array<ItemConflict>
  checkedAt: Date
  summary: {
    total: number
    errors: number
    warnings: number
    info: number
  }
}

export interface MergeConflict {
  itemId: string
  itemNumber: string
  reason: string
  /** For concurrent modification conflicts */
  mainVersion?: string
  branchBase?: string
  conflictType?:
    'checkout' | 'concurrent_modification' | 'no_changes' | 'branch_not_found'
}
