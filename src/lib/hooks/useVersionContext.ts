import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'

/**
 * Version context types for resolving items
 */
export type VersionContextType = 'main' | 'branch' | 'tag' | 'commit'

/**
 * Version context - identifies which version of items to display
 */
export interface VersionContext {
  type: VersionContextType
  branchId?: string // For branch contexts
  branchName?: string // Human-readable branch name
  tagId?: string // For tag contexts
  tagName?: string // Human-readable tag name
  commitId?: string // For commit contexts
}

/**
 * URL search params for version context
 */
interface VersionSearchParams {
  branch?: string // Branch ID
  branchName?: string // Branch name (for display)
  tag?: string // Tag ID
  tagName?: string // Tag name (for display)
  commit?: string // Commit ID
}

/**
 * Parse URL search params into VersionContext
 */
export function parseVersionContext(
  searchParams: VersionSearchParams,
): VersionContext {
  if (searchParams.commit) {
    return { type: 'commit', commitId: searchParams.commit }
  }
  if (searchParams.tag) {
    return {
      type: 'tag',
      tagId: searchParams.tag,
      tagName: searchParams.tagName,
    }
  }
  if (searchParams.branch) {
    return {
      type: 'branch',
      branchId: searchParams.branch,
      branchName: searchParams.branchName,
    }
  }
  // Default to main
  return { type: 'main' }
}

/**
 * Serialize VersionContext to URL search params
 */
export function serializeVersionContext(
  context: VersionContext,
): Record<string, string | undefined> {
  switch (context.type) {
    case 'commit':
      return {
        branch: undefined,
        branchName: undefined,
        tag: undefined,
        tagName: undefined,
        commit: context.commitId,
      }
    case 'tag':
      return {
        branch: undefined,
        branchName: undefined,
        tag: context.tagId,
        tagName: context.tagName,
        commit: undefined,
      }
    case 'branch':
      return {
        branch: context.branchId,
        branchName: context.branchName,
        tag: undefined,
        tagName: undefined,
        commit: undefined,
      }
    case 'main':
    default:
      return {
        branch: undefined,
        branchName: undefined,
        tag: undefined,
        tagName: undefined,
        commit: undefined,
      }
  }
}

/**
 * Get a human-readable label for a version context
 */
export function getVersionContextLabel(context: VersionContext): string {
  switch (context.type) {
    case 'commit':
      return context.commitId
        ? `Commit ${context.commitId.slice(0, 8)}`
        : 'Commit'
    case 'tag':
      return context.tagName || context.tagId?.slice(0, 8) || 'Tag'
    case 'branch':
      return context.branchName || context.branchId?.slice(0, 8) || 'Branch'
    case 'main':
    default:
      return 'Released (main)'
  }
}

/**
 * Options for useVersionContext hook
 */
export interface UseVersionContextOptions {
  designId?: string
  /**
   * Whether main branch is protected (has released items).
   * When true, main branch is read-only and edits must be on ECO/workspace branches.
   */
  isMainProtected?: boolean
}

/**
 * Hook for managing version context in URL
 *
 * @param options - Hook options including designId and protection status
 * @returns Version context state and setters
 */
export function useVersionContext(
  options: UseVersionContextOptions | string | undefined,
) {
  // Support both old signature (string) and new signature (options object)
  const { designId, isMainProtected = false } =
    typeof options === 'string'
      ? { designId: options, isMainProtected: false }
      : (options ?? { designId: undefined, isMainProtected: false })

  const navigate = useNavigate()
  const searchParams = useSearch({ strict: false })

  // Parse current context from URL
  const context = useMemo(() => {
    if (!designId) {
      return { type: 'main' as const }
    }
    return parseVersionContext(searchParams)
  }, [designId, searchParams])

  // Get human-readable label
  const contextLabel = useMemo(() => getVersionContextLabel(context), [context])

  // Check if context is editable
  // Main is only editable in pre-release phase (when not protected)
  // Branches are editable (ECO, workspace)
  // Tags and commits are always read-only
  const isEditable = useMemo(() => {
    // Main is only editable if not protected
    if (context.type === 'main') return !isMainProtected
    // Branches are editable (ECO, workspace)
    if (context.type === 'branch') return true
    // Tags and commits are read-only
    return false
  }, [context, isMainProtected])

  // Check if viewing a historical (read-only) state
  const isHistoricalView = useMemo(() => {
    return context.type === 'tag' || context.type === 'commit'
  }, [context])

  // Set new context
  const setContext = useCallback(
    (newContext: VersionContext) => {
      const params = serializeVersionContext(newContext)
      // Use type assertion for the navigate options since this hook is route-agnostic
      // and TanStack Router's strict typing requires knowing the specific route
      void navigate({
        search: { ...searchParams, ...params },
      } as Parameters<typeof navigate>[0])
    },
    [navigate, searchParams],
  )

  // Convenience methods
  const setMainContext = useCallback(() => {
    setContext({ type: 'main' })
  }, [setContext])

  const setBranchContext = useCallback(
    (branchId: string, branchName?: string) => {
      setContext({ type: 'branch', branchId, branchName })
    },
    [setContext],
  )

  const setTagContext = useCallback(
    (tagId: string, tagName?: string) => {
      setContext({ type: 'tag', tagId, tagName })
    },
    [setContext],
  )

  const setCommitContext = useCallback(
    (commitId: string) => {
      setContext({ type: 'commit', commitId })
    },
    [setContext],
  )

  // Build query params for API calls
  const apiParams = useMemo(() => {
    const params: Record<string, string> = {}
    if (designId) params.designId = designId
    if (context.branchId) params.branch = context.branchId
    if (context.tagId) params.tag = context.tagId
    if (context.commitId) params.commit = context.commitId
    return params
  }, [designId, context])

  // Build query string for API calls
  const apiQueryString = useMemo(() => {
    const params = new URLSearchParams()
    Object.entries(apiParams).forEach(([key, value]) => {
      if (value) params.set(key, value)
    })
    return params.toString()
  }, [apiParams])

  // Determine if this is a protected (post-release) design
  const requiresEcoBranch = isMainProtected

  // Determine the current phase
  const phase = isMainProtected ? 'post-release' : 'pre-release'

  return {
    // Current context
    context,
    contextLabel,
    isEditable,
    isHistoricalView,

    // Context setters
    setContext,
    setMainContext,
    setBranchContext,
    setTagContext,
    setCommitContext,

    // API helpers
    apiParams,
    apiQueryString,

    // Is context active (design selected)
    isActive: !!designId,

    // Protection status
    isMainProtected,
    requiresEcoBranch,
    phase,
  }
}
