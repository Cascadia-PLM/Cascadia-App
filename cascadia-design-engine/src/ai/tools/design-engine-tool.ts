// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { initiateCollaborativeDesignDef } from './design-engine-definitions'
import { initiateCollaborativeDesignHandler } from './design-engine-handlers'
import type { ToolRegistryEntry } from '@/ai/tools/registry'
import { schemaOf } from '@/ai/tools/registry'

/**
 * The collaborative design engine, as an AI tool.
 *
 * The registry entry used to sit in core's `registry.ts` array literal, which
 * meant core imported this package's definition and handler to build it. The
 * entry is the module's to construct; core only needs somewhere to put it.
 */
export const initiateCollaborativeDesignTool: ToolRegistryEntry = {
  name: initiateCollaborativeDesignDef.name,
  description: initiateCollaborativeDesignDef.description,
  inputSchema: schemaOf(initiateCollaborativeDesignDef),
  readOnly: false,
  // Launches the in-app collaborative design workspace — SPA only.
  surfaces: ['chat'],
  bind: (context) =>
    initiateCollaborativeDesignDef.server((input) =>
      initiateCollaborativeDesignHandler(input, context),
    ),
  invoke: (input, context) =>
    initiateCollaborativeDesignHandler(input as never, context),
}
