// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { collectionQuery } from './entities'
import type { WorkflowDefinition } from '@/lib/workflows/types'

/**
 * Every workflow definition — item lifecycles and change-order workflows are
 * one unified list behind `/api/v1/workflows`.
 *
 * Keyed under `workflows` because that is the endpoint it reads; invalidating
 * `lifecycles` reaches it too, since `lifecycles` names `workflows` as a
 * dependent.
 */
export function lifecycleListQuery() {
  return collectionQuery<WorkflowDefinition>('workflows', 'workflows')
}
