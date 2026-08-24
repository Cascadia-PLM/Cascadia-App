// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { tagged } from '../adapter'
import { apiHandler } from '@/lib/api/handler'
import { LifecycleService } from '@/lib/services/LifecycleService'

const adapt = tagged('Lifecycles')

const app = new Hono()

// GET /api/lifecycles/by-item-type/:itemType
//
// The definition governing an item type, for rendering: state names, colours
// and flags, phases, and the change-action mappings the client needs to
// derive the released family. Resolves Driving-governed types (ChangeOrder)
// too, since their items mirror the Driving definition's states.
app.get(
  '/by-item-type/:itemType',
  adapt(
    apiHandler<{ itemType: string }>({}, async ({ params }) => {
      const definition = await LifecycleService.getGoverningDefinition(
        params.itemType,
      )

      if (!definition) {
        return {
          lifecycleId: null,
          name: null,
          lifecycleType: null,
          phases: [],
          states: [],
          transitions: [],
          revisionScheme: null,
          changeActionMappings: {},
        }
      }

      return {
        lifecycleId: definition.id,
        name: definition.name,
        lifecycleType: definition.lifecycleType,
        phases: definition.phases,
        states: definition.states,
        transitions: definition.transitions,
        revisionScheme: definition.revisionScheme,
        changeActionMappings: definition.changeActionMappings,
      }
    }),
  ),
)

export default app
