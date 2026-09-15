// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  CadModelNode,
  CadModelNodeCandidate,
} from '@cascadia/commons/lib/vault/cad-nodes'
import { NO_STRUCTURE, cadModelNodesQuery } from '@/lib/query/options/cad-nodes'
import { useResourceMutation } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

/**
 * Which part of an assembly model is selected, and what that part is.
 *
 * Two things the viewer deliberately does not own. The node *key* is a glTF
 * name and means nothing outside the file; the part it stands for is a PLM
 * item with a number, a state and a detail page. Resolving one to the other is
 * a query, and the viewer is a renderer — so the resolution lives here and the
 * canvas is handed only the key.
 *
 * `selectable` is false for every flat model, which is most of them: a single
 * part, a non-STEP source, or an assembly converted before the CAD converter
 * began writing a glTF node per part. Callers pass this state to the viewer
 * either way; the viewer skips raycasting entirely when there is nothing in
 * the file to pick.
 */
export interface CADSelectionState {
  /** Every selectable part of the current model; empty when it is flat. */
  nodes: Array<CadModelNode>
  /** What a node may be re-linked to: the assembly's own BOM children. */
  candidates: Array<CadModelNodeCandidate>
  /** Whether this model has parts that can be picked at all. */
  selectable: boolean
  /** glTF node key of the selected part, or null. */
  selectedNodeKey: string | null
  /** The selected part, resolved. Null when nothing is selected. */
  selectedNode: CadModelNode | null
  /** Select a part by node key; null clears the selection. */
  select: (nodeKey: string | null) => void
  /**
   * Record what the selected node is: a part, or — with null — deliberately
   * not one. Recording it overrides the automatic match from then on.
   */
  linkSelected: (partItemId: string | null) => void
  /** Drop the recorded answer, handing the node back to the matcher. */
  unlinkSelected: () => void
  /** Whether a link write is in flight. */
  isLinking: boolean
}

export function useCADSelectionState({
  fileId,
  branchId,
  enabled = true,
}: {
  /** The model being shown. Selection resets when it changes. */
  fileId: string | undefined
  /** Resolve the assembly's BOM as this branch sees it. */
  branchId?: string
  enabled?: boolean
}): CADSelectionState {
  const options = useMemo(
    () => cadModelNodesQuery(fileId, { branchId }, enabled),
    [fileId, branchId, enabled],
  )
  const { data: structure = NO_STRUCTURE } = useQuery(options)

  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null)

  // A different model is a different set of parts, and a key from the old one
  // would either miss or — worse, since keys are CAD paths and two assemblies
  // can share one — land on an unrelated part with the same name.
  useEffect(() => {
    setSelectedNodeKey(null)
  }, [fileId])

  const { nodes, candidates } = structure

  const selectedNode = useMemo(
    () =>
      selectedNodeKey === null
        ? null
        : (nodes.find((node) => node.nodeKey === selectedNodeKey) ?? null),
    [nodes, selectedNodeKey],
  )

  const select = useCallback((nodeKey: string | null) => {
    setSelectedNodeKey(nodeKey)
  }, [])

  // The node key rides in the body, not the path — it is a slash-separated
  // instance path, and `%2F` inside a URL segment is what a reverse proxy
  // normalizes back into a separator.
  const link = useResourceMutation({
    mutationFn: async (partItemId: string | null) => {
      if (!fileId || selectedNodeKey === null) return
      await apiFetch(`/api/v1/files/${fileId}/cad-nodes/link`, {
        method: 'PUT',
        body: JSON.stringify({ nodeKey: selectedNodeKey, partItemId }),
      })
    },
    // `files`, because the node list is keyed beneath the file it describes.
    invalidates: ['files'],
  })

  const unlink = useResourceMutation({
    mutationFn: async () => {
      if (!fileId || selectedNodeKey === null) return
      await apiFetch(`/api/v1/files/${fileId}/cad-nodes/reset`, {
        method: 'POST',
        body: JSON.stringify({ nodeKey: selectedNodeKey }),
      })
    },
    invalidates: ['files'],
  })

  return {
    nodes,
    candidates,
    selectable: nodes.length > 0,
    selectedNodeKey,
    selectedNode,
    select,
    linkSelected: link.mutate,
    unlinkSelected: unlink.mutate,
    isLinking: link.isPending || unlink.isPending,
  }
}
