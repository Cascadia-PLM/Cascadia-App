// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { getItemDetailPath } from '@/lib/items/item-type-ui'

interface ItemLinkProps {
  itemType: string
  itemId: string
  className?: string
  /** Search params carried onto the detail route (e.g. the ECO branch). */
  search?: Record<string, unknown>
  target?: string
  children: ReactNode
}

/**
 * Link to an item's detail page — or plain text when its type has none.
 *
 * The point is the fallback it *refuses* to make. Callers used to guess a
 * route (`itemType.toLowerCase() + 's'`) or default to `/parts/:id`, which
 * sent Software to a dead `/softwares/:id` and unmapped types to a parts
 * page rendered against a foreign id. An unroutable type renders unlinked
 * instead, so a missing route looks missing rather than wrong.
 */
export function ItemLink({
  itemType,
  itemId,
  className,
  search,
  target,
  children,
}: ItemLinkProps) {
  const to = getItemDetailPath(itemType, itemId)
  if (!to) return <span className={className}>{children}</span>
  return (
    <Link to={to} search={search} target={target} className={className}>
      {children}
    </Link>
  )
}
