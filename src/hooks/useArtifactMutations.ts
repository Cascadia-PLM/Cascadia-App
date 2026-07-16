/**
 * Shared hook for editing requirement and BOM artifacts during the review
 * stages. Each mutation merges the change into the local artifacts and PATCHes
 * the full artifacts object — the SSE stream / next session GET refreshes the
 * server-truth state.
 */

import { useCallback } from 'react'
import type {
  BomNodeDraft,
  BomRejectionEntry,
  DesignArtifacts,
  DesignSessionStage,
  ItemComment,
  RequirementDraft,
  ReviewStatus,
} from '@/lib/design-engine/types'
import { activeRequirements } from '@/lib/design-engine/types'
import {
  addBomNodeChild,
  findBomNode,
  recomputeBomDerivedFields,
  removeBomNode,
  setAllProposedNodesStatus,
  updateBomNode,
} from '@/lib/design-engine/bom-mutations'

interface UseArtifactMutationsArgs {
  sessionId: string
  artifacts: DesignArtifacts
  currentStage?: DesignSessionStage
  /**
   * Apply the change to local state so the UI reflects it immediately. Without
   * it a mutation only PATCHes the server and the review panel stays stale until
   * a reload (no SSE stream runs during review to push the update back).
   */
  applyArtifacts?: (artifacts: DesignArtifacts) => void
}

async function patchArtifacts(
  sessionId: string,
  artifacts: DesignArtifacts,
): Promise<void> {
  const res = await fetch(`/api/v1/design-engine/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artifacts }),
  })
  if (!res.ok) {
    throw new Error(`Failed to save changes (${res.status})`)
  }
}

export function useArtifactMutations({
  sessionId,
  artifacts,
  currentStage,
  applyArtifacts,
}: UseArtifactMutationsArgs) {
  // Update local state immediately, then persist. Rolling back on failure keeps
  // the optimistic UI from drifting away from server truth. Every mutation goes
  // through here so a click is reflected at once and sequential edits build on
  // each other instead of each PATCHing from the same stale base.
  const commit = useCallback(
    async (next: DesignArtifacts) => {
      const previous = artifacts
      applyArtifacts?.(next)
      try {
        await patchArtifacts(sessionId, next)
      } catch (err) {
        applyArtifacts?.(previous)
        throw err
      }
    },
    [sessionId, artifacts, applyArtifacts],
  )

  // ---------------- Requirements ----------------

  const updateRequirement = useCallback(
    async (tempId: string, data: Partial<RequirementDraft>) => {
      const requirements = artifacts.requirements.map(
        (r): RequirementDraft =>
          r.tempId === tempId
            ? // A user edit implicitly approves the edited content
              { ...r, reviewStatus: 'edited', ...data }
            : r,
      )
      await commit({ ...artifacts, requirements })
    },
    [artifacts, commit],
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
          activeRequirements(requirements).map((r) => r.tempId),
        )
      }
      await commit({ ...artifacts, requirements, bom })
    },
    [artifacts, commit],
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
        reviewStatus: 'accepted',
      }
      const requirements = [...artifacts.requirements, newReq]
      let bom = artifacts.bom
      if (bom) {
        bom = recomputeBomDerivedFields(
          bom,
          activeRequirements(requirements).map((r) => r.tempId),
        )
      }
      await commit({ ...artifacts, requirements, bom })
    },
    [artifacts, commit],
  )

  const setRequirementReviewStatus = useCallback(
    async (tempId: string, status: ReviewStatus, note?: string) => {
      const requirements = artifacts.requirements.map((r) =>
        r.tempId === tempId
          ? { ...r, reviewStatus: status, reviewNote: note ?? r.reviewNote }
          : r,
      )
      // Rejected requirements drop out of coverage — recompute if BOM exists.
      let bom = artifacts.bom
      if (bom) {
        bom = recomputeBomDerivedFields(
          bom,
          activeRequirements(requirements).map((r) => r.tempId),
        )
      }
      await commit({ ...artifacts, requirements, bom })
    },
    [artifacts, commit],
  )

  const acceptAllRequirements = useCallback(async () => {
    const requirements = artifacts.requirements.map(
      (r): RequirementDraft =>
        r.reviewStatus === undefined || r.reviewStatus === 'proposed'
          ? { ...r, reviewStatus: 'accepted' }
          : r,
    )
    await commit({ ...artifacts, requirements })
  }, [artifacts, commit])

  // ---------------- BOM ----------------

  const requirementIds = activeRequirements(artifacts.requirements).map(
    (r) => r.tempId,
  )

  const updateNode = useCallback(
    async (tempId: string, patch: Partial<BomNodeDraft>) => {
      if (!artifacts.bom) return
      const next = recomputeBomDerivedFields(
        // A user edit implicitly approves the edited content
        updateBomNode(artifacts.bom, tempId, {
          reviewStatus: 'edited',
          ...patch,
        }),
        requirementIds,
      )
      await commit({ ...artifacts, bom: next })
    },
    [artifacts, requirementIds, commit],
  )

  const removeNode = useCallback(
    async (tempId: string) => {
      if (!artifacts.bom) return
      const next = recomputeBomDerivedFields(
        removeBomNode(artifacts.bom, tempId),
        requirementIds,
      )
      await commit({ ...artifacts, bom: next })
    },
    [artifacts, requirementIds, commit],
  )

  /**
   * Reject a node: remove its subtree from the tree and record a tombstone in
   * `bomRejections` so the AI won't re-propose it on later runs.
   */
  const rejectNode = useCallback(
    async (tempId: string, reason?: string) => {
      if (!artifacts.bom) return
      const found = findBomNode(artifacts.bom, tempId)
      if (!found || !found.parent) return // root cannot be rejected

      const tombstone: BomRejectionEntry = {
        tempId,
        name: found.node.name,
        partType: found.node.partType,
        parentName: found.parent.name,
        reason,
        rejectedAt: new Date().toISOString(),
        stage: currentStage ?? 'bom_review',
      }

      const next = recomputeBomDerivedFields(
        removeBomNode(artifacts.bom, tempId),
        requirementIds,
      )
      await commit({
        ...artifacts,
        bom: next,
        bomRejections: [...(artifacts.bomRejections ?? []), tombstone],
      })
    },
    [artifacts, requirementIds, currentStage, commit],
  )

  const setNodeReviewStatus = useCallback(
    async (tempId: string, status: ReviewStatus, note?: string) => {
      if (!artifacts.bom) return
      const next = updateBomNode(artifacts.bom, tempId, {
        reviewStatus: status,
        ...(note !== undefined ? { reviewNote: note } : {}),
      })
      await commit({ ...artifacts, bom: next })
    },
    [artifacts, commit],
  )

  const acceptAllNodes = useCallback(async () => {
    if (!artifacts.bom) return
    const next = setAllProposedNodesStatus(artifacts.bom, 'accepted')
    await commit({ ...artifacts, bom: next })
  }, [artifacts, commit])

  const addChild = useCallback(
    async (parentTempId: string, data: Partial<BomNodeDraft>) => {
      if (!artifacts.bom) return
      const next = recomputeBomDerivedFields(
        addBomNodeChild(artifacts.bom, parentTempId, data),
        requirementIds,
      )
      await commit({ ...artifacts, bom: next })
    },
    [artifacts, requirementIds, commit],
  )

  // ---------------- Item comments ----------------

  const addItemComment = useCallback(
    async (
      targetType: ItemComment['targetType'],
      targetTempId: string,
      text: string,
    ) => {
      const comment: ItemComment = {
        id: crypto.randomUUID(),
        targetType,
        targetTempId,
        text,
        createdAt: new Date().toISOString(),
        stage: currentStage ?? 'idle',
      }
      await commit({
        ...artifacts,
        itemComments: [...(artifacts.itemComments ?? []), comment],
      })
    },
    [artifacts, currentStage, commit],
  )

  const setItemCommentResolved = useCallback(
    async (commentId: string, resolved: boolean) => {
      const itemComments = (artifacts.itemComments ?? []).map((c) =>
        c.id === commentId ? { ...c, resolved } : c,
      )
      await commit({ ...artifacts, itemComments })
    },
    [artifacts, commit],
  )

  return {
    updateRequirement,
    removeRequirement,
    addRequirement,
    addItemComment,
    setItemCommentResolved,
    setRequirementReviewStatus,
    acceptAllRequirements,
    updateNode,
    removeNode,
    rejectNode,
    setNodeReviewStatus,
    acceptAllNodes,
    addChild,
  }
}
