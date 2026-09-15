// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { LifecycleType } from './types'

/**
 * The lifecycle type an input names, or `Free` when it names none.
 *
 * A stored definition's kind is its `lifecycle_type` column, NOT NULL since
 * migration 0006 (remediation plan CM-26); nothing reads a stored copy from
 * the JSONB any more, because there is none. This helper is for the inputs
 * that may leave the kind unsaid — a create body, a seed object — and for
 * code that is handed a definition and asks which kind it is.
 */
export function resolveLifecycleType(definition: {
  lifecycleType?: LifecycleType | string | null
}): LifecycleType {
  if (
    definition.lifecycleType === 'Free' ||
    definition.lifecycleType === 'Driven' ||
    definition.lifecycleType === 'Driving'
  ) {
    return definition.lifecycleType
  }
  return 'Free'
}

/**
 * Driving lifecycles (change-order workflows) carry the strictest transition
 * semantics — completed instances are terminal, final states require
 * finalKind, and completing them runs the release orchestration.
 */
export function isDrivingDefinition(definition: {
  lifecycleType?: LifecycleType | string | null
}): boolean {
  return resolveLifecycleType(definition) === 'Driving'
}
