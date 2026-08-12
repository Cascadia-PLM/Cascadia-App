// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Item type → RBAC resource mapping.
 *
 * The authoritative itemType → RBAC resource map, covering all 13 item
 * types. This used to be two separately-maintained maps in the items route
 * (one for create, one for update/delete) that drifted apart: between
 * them, Tool, TestPlan, TestCase, and WorkOrder mutations skipped the
 * permission check entirely. It now lives here so every consumer — the
 * REST routes, the AI chatbot tools, and the MCP server — shares one map.
 *
 * When adding an item type, add its row here (there is a test pinning
 * that every ITEM_TYPE_DEFINITIONS entry has an explicit mapping) and
 * grant the new resource in the role definitions.
 */

import type { ResourceType } from '@/lib/auth/permissions'

export const ITEM_TYPE_RESOURCES: Record<string, ResourceType> = {
  Part: 'parts',
  Document: 'documents',
  ChangeOrder: 'change_orders',
  Requirement: 'requirements',
  Task: 'tasks',
  TestPlan: 'test_plans',
  TestCase: 'test_cases',
  WorkInstruction: 'work_instructions',
  Issue: 'issues',
  Tool: 'tools',
  Software: 'software',
  WorkOrder: 'work_orders',
  PhysicalPart: 'physical_parts',
}

/**
 * Map an item type to its RBAC resource. Unknown types fail toward the
 * parts permission rather than skipping the check.
 */
export function getResourceType(itemType: string): ResourceType {
  return ITEM_TYPE_RESOURCES[itemType] ?? 'parts'
}

/** Map an item type to its RBAC resource, or null when unknown. */
export function itemTypeToResource(itemType: string): ResourceType | null {
  return ITEM_TYPE_RESOURCES[itemType] ?? null
}
