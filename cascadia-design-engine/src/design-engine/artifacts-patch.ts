// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { z } from 'zod'
import type { DesignArtifacts, designArtifactsPatchSchema } from './types'

export type DesignArtifactsPatch = z.infer<typeof designArtifactsPatchSchema>

/**
 * The artifact keys a client may write through `PATCH /sessions/:id`.
 *
 * Everything else on `DesignArtifacts` is written by the server as a stage
 * runs — the clarification queue, the user-message log, the materialization
 * record, the CAD generation state. A client has no business supplying them,
 * and one of them is a capability: the CAD stage builds its tempId→itemId map
 * purely from `materializationResult.createdItems` and then uploads STEP files
 * to those item ids, so a fabricated `materializationResult` is a write into
 * any item whose UUID the caller knows.
 */
const CLIENT_EDITABLE_KEYS = [
  'description',
  'toolset',
  'requirements',
  'bom',
  'bomRejections',
  'itemComments',
] as const satisfies ReadonlyArray<keyof DesignArtifacts>

/**
 * Overlay a client patch onto the stored artifacts.
 *
 * Two defects this closes, both in the same three lines of route:
 *
 *  1. **Replace behind a partial schema.** `designArtifactsPatchSchema` is
 *     `.partial()` over every field, and the route wrote the parse result
 *     *wholesale*. So the natural partial body — `{artifacts:{requirements:
 *     [...]}}` — wiped `bom`, `toolset` and `clarifications`. The in-app hook
 *     survived only because it always echoes the whole document back; any
 *     other caller destroyed the session.
 *
 *  2. **Server-owned fields accepted from the client.** See
 *     `CLIENT_EDITABLE_KEYS` above.
 *
 * Server-owned keys present in the patch are *ignored*, not rejected, so the
 * full-document echo the in-app hook sends keeps working unchanged — it round
 * trips the values it read, and reading them back out of `current` gives the
 * same result.
 *
 * An editable key present with an `undefined` value is treated as absent: a
 * JSON body cannot distinguish "omitted" from "explicitly undefined", and
 * `.partial()` produces the same shape for both.
 */
export function applyArtifactsPatch(
  current: DesignArtifacts,
  patch: DesignArtifactsPatch,
): DesignArtifacts {
  const next = { ...current } as unknown as Record<string, unknown>

  for (const key of CLIENT_EDITABLE_KEYS) {
    const value = patch[key]
    if (value !== undefined) {
      // The patch schema validates each field's own shape; the cast only
      // reconciles the two declarations of it, key by key.
      next[key] = value
    }
  }

  return next as unknown as DesignArtifacts
}
