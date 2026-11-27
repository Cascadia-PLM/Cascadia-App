// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `generation.cad.freecad` — run one FreeCAD Python script in the FreeCAD
 * worker (`cascadia-workers-freecad-runner/`) and report what it built.
 *
 * The job is the unit the AI agent iterates on: it submits a script, reads
 * the report, and submits a corrected one. Two consequences shape these
 * schemas:
 *
 * - A script that fails is a *completed* job with `ok: false`, never a failed
 *   one. The worker's retry ledger exists for infrastructure faults — a lost
 *   database connection, a missing FreeCAD — and re-running a broken script
 *   would only burn a worker slot to reach the same traceback.
 * - `persist` is false while the agent iterates, so a dozen attempts leave
 *   nothing in the vault. The accepted script is run once more with
 *   `persist: true`, which is the only run that writes a `vault_files` row.
 */

import { z } from 'zod'

const boundingBoxSchema = z.object({
  minX: z.number(),
  minY: z.number(),
  minZ: z.number(),
  maxX: z.number(),
  maxY: z.number(),
  maxZ: z.number(),
})

const vector3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
})

export const freecadScriptPayloadSchema = z
  .object({
    /** The script. The worker's static guard rejects GUI, file and network use. */
    script: z.string().min(1).max(200_000),
    /** Used for the STEP file name and the job log. */
    partName: z.string().min(1).max(200),
    userId: z.string().uuid(),
    /** Write the STEP into the vault (requires `itemId`). False while iterating. */
    persist: z.boolean(),
    itemId: z.string().uuid().optional(),
    branchId: z.string().uuid().optional(),
    partTempId: z.string().optional(),
    /** Wall-clock budget for the script process; the worker clamps it. */
    timeoutMs: z.number().int().min(10_000).max(600_000).optional(),
  })
  .refine((payload) => !payload.persist || payload.itemId !== undefined, {
    message: 'itemId is required when persist is true',
    path: ['itemId'],
  })

export type FreecadScriptPayload = z.infer<typeof freecadScriptPayloadSchema>

/** What the harness measured on the `result` shape. */
export const freecadGeometrySummarySchema = z.object({
  solidCount: z.number().int(),
  faceCount: z.number().int(),
  edgeCount: z.number().int(),
  volumeMm3: z.number(),
  surfaceAreaMm2: z.number(),
  isValid: z.boolean(),
  boundingBox: boundingBoxSchema,
  centerOfMass: vector3Schema.optional(),
})

export type FreecadGeometrySummary = z.infer<
  typeof freecadGeometrySummarySchema
>

export const freecadScriptResultSchema = z.object({
  /** The script ran and `result` passed validation (and, if asked, was stored). */
  ok: z.boolean(),
  freecadVersion: z.string().optional(),
  executionTimeMs: z.number(),
  /** Captured process output, truncated by the worker. */
  stdout: z.string(),
  stderr: z.string(),
  /** Why `ok` is false: the exception message, or the first validation issue. */
  errorMessage: z.string().optional(),
  /** Python traceback with the harness's own frames removed. */
  traceback: z.string().optional(),
  /** Validation findings — fatal ones when `ok` is false, advisory otherwise. */
  issues: z.array(z.string()),
  geometry: freecadGeometrySummarySchema.optional(),
  /** Set only when `persist` was true and the STEP was stored. */
  vaultFileId: z.string().uuid().optional(),
  fileName: z.string().optional(),
})

export type FreecadScriptResult = z.infer<typeof freecadScriptResultSchema>
