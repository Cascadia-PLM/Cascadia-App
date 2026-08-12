// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useState } from 'react'

/**
 * The value, held back until it has stopped changing for `delayMs`.
 *
 * Search boxes feed this to a query factory rather than debouncing a fetch
 * themselves: the query is keyed on the settled term, so typing produces one
 * request per pause instead of one per keystroke, and results already seen
 * come back from cache.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return settled
}
