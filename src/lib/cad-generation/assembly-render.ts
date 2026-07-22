// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Assembly Render
 *
 * Submits a `generation.cad.assemble` job to the CadQuery/OCCT worker, which
 * imports each child STEP from the vault, applies the plan's placement
 * transforms (rotateX → rotateY → rotateZ about the global origin, in
 * degrees, then translate — the same convention kcl-generator serializes),
 * and exports one structured STEP assembly back into the vault.
 */

import type { AssemblyPlan, BoundingBox3D } from './types'

export interface AssemblyRenderChild {
  tempId: string
  name: string
  stepFileKey: string
}

export interface AssemblyRenderResult {
  vaultFileId: string
  fileName: string
  boundingBox?: BoundingBox3D
}

/**
 * Render an assembly plan to a STEP file via the worker. Throws on job
 * failure, timeout, or abort — callers treat any throw as a failed
 * composition for this node.
 */
export async function renderAssemblyStep(options: {
  plan: AssemblyPlan
  assemblyName: string
  /** Children with geometry — the source of truth for STEP file keys */
  children: Array<AssemblyRenderChild>
  itemId: string
  branchId: string
  userId: string
  signal?: AbortSignal
  maxWaitMs?: number
}): Promise<AssemblyRenderResult> {
  const childByTempId = new Map(options.children.map((c) => [c.tempId, c]))

  // Re-key stepFileKeys from our own child data — the plan's keys are
  // LLM-echoed and must not be trusted. Placements for unknown tempIds
  // are dropped.
  const placements = options.plan.placements.flatMap((p) => {
    const child = childByTempId.get(p.tempId)
    if (!child) return []
    return [
      {
        tempId: p.tempId,
        partName: child.name,
        stepFileKey: child.stepFileKey,
        transform: p.transform,
        quantity: Math.max(1, Math.round(p.quantity || 1)),
      },
    ]
  })

  if (placements.length === 0) {
    throw new Error('Assembly plan has no placements matching known children')
  }

  // Dynamic import keeps the DB out of the client bundle
  const { JobService } = await import('@/lib/jobs/JobService')

  const job = await JobService.submit(
    'generation.cad.assemble',
    {
      assemblyTempId: options.plan.assemblyTempId,
      assemblyName: options.assemblyName,
      itemId: options.itemId,
      branchId: options.branchId,
      userId: options.userId,
      placements,
    },
    options.userId,
    { priority: 'high', itemId: options.itemId },
  )

  const maxWaitMs = options.maxWaitMs ?? 180_000
  const pollIntervalMs = 500
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitMs) {
    if (options.signal?.aborted) {
      throw new Error('Assembly render aborted')
    }
    const current = await JobService.get(job.id)
    if (!current) break

    if (current.status === 'completed' && current.result) {
      const result = current.result as {
        vaultFileId: string
        fileName: string
        boundingBox?: BoundingBox3D
      }
      return {
        vaultFileId: result.vaultFileId,
        fileName: result.fileName,
        boundingBox: result.boundingBox,
      }
    }

    if (current.status === 'failed') {
      throw new Error(current.error ?? 'Assembly render job failed')
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  throw new Error(`Assembly render timed out after ${maxWaitMs}ms`)
}
