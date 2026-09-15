// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Lifecycle types for item state management through ECOs
 *
 * Key principle: All item state changes go through ECOs.
 * Lifecycles define states and how change actions affect those states.
 * Unlike workflows, lifecycles have no manual transitions.
 */

// ============================================
// Revision Schemes
// ============================================

/**
 * The revision a released item carries under the `none` scheme.
 *
 * `none` means "released, but the revision never advances" — it does not mean
 * "unreleased". The marker has to be a real, non-empty revision string for
 * that distinction to survive the released-item queries: the empty string is
 * read as a working marker by both `RevisionService.isWorkingRevision` and its
 * SQL counterpart `notWorkingRevision()`, so an item released at `''` is
 * invisible to every released-item fallback (`VersionResolver`, design
 * baselines) — released in name and unreleased in every query.
 *
 * Constrained by the database, not by taste: `items.revision` is
 * `varchar(10)`, `ck_items_revision_working_marker` rejects any value starting
 * with '-' that is not '-' or '-{8 hex}', and 'DRAFT'/'' are the legacy
 * working markers. 'N/A' satisfies all of that and reads correctly in a
 * revision column.
 *
 * Lives here rather than on `RevisionService` so the client-side scheme
 * selector can show the real marker without importing server code;
 * `RevisionService.NO_REVISION` re-exports it for server callers.
 */
export const NO_REVISION_MARKER = 'N/A'

/**
 * What an unreleased working copy is *shown* as, everywhere in the UI.
 *
 * Storage cannot use one fixed marker: the items unique constraint is
 * (item_number, revision, design_id, item_type), so a working copy on a branch
 * carries `-{branchId8}` (see `RevisionService.getWorkingRevision`) to keep two
 * branches' copies of the same item apart. That branch id is an implementation
 * detail of the constraint, not a revision, and rendering it puts a string like
 * '-01704247' in a Rev column. Every read-only revision display runs through
 * `formatRevision` so the user sees this instead.
 */
export const UNRELEASED_REVISION_DISPLAY = '-'

/**
 * Whether a revision marks an unreleased working copy rather than a real
 * released revision. Covers the branch placeholder, the historical 'DRAFT'
 * and '-' markers, and empty values.
 *
 * `NO_REVISION_MARKER` is deliberately *not* one of these — it is a released
 * revision that never advances.
 *
 * Lives here rather than on `RevisionService` for the same reason
 * `NO_REVISION_MARKER` does: the UI needs it and must not import server code.
 * `RevisionService.isWorkingRevision` delegates here so the two cannot drift.
 */
export function isWorkingRevisionValue(
  revision: string | null | undefined,
): boolean {
  if (!revision) return true
  return revision === 'DRAFT' || revision.startsWith('-')
}

/**
 * The revision to render for an item. Released revisions pass through
 * unchanged; anything unreleased renders as `UNRELEASED_REVISION_DISPLAY`.
 *
 * Display only — never write the result back, and never use it to identify a
 * version. The stored placeholder is what scopes a working copy to its branch.
 */
export function formatRevision(revision: string | null | undefined): string {
  // `!revision` is redundant with the predicate and there to narrow the type:
  // a plain call leaves `revision` nullable for the return below.
  if (!revision || isWorkingRevisionValue(revision)) {
    return UNRELEASED_REVISION_DISPLAY
  }
  return revision
}

/**
 * Configurable revision scheme for lifecycle definitions.
 * Determines how revision identifiers are generated when items are released/revised.
 *
 * - alpha: A, B, C, ..., Z, AA, AB, ... (default, traditional PLM)
 * - numeric: 1, 2, 3, ... (common for prototype/pre-production)
 * - prefixed-numeric: X1, X2, X3, ... (prefix + numeric, e.g., prototype revisions)
 *
 * Both numeric schemes take an optional `startAt` for the first released
 * revision. It defaults to 1 for compatibility; `startAt: 0` gives 0, 1, 2
 * or R0, R1, R2.
 * - none: No revision tracking — a released item sits at the fixed
 *   `NO_REVISION_MARKER` and stays there. Valid only for lifecycles that
 *   update items in place (Free, and phase-level `promote` overrides): a
 *   Driven lifecycle mints a new version row per release and two versions of
 *   one item cannot share a revision, so `LifecycleDefinitionService.validateDefinition`
 *   refuses that combination.
 */
export type RevisionScheme =
  | { type: 'alpha'; uppercase?: boolean }
  | { type: 'numeric'; startAt?: number }
  | { type: 'prefixed-numeric'; prefix: string; startAt?: number }
  | { type: 'none' }

// ============================================
// Lifecycle Phases
// ============================================

/**
 * Configuration for a lifecycle phase.
 * Phases group lifecycle states into logical stages (e.g., Prototype, Production).
 * Each phase can override the lifecycle-level revision scheme.
 */
export interface LifecyclePhaseConfig {
  id: string
  name: string
  /** Phase-level revision scheme override */
  revisionScheme?: RevisionScheme
  /** Whether to reset revision numbering when entering this phase */
  resetRevisionOnEntry?: boolean
  color?: string
  /** Display order for phases */
  order: number
}

// ============================================
// Change Actions
// ============================================

/**
 * Core change actions that can be performed on items through an ECO.
 * Each action triggers a specific state transition defined in the lifecycle's changeActionMappings.
 */
export type ChangeAction = 'release' | 'revise' | 'obsolete' | 'promote'

/**
 * Configuration for state-changing actions (release, obsolete).
 * These actions transition an item from one state to another.
 *
 * All state references in mappings are **state IDs** (WI-5.1) — display
 * names are never used for matching, and definition save rejects mappings
 * that reference anything other than an existing state ID
 * (MAPPING_UNKNOWN_STATE).
 */
export interface StateChangeActionMapping {
  /** State ID the item must be in to apply this action */
  fromState: string

  /** State ID the item transitions to */
  toState: string

  /** Whether this action assigns a revision letter (e.g., A, B, C) */
  assignsRevision: boolean
}

/**
 * Configuration for the revise action (special case - creates new version).
 * Revise creates a new item version while updating the old version's state.
 */
export interface ReviseActionMapping {
  /** State the item must be in (typically "Released") */
  fromState: string

  /** State for the NEW version (typically "Released") */
  newVersionState: string

  /** State for the OLD version (typically "Superseded") */
  oldVersionState: string

  /** Always true for revise - new revisions get revision letters */
  assignsRevision: true
}

/**
 * Configuration for the promote action.
 * Promote transitions an item across lifecycle phase boundaries
 * (e.g., from Prototype to Production).
 */
export interface PromoteActionMapping {
  /** State the item must be in to apply this action */
  fromState: string

  /** State the item transitions to */
  toState: string

  /** Whether this action assigns a revision */
  assignsRevision: boolean

  /** Override phase-level resetRevisionOnEntry */
  resetRevision?: boolean
}

/**
 * Complete change action mappings for a lifecycle.
 * Defines how each change action affects item state.
 *
 * Every action here changes state. BOM membership is not a change action —
 * it is a branch edit that the merge releases with the rest of the branch.
 */
export interface ChangeActionMappings {
  /** First release of a new item (Draft → Released) */
  release?: StateChangeActionMapping

  /** Create new revision of released item */
  revise?: ReviseActionMapping

  /** End-of-life an item (Released → Obsolete) */
  obsolete?: StateChangeActionMapping

  /** Promote item across phase boundaries (e.g., Prototype → Production) */
  promote?: PromoteActionMapping
}

/**
 * Result of validating whether an action can be applied
 */
export interface ActionValidationResult {
  valid: boolean
  error?: string
}

/**
 * Example lifecycle configuration for reference:
 *
 * const partLifecycle: ChangeActionMappings = {
 *   release: {
 *     fromState: 'Draft',
 *     toState: 'Released',
 *     assignsRevision: true,
 *   },
 *   revise: {
 *     fromState: 'Released',
 *     newVersionState: 'Released',
 *     oldVersionState: 'Superseded',
 *     assignsRevision: true,
 *   },
 *   obsolete: {
 *     fromState: 'Released',
 *     toState: 'Obsolete',
 *     assignsRevision: false,
 *   },
 * }
 */
