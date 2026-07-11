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
  currentStage,
}: UseArtifactMutationsArgs) {
  // ---------------- Requirements ----------------

  const updateRequirement = useCallback(
    async (tempId: string, data: Partial<RequirementDraft>) => {
      const requirements = artifacts.requirements.map((r) =>
        r.tempId === tempId
          ? // A user edit implicitly approves the edited content
            { ...r, reviewStatus: 'edited' as ReviewStatus, ...data }
          : r,
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
          activeRequirements(requirements).map((r) => r.tempId),
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
      await patchArtifacts(sessionId, { ...artifacts, requirements, bom })
    },
    [sessionId, artifacts],
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
      await patchArtifacts(sessionId, { ...artifacts, requirements, bom })
    },
    [sessionId, artifacts],
  )

  const acceptAllRequirements = useCallback(async () => {
    const requirements = artifacts.requirements.map((r) =>
      r.reviewStatus === undefined || r.reviewStatus === 'proposed'
        ? { ...r, reviewStatus: 'accepted' as ReviewStatus }
        : r,
    )
    await patchArtifacts(sessionId, { ...artifacts, requirements })
  }, [sessionId, artifacts])

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
      await patchArtifacts(sessionId, {
        ...artifacts,
        bom: next,
        bomRejections: [...(artifacts.bomRejections ?? []), tombstone],
      })
    },
    [sessionId, artifacts, requirementIds, currentStage],
  )

  const setNodeReviewStatus = useCallback(
    async (tempId: string, status: ReviewStatus, note?: string) => {
      if (!artifacts.bom) return
      const next = updateBomNode(artifacts.bom, tempId, {
        reviewStatus: status,
        ...(note !== undefined ? { reviewNote: note } : {}),
      })
      await patchArtifacts(sessionId, { ...artifacts, bom: next })
    },
    [sessionId, artifacts],
  )

  const acceptAllNodes = useCallback(async () => {
    if (!artifacts.bom) return
    const next = setAllProposedNodesStatus(artifacts.bom, 'accepted')
    await patchArtifacts(sessionId, { ...artifacts, bom: next })
  }, [sessionId, artifacts])

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
      await patchArtifacts(sessionId, {
        ...artifacts,
        itemComments: [...(artifacts.itemComments ?? []), comment],
      })
    },
    [sessionId, artifacts, currentStage],
  )

  const setItemCommentResolved = useCallback(
    async (commentId: string, resolved: boolean) => {
      const itemComments = (artifacts.itemComments ?? []).map((c) =>
        c.id === commentId ? { ...c, resolved } : c,
      )
      await patchArtifacts(sessionId, { ...artifacts, itemComments })
    },
    [sessionId, artifacts],
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
