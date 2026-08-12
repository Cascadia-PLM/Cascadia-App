// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Badge } from '@/components/ui'
import { getStateBadgeVariant } from '@/components/bom/helpers'
import { useLifecyclePhases } from '@/lib/hooks/useLifecyclePhases'

interface StateBadgeProps {
  itemType?: string
  state: string | null | undefined
  className?: string
}

/**
 * A lifecycle state's configured colour, mapped onto the badge variants.
 *
 * Preferred over matching the state's name, so a lifecycle free to name its
 * states anything still gets meaningful colours. The name-based fallback only
 * applies when a state declares no colour.
 */
const VARIANT_BY_LIFECYCLE_COLOR: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'
> = {
  green: 'success',
  red: 'destructive',
  yellow: 'warning',
  orange: 'warning',
  gray: 'secondary',
  slate: 'secondary',
  blue: 'default',
  indigo: 'default',
  purple: 'default',
  cyan: 'default',
}

/**
 * Renders an item's lifecycle state by display name (WI-6.4).
 *
 * `items.state` stores the state ID (WI-5.2); the per-item-type lifecycle
 * cache resolves it to the configured display name and colour. Seeded
 * lifecycles keep id === name, so this only changes what renders when they
 * differ. Falls back to the raw value when no lifecycle or matching state
 * exists.
 */
export function StateBadge({ itemType, state, className }: StateBadgeProps) {
  const { data } = useLifecyclePhases(itemType)

  if (!state) return null

  const match = data?.states.find((s) => s.id === state || s.name === state)
  const variant = match?.color
    ? (VARIANT_BY_LIFECYCLE_COLOR[match.color] ?? 'default')
    : getStateBadgeVariant(match?.id ?? state)

  return (
    <Badge variant={variant} className={className}>
      {match?.name ?? state}
    </Badge>
  )
}
