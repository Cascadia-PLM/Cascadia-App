import type { ChangeAction } from '@/lib/types/lifecycle'

/**
 * Get the default change action based on the item's current lifecycle state.
 * Matches lifecycle changeActionMappings.
 */
export function getDefaultChangeAction(state: string): ChangeAction {
  if (state === 'Draft') return 'release'
  if (state === 'Released') return 'revise'
  if (state === 'InReview') return 'release'
  return 'obsolete'
}

/**
 * Simple revision increment: A -> B, B -> C, etc.
 * Falls back to appending .1 or incrementing a numeric suffix.
 */
export function incrementRevision(rev: string): string {
  if (/^[A-Z]$/.test(rev)) {
    return String.fromCharCode(rev.charCodeAt(0) + 1)
  }
  const match = rev.match(/^(.*)\.(\d+)$/)
  if (match) {
    return `${match[1]}.${parseInt(match[2]) + 1}`
  }
  return `${rev}.1`
}

/**
 * Calculate target state and revision based on the chosen change action.
 */
export function getTargetInfo(
  state: string,
  revision: string,
  action: ChangeAction,
): { targetState: string; targetRevision: string } {
  switch (action) {
    case 'release':
      if (!revision || revision === 'DRAFT' || revision.startsWith('-')) {
        return { targetState: 'Released', targetRevision: 'A' }
      }
      return { targetState: 'Released', targetRevision: revision }
    case 'revise':
      return {
        targetState: 'Released',
        targetRevision: incrementRevision(revision),
      }
    case 'obsolete':
      return { targetState: 'Obsolete', targetRevision: revision }
    case 'promote':
      return { targetState: state, targetRevision: revision } // Actual target resolved server-side from phase config
    default:
      return { targetState: state, targetRevision: revision }
  }
}

/**
 * Get available change actions for an item based on its current state.
 */
export function getAvailableActions(
  state: string,
): Array<{ value: ChangeAction; label: string; description?: string }> {
  const actions: Array<{
    value: ChangeAction
    label: string
    description?: string
  }> = []

  if (state === 'Draft') {
    actions.push({
      value: 'release',
      label: 'Release',
      description: 'First release to production',
    })
  }
  if (state === 'Released') {
    actions.push({
      value: 'revise',
      label: 'Revise',
      description: 'Create new revision',
    })
    actions.push({
      value: 'obsolete',
      label: 'Obsolete',
      description: 'End-of-life this item',
    })
  }
  if (state === 'InReview') {
    actions.push({
      value: 'release',
      label: 'Release',
      description: 'Release after review',
    })
  }

  return actions
}
