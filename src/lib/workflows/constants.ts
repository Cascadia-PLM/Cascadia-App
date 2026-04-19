/**
 * Workflow Constants
 *
 * Common workflow state names and configuration values used throughout the application.
 * These constants help prevent magic strings and ensure consistency.
 *
 * Note: For transition logic, prefer using the `isFinal` and `isInitial` flags
 * on workflow states rather than checking state names directly. This supports
 * flexible workflows with custom state names.
 */

/**
 * Standard workflow state names.
 *
 * These are the default names used by the standard workflows.
 * Custom workflows may use different names but similar concepts.
 */
export const WORKFLOW_STATE_NAMES = {
  /** Initial state for new items */
  DRAFT: 'Draft',
  /** Item is being reviewed */
  IN_REVIEW: 'In Review',
  /** Item has been reviewed and approved */
  APPROVED: 'Approved',
  /** Item has been released to production (final state) */
  RELEASED: 'Released',
  /** Item was rejected during review */
  REJECTED: 'Rejected',
  /** Preliminary state for early design phase */
  PRELIMINARY: 'Preliminary',
  /** Item is under review (ECO workflow) */
  UNDER_REVIEW: 'Under Review',
} as const

export type WorkflowStateName =
  (typeof WORKFLOW_STATE_NAMES)[keyof typeof WORKFLOW_STATE_NAMES]

/**
 * Standard workflow state IDs.
 *
 * These IDs are used in the default workflow definitions.
 */
export const WORKFLOW_STATE_IDS = {
  DRAFT: 'draft',
  IN_REVIEW: 'in-review',
  APPROVED: 'approved',
  RELEASED: 'released',
  REJECTED: 'rejected',
  PRELIMINARY: 'preliminary',
  UNDER_REVIEW: 'under-review',
} as const

export type WorkflowStateId =
  (typeof WORKFLOW_STATE_IDS)[keyof typeof WORKFLOW_STATE_IDS]

/**
 * Standard workflow colors for state display.
 */
export const WORKFLOW_STATE_COLORS = {
  DRAFT: 'gray',
  IN_REVIEW: 'yellow',
  APPROVED: 'green',
  RELEASED: 'blue',
  REJECTED: 'red',
  PRELIMINARY: 'purple',
  UNDER_REVIEW: 'orange',
} as const

/**
 * Default workflow definition IDs.
 */
export const DEFAULT_WORKFLOWS = {
  /** Standard part lifecycle workflow */
  PART_LIFECYCLE: 'part-lifecycle',
  /** Standard document lifecycle workflow */
  DOCUMENT_LIFECYCLE: 'document-lifecycle',
  /** Engineering Change Order workflow */
  ECO_WORKFLOW: 'eco-workflow',
  /** Flexible Change Order workflow (XCO) */
  FLEXIBLE_ECO_WORKFLOW: 'flexible-eco-workflow',
} as const
