// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { invalidateResources } from './invalidation'
import type {
  UseMutationOptions,
  UseMutationResult,
} from '@tanstack/react-query'
import type { Resource } from './keys'

/**
 * Refresh everything affected by a mutation.
 *
 * This is the standard post-mutation call and the replacement for bare
 * `router.invalidate()`. It does two things, and both are needed:
 *
 *  - invalidates the React Query cache for the named resources and their
 *    dependents, so *unmounted* pages refetch when you next navigate to them
 *    (the fix for "created a Design, list still shows the old rows");
 *  - re-runs the active route loaders, so data a loader derives outside the
 *    query cache is rebuilt.
 *
 * Since loaders read through `ensureQueryData` against this same cache, the
 * first step is what actually forces the network call; the second just makes
 * the current page rebuild from it.
 *
 * @example
 * const invalidate = useInvalidateResources()
 * await apiFetch('/api/v1/designs', { method: 'POST', body })
 * await invalidate('designs')
 */
export function useInvalidateResources() {
  const queryClient = useQueryClient()
  const router = useRouter()

  return useCallback(
    async (...resources: Array<Resource>) => {
      await invalidateResources(queryClient, resources)
      await router.invalidate()
    },
    [queryClient, router],
  )
}

export interface ResourceMutationOptions<
  TData,
  TError,
  TVariables,
  TContext,
> extends Omit<
  UseMutationOptions<TData, TError, TVariables, TContext>,
  'onSuccess'
> {
  /**
   * Resources this mutation writes to. Their dependents are invalidated too
   * — see `RESOURCE_DEPENDENTS` in `./invalidation`.
   */
  invalidates: ReadonlyArray<Resource>
  /**
   * Runs *after* invalidation has been registered, so a navigation performed
   * here lands on a page that is already refetching rather than one showing
   * the pre-mutation cache.
   */
  onSuccess?: (
    data: TData,
    variables: TVariables,
    context: TContext | undefined,
  ) => unknown
}

/**
 * `useMutation` with invalidation wired in, so no call site has to remember
 * which caches its write touches.
 *
 * Prefer this over a hand-rolled `useMutation` for anything that writes.
 */
export function useResourceMutation<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>(
  options: ResourceMutationOptions<TData, TError, TVariables, TContext>,
): UseMutationResult<TData, TError, TVariables, TContext> {
  const queryClient = useQueryClient()
  const router = useRouter()
  const { invalidates, onSuccess, ...rest } = options

  return useMutation<TData, TError, TVariables, TContext>({
    ...rest,
    onSuccess: async (data, variables, context) => {
      await invalidateResources(queryClient, invalidates)
      await router.invalidate()
      await onSuccess?.(data, variables, context)
    },
  })
}
