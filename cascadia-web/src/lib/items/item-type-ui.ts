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
import { ITEM_TYPE_DEFINITIONS } from '@cascadia/commons/lib/items/item-type-definitions'
import type { LucideIcon } from 'lucide-react'

/**
 * Detail-page base path per item type. Every registered type has a `$id`
 * route, and the path is declared on the definition so a new type cannot be
 * added without one — a type missing from this map was simply unlinkable,
 * and nothing said so.
 */
const ITEM_DETAIL_BASE_PATHS: Record<string, string> = Object.fromEntries(
  Object.values(ITEM_TYPE_DEFINITIONS).map((def) => [def.name, def.detailPath]),
)

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

// Lifecycle-state filter options are not built here. They come from the
// lifecycle definitions (`useItemStateOptions` in `@/lib/hooks`), not from
// the code-defined state lists on the item types, which are configuration's
// stale shadow: they offered states no item could hold and missed the ones
// it could.
