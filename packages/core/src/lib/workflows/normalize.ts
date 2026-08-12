// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { DefinitionType, LifecycleType } from './types'

/**
 * The single place the legacy `definitionType` shape is interpreted
 * (remediation WI-3.1 / WI-3.3).
 *
 * `lifecycleType` (Free / Driven / Driving) is the authoritative model.
 * `definitionType` survives only as a read-only legacy input to this
 * inference, for definitions that predate the unified model: 'lifecycle'
 * meant a Driven item lifecycle, 'workflow' meant a Driving change-order
 * workflow. Nothing outside this module may branch on `definitionType`.
 */
export function resolveLifecycleType(definition: {
  lifecycleType?: LifecycleType | string | null
  definitionType?: DefinitionType | string
}): LifecycleType {
  if (
    definition.lifecycleType === 'Free' ||
    definition.lifecycleType === 'Driven' ||
    definition.lifecycleType === 'Driving'
  ) {
    return definition.lifecycleType
  }
  if (definition.definitionType === 'lifecycle') return 'Driven'
  if (definition.definitionType === 'workflow') return 'Driving'
  return 'Free'
}

/**
 * Resolve the lifecycle type of a STORED definition row.
 *
 * The JSONB is the writer's voice and speaks first: explicit lifecycleType,
 * else the legacy definitionType inference. The column is consulted only
 * when the JSONB says nothing at all — `ADD COLUMN ... DEFAULT 'Free'`
 * backfilled legacy rows with a lie (old 'workflow' definitions are Driving,
 * not Free), so a bare column value must never outvote JSONB evidence.
 * Post-model writers set both, so for them the two always agree.
 */
export function resolveStoredLifecycleType(
  columnValue: string | null | undefined,
  definition: {
    lifecycleType?: LifecycleType | string | null
    definitionType?: DefinitionType | string
  },
): LifecycleType {
  if (definition.lifecycleType || definition.definitionType) {
    return resolveLifecycleType(definition)
  }
  return resolveLifecycleType({ lifecycleType: columnValue })
}

/**
 * Driving lifecycles (change-order workflows) carry the strictest transition
 * semantics — completed instances are terminal, final states require
 * finalKind, and completing them runs the release orchestration.
 */
export function isDrivingDefinition(definition: {
  lifecycleType?: LifecycleType | string | null
  definitionType?: DefinitionType | string
}): boolean {
  return resolveLifecycleType(definition) === 'Driving'
}
