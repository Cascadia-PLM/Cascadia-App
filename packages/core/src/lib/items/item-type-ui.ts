// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Client-side UI metadata for item types: detail-route paths, icons, and
 * filter options — complete for all 13 registered types.
 *
 * Before this module, every consumer hand-rolled its own partial map
 * (EnterpriseSearchBar, BOM helpers, thread nodes each covered ~5 of 13
 * types and silently misrouted or fell back for the rest). Import from here
 * instead of duplicating.
 */

import {
  AlertTriangle,
  CheckSquare,
  ClipboardCheck,
  ClipboardList,
  Cpu,
  Factory,
  FileText,
  GitBranch,
  ListChecks,
  Package,
  Search,
  TestTube2,
  Wrench,
} from 'lucide-react'
import { ITEM_TYPE_DEFINITIONS } from './item-type-definitions'
import type { LucideIcon } from 'lucide-react'

/** Detail-page base path per item type. Every registered type has a `$id` route. */
const ITEM_DETAIL_BASE_PATHS: Record<string, string> = {
  Part: '/parts',
  Document: '/documents',
  Requirement: '/requirements',
  ChangeOrder: '/change-orders',
  Task: '/tasks',
  TestPlan: '/test-plans',
  TestCase: '/test-cases',
  Issue: '/issues',
  WorkInstruction: '/work-instructions',
  Software: '/software',
  Tool: '/tools',
  WorkOrder: '/work-orders',
  PhysicalPart: '/physical-parts',
}

/** Detail-page path for an item, or null for an unregistered type. */
export function getItemDetailPath(
  itemType: string,
  itemId: string,
): string | null {
  const base = ITEM_DETAIL_BASE_PATHS[itemType]
  return base ? `${base}/${itemId}` : null
}

/**
 * Detail-route *pattern* (`/parts/$id`) for a type, or null if unregistered.
 * For `<Link to={pattern} params={{ id }}>`; use `getItemDetailPath` when you
 * want the interpolated href instead.
 */
export function getItemDetailRoutePattern(itemType: string): string | null {
  const base = ITEM_DETAIL_BASE_PATHS[itemType]
  return base ? `${base}/$id` : null
}

/** Icon components keyed by the icon *name* the item type definitions carry. */
const ICONS_BY_NAME: Record<string, LucideIcon> = {
  Package,
  FileText,
  ListChecks,
  CheckSquare,
  GitBranch,
  ClipboardList,
  TestTube2,
  AlertTriangle,
  ClipboardCheck,
  Cpu,
  Wrench,
  Factory,
}

/** Resolve an icon name from an item type definition to its component. */
export function getItemTypeIconByName(iconName: string): LucideIcon {
  return ICONS_BY_NAME[iconName] ?? Search
}

/** Icon component for an item type. */
export function getItemTypeIcon(itemType: string): LucideIcon {
  const def = ITEM_TYPE_DEFINITIONS[itemType]
  return def ? getItemTypeIconByName(def.icon) : Search
}

/** Display label for an item type (falls back to the raw type name). */
export function getItemTypeLabel(itemType: string): string {
  return ITEM_TYPE_DEFINITIONS[itemType]?.label ?? itemType
}

/** Filter-dropdown options covering every registered item type. */
export const ITEM_TYPE_OPTIONS: Array<{ label: string; value: string }> =
  Object.values(ITEM_TYPE_DEFINITIONS).map((def) => ({
    label: def.label,
    value: def.name,
  }))

/**
 * Filter-dropdown options for lifecycle state: the union of every state id
 * across all item types, in first-seen definition order.
 */
export const ITEM_STATE_OPTIONS: Array<{ label: string; value: string }> =
  (() => {
    const seen = new Set<string>()
    const options: Array<{ label: string; value: string }> = []
    for (const def of Object.values(ITEM_TYPE_DEFINITIONS)) {
      for (const state of def.states) {
        if (seen.has(state.id)) continue
        seen.add(state.id)
        options.push({ label: state.name, value: state.id })
      }
    }
    return options
  })()
