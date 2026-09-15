// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Item type → RBAC resource mapping.
 *
 * Derived from `ITEM_TYPE_DEFINITIONS`, so a type cannot exist without a
 * resource: the definition does not typecheck without one. This used to be
 * two separately-maintained maps in the items route (one for create, one for
 * update/delete) that drifted apart — between them, Tool, TestPlan, TestCase
 * and WorkOrder mutations skipped the permission check entirely — and then
 * one hand-kept map here, which a test had to pin against the definitions.
 * Now every consumer (the REST routes, the AI chatbot tools, the MCP server)
 * reads the same derivation.
 *
 * When adding an item type, name its `resource` in the definition and grant
 * that resource in the role definitions.
 */

import { ITEM_TYPE_DEFINITIONS } from './item-type-definitions'
import type { ResourceType } from '@/lib/auth/permissions'

export const ITEM_TYPE_RESOURCES: Record<string, ResourceType> =
  Object.fromEntries(
    Object.values(ITEM_TYPE_DEFINITIONS).map((def) => [def.name, def.resource]),
  )

/**
 * Map an item type to its RBAC resource.
 *
 * The single lookup, and it fails closed: an unknown type is charged the
 * `parts` permission rather than skipping the check. There used to be a
 * second function returning `null` for an unknown type, and the eight call
 * sites that used it guarded with `if (resource)` — which skips the
 * permission check altogether for anything it cannot map. The two differed
 * only in that failure mode, and the comments on the migrated routes called
 * the null one a bug.
 */
export function getResourceType(itemType: string): ResourceType {
  return ITEM_TYPE_RESOURCES[itemType] ?? 'parts'
}
