// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import type { CadModelNode, CadModelNodeCandidate } from '@/lib/vault/cad-nodes'
import { apiFetch } from '@/lib/api/client'

export type { CadModelNode, CadModelNodeCandidate }

/** What one assembly model contains, and what its parts may be linked to. */
export interface CadModelStructure {
  nodes: Array<CadModelNode>
  candidates: Array<CadModelNodeCandidate>
}

/** Shared empty, so "not an assembly" is the same object on every render. */
const NO_STRUCTURE: CadModelStructure = { nodes: [], candidates: [] }

/**
 * The selectable parts of one assembly model, each resolved to a PLM part.
 *
 * Keyed under `files` rather than under the part, because it describes a model
 * file: switching which CAD file the viewer shows must re-read, and a
 * re-conversion invalidating `files` must refresh it. The BOM it is matched
 * against is branch-dependent, which is why `branchId` is in the key rather
 * than left implicit.
 *
 * Resolves to empty arrays for a model with no part structure — every flat
 * GLB — so callers can treat "not an assembly" and "an assembly with nothing
 * selected" as the same shape.
 */
export function cadModelNodesQuery(
  fileId: string | undefined,
  context: { branchId?: string } = {},
  enabled = true,
) {
  const suffix = context.branchId ? `?branchId=${context.branchId}` : ''

  return queryOptions({
    queryKey: qk.sub('files', fileId ?? '', 'cad-nodes', {
      branchId: context.branchId,
    }),
    queryFn: async (): Promise<CadModelStructure> => {
      const result = await apiFetch<{ data: Partial<CadModelStructure> }>(
        `/api/v1/files/${fileId}/cad-nodes${suffix}`,
      )
      return {
        nodes: result.data.nodes ?? [],
        candidates: result.data.candidates ?? [],
      }
    },
    enabled: enabled && Boolean(fileId),
  })
}

export { NO_STRUCTURE }
