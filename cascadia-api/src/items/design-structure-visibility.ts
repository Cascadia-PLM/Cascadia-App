// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { BOMTreeNode } from '@cascadia/commons/types/bom'

/**
 * A design's BOM tree as one caller may see it.
 *
 * A structure reaches into other designs two ways: a cross-design reference,
 * which joins the tree as a root, and a BOM line whose child lives elsewhere.
 * Both tree builders — `GET /designs/:id/structure` and
 * `ChangeOrderStructureService` — follow them wherever they lead, and should,
 * but neither knows who is asking, and the request was charged for the design
 * in its path alone. So an item from a program the caller cannot open came
 * back with its number, name, revision and state, its design's code and name,
 * and its whole BOM beneath it.
 *
 * A node the caller cannot read is withheld here, and everything beneath it
 * goes with it — even a child in a design the caller could open on its own,
 * because what an item is built from is that item's to disclose.
 *
 * What is withheld collapses into one anonymous flag, the rule a change order
 * spanning programs already follows
 * (`ChangeOrderService.getAffectedItemsForViewer`). Not a placeholder per node
 * and not a count: either would say how much of the design reaches into
 * programs the caller cannot open, and where. And not silence either: a BOM
 * that is quietly a line short reads as the whole BOM, and gets reviewed,
 * exported and built as one.
 *
 * Reach is the node's design's, as `AccessControlService.canAccessDesign`
 * decides it; `accessDesignIds` is that rule for a list
 * (`AccessControlService.getAccessibleDesignIds`), where `null` is
 * cross-program authority and withholds nothing. A node in no design sits
 * outside every program, so there is no boundary to hold it behind.
 */
export function withholdUnreadableNodes(
  roots: Array<BOMTreeNode>,
  accessDesignIds: Array<string> | null,
): { roots: Array<BOMTreeNode>; hasRestricted: boolean } {
  if (accessDesignIds === null) return { roots, hasRestricted: false }

  const readable = new Set(accessDesignIds)
  let hasRestricted = false

  const keepReadable = (nodes: Array<BOMTreeNode>): Array<BOMTreeNode> =>
    nodes.flatMap((node) => {
      if (node.designId && !readable.has(node.designId)) {
        hasRestricted = true
        return []
      }
      if (!node.children) return [node]
      const children = keepReadable(node.children)
      return [{ ...node, children: children.length > 0 ? children : undefined }]
    })

  return { roots: keepReadable(roots), hasRestricted }
}
