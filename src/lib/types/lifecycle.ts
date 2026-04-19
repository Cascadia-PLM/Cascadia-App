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
 * Configurable revision scheme for lifecycle definitions.
 * Determines how revision identifiers are generated when items are released/revised.
 *
 * - alpha: A, B, C, ..., Z, AA, AB, ... (default, traditional PLM)
 * - numeric: 1, 2, 3, ... (common for prototype/pre-production)
 * - prefixed-numeric: X1, X2, X3, ... (prefix + numeric, e.g., prototype revisions)
 * - none: No revision tracking (revision stays unchanged)
 */
export type RevisionScheme =
  | { type: 'alpha'; uppercase?: boolean }
  | { type: 'numeric' }
  | { type: 'prefixed-numeric'; prefix: string }
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
export type ChangeAction =
  | 'release'
  | 'revise'
  | 'obsolete'
  | 'add'
  | 'remove'
  | 'promote'

/**
 * Configuration for state-changing actions (release, obsolete).
 * These actions transition an item from one state to another.
 */
export interface StateChangeActionMapping {
  /** State the item must be in to apply this action */
  fromState: string

  /** State the item transitions to */
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
 * Note: 'add' and 'remove' don't need mappings - they manage
 * BOM/reference relationships without affecting item lifecycle state.
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
