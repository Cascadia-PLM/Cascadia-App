/**
 * Shared hook for editing requirement and BOM artifacts during the review
 * stages. Each mutation merges the change into the local artifacts and PATCHes
 * the full artifacts object — the SSE stream / next session GET refreshes the
 * server-truth state.
 */

import { useCallback } from 'react'
import type {
  BomNodeDraft,
  DesignArtifacts,
  RequirementDraft,
} from '@/lib/design-engine/types'
import {
  addBomNodeChild,
  recomputeBomDerivedFields,
  removeBomNode,
  updateBomNode,
} from '@/lib/design-engine/bom-mutations'

interface UseArtifactMutationsArgs {
  sessionId: string
  artifacts: DesignArtifacts
}

async function patchArtifacts(
  sessionId: string,
  artifacts: DesignArtifacts,
): Promise<void> {
  await fetch(`/api/v1/design-engine/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artifacts }),
  })
}

export function useArtifactMutations({
  sessionId,
  artifacts,
}: UseArtifactMutationsArgs) {
  // ---------------- Requirements ----------------

  const updateRequirement = useCallback(
    async (tempId: string, data: Partial<RequirementDraft>) => {
      const requirements = artifacts.requirements.map((r) =>
        r.tempId === tempId ? { ...r, ...data } : r,
      )
      await patchArtifacts(sessionId, { ...artifacts, requirements })
    },
    [sessionId, artifacts],
  )

  const removeRequirement = useCallback(
    async (tempId: string) => {
      const requirements = artifacts.requirements.filter(
        (r) => r.tempId !== tempId,
      )
      // Coverage may reference this requirement — recompute if BOM exists.
      let bom = artifacts.bom
      if (bom) {
        bom = recomputeBomDerivedFields(
          bom,
          requirements.map((r) => r.tempId),
        )
      }
      await patchArtifacts(sessionId, { ...artifacts, requirements, bom })
    },
    [sessionId, artifacts],
  )

  const addRequirement = useCallback(
    async (data: Partial<RequirementDraft>) => {
      const newReq: RequirementDraft = {
        tempId: crypto.randomUUID(),
        name: data.name ?? '',
        description: data.description ?? '',
        requirementType: data.requirementType ?? 'Functional',
        priority: data.priority ?? 'medium',
        verificationMethod: data.verificationMethod ?? 'Analysis',
        rationale: data.rationale ?? '',
        confidence: data.confidence ?? 1,
        source: 'user',
      }
      const requirements = [...artifacts.requirements, newReq]
      let bom = artifacts.bom
      if (bom) {
        bom = recomputeBomDerivedFields(
          bom,
          requirements.map((r) => r.tempId),
        )
      }
      await patchArtifacts(sessionId, { ...artifacts, requirements, bom })
    },
    [sessionId, artifacts],
  )

  // ---------------- BOM ----------------

  const requirementIds = artifacts.requirements.map((r) => r.tempId)

  const updateNode = useCallback(
    async (tempId: string, patch: Partial<BomNodeDraft>) => {
      if (!artifacts.bom) return
      const next = recomputeBomDerivedFields(
        updateBomNode(artifacts.bom, tempId, patch),
        requirementIds,
      )
      await patchArtifacts(sessionId, { ...artifacts, bom: next })
    },
    [sessionId, artifacts, requirementIds],
  )

  const removeNode = useCallback(
    async (tempId: string) => {
      if (!artifacts.bom) return
      const next = recomputeBomDerivedFields(
        removeBomNode(artifacts.bom, tempId),
        requirementIds,
      )
      await patchArtifacts(sessionId, { ...artifacts, bom: next })
    },
    [sessionId, artifacts, requirementIds],
  )

  const addChild = useCallback(
    async (parentTempId: string, data: Partial<BomNodeDraft>) => {
      if (!artifacts.bom) return
      const next = recomputeBomDerivedFields(
        addBomNodeChild(artifacts.bom, parentTempId, data),
        requirementIds,
      )
      await patchArtifacts(sessionId, { ...artifacts, bom: next })
    },
    [sessionId, artifacts, requirementIds],
  )

  return {
    updateRequirement,
    removeRequirement,
    addRequirement,
    updateNode,
    removeNode,
    addChild,
  }
}
