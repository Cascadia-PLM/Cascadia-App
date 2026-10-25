// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { TourCompletionStore } from '../ports'

const TOUR_STORAGE_KEY = 'cascadia-tour-completed'

/** Persistence can fail without preventing dismissal in the current session. */
export function createBrowserCompletionStore(
  onError: (error: unknown) => void,
): TourCompletionStore {
  let completed = false
  let persistenceOverride: boolean | undefined
  const read = (key: string): string | null | undefined => {
    try {
      return localStorage.getItem(key)
    } catch (error) {
      onError(error)
      return undefined
    }
  }
  return {
    isCompleted() {
      if (persistenceOverride !== undefined) return persistenceOverride
      const stored = read(TOUR_STORAGE_KEY)
      if (stored !== undefined) completed = stored === 'true'
      return completed
    },
    record() {
      completed = true
      try {
        localStorage.setItem(TOUR_STORAGE_KEY, 'true')
        persistenceOverride = undefined
      } catch (error) {
        persistenceOverride = true
        onError(error)
      }
    },
    clear() {
      completed = false
      try {
        localStorage.removeItem(TOUR_STORAGE_KEY)
        persistenceOverride = undefined
      } catch (error) {
        persistenceOverride = false
        onError(error)
      }
    },
    isAutomaticStartSuppressed: () => read('cascadia-e2e-test') === 'true',
  }
}
