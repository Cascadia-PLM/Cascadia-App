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
 * Tailwind classes for a lifecycle colour name, for raw-span renderers (graph
 * and thread nodes) that do not use the Badge primitive. Neutral when a state
 * declares no colour.
 */
const CLASSES_BY_LIFECYCLE_COLOR: Record<string, string> = {
  green: 'bg-green-200 dark:bg-green-900/50 text-green-800 dark:text-green-200',
  emerald:
    'bg-emerald-200 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200',
  red: 'bg-red-200 dark:bg-red-900/50 text-red-700 dark:text-red-300',
  yellow:
    'bg-yellow-200 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-200',
  orange:
    'bg-orange-200 dark:bg-orange-900/50 text-orange-800 dark:text-orange-200',
  blue: 'bg-blue-200 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300',
  cyan: 'bg-cyan-200 dark:bg-cyan-900/50 text-cyan-800 dark:text-cyan-200',
  indigo:
    'bg-indigo-200 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-200',
  purple:
    'bg-purple-200 dark:bg-purple-900/50 text-purple-800 dark:text-purple-200',
  gray: 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300',
  slate: 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300',
}
const NEUTRAL_STATE_CLASSES =
  'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'

/**
 * A state's configured display name and colour classes, for components that
 * render state as a raw span. Resolves through the same per-item-type
 * lifecycle cache as StateBadge; falls back to the raw value and neutral
 * classes while loading or when the lifecycle names no such state.
 */
export function useLifecycleState(
  itemType: string | undefined,
  state: string | null | undefined,
): { label: string; className: string } {
  const { data } = useLifecyclePhases(itemType)
  const match = state
    ? data?.states.find((s) => s.id === state || s.name === state)
    : undefined
  return {
    label: match?.name ?? state ?? '',
    className: match?.color
      ? (CLASSES_BY_LIFECYCLE_COLOR[match.color] ?? NEUTRAL_STATE_CLASSES)
      : NEUTRAL_STATE_CLASSES,
  }
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
