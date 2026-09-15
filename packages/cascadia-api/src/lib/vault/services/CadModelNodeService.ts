// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq } from 'drizzle-orm'
import type {
  CadModelNode,
  CadModelNodeCandidate,
  MatchCandidate,
} from '@/lib/vault/cad-nodes'
import { db } from '@/lib/db'
import { cadModelNodeLinks, items, vaultFiles } from '@/lib/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { matchNodeInPath, toMatchCandidate } from '@/lib/vault/cad-nodes'

/**
 * How deep into the BOM a match will look for the part a model node names.
 *
 * A BOM this deep is a cycle the relationship data should not permit or a
 * structure no assembly model would be navigable for; the walk keeps a visited
 * set as well, so this is the belt rather than the braces.
 */
const MAX_BOM_DEPTH = 24

/**
 * Ceiling on candidates considered for one model.
 *
 * Matching is a string compare per candidate per node, so it is quadratic in a
 * large assembly. Stopping the walk keeps a pathological BOM from making the
 * viewer's first read expensive; the nodes it can no longer resolve report as
 * unmatched, which is the same answer a person gets for a node whose part was
 * never in the BOM.
 */
const MAX_BOM_CANDIDATES = 5000

/**
 * The parts of an assembly's 3D model, and which PLM item each one is.
 *
 * A structured assembly GLB carries a named glTF node per leaf part (see
 * `write_structured_glb` in the CAD converter). That name is whatever the CAD
 * called the part — `TDJ-25-1042.SLDPRT`, `Base Bracket`, `bracket_v2` — which
 * is a description, not an identity. Turning it into one is this service's
 * whole job, and it does that two ways: by matching names against the
 * assembly's own BOM, and by honoring the corrections people record when the
 * matching gets it wrong.
 *
 * Matching runs on every read rather than being saved. It costs a string
 * compare per BOM child, and recomputing keeps a model current with a BOM that
 * moves under it — a child added this morning is matched this morning. Saved
 * guesses would have gone stale silently instead, and left nothing to
 * distinguish a stale guess from a considered answer. What *is* saved is only
 * the answers people give; see `cadModelNodeLinks`.
 */
export class CadModelNodeService {
  /**
   * The selectable parts of one model file, each resolved to a PLM part.
   *
   * Returns an empty list — not an error — for a model with no node structure.
   * Every flat GLB is one: a single part, a non-STEP source, or an assembly
   * converted before the structured writer existed. The viewer reads the empty
   * list as "this model cannot be taken apart" and behaves as it always did.
   */
  static async listNodes(
    fileId: string,
    context: { branchId?: string } = {},
  ): Promise<{
    assemblyItemId: string
    nodes: Array<CadModelNode>
    /** What a node may be re-linked to: the assembly's own BOM children. */
    candidates: Array<CadModelNodeCandidate>
  }> {
    const file = await this.requireFile(fileId)

    const manifest = file.cadMetadata?.nodes ?? []
    if (manifest.length === 0) {
      return { assemblyItemId: file.itemId, nodes: [], candidates: [] }
    }

    const assemblyMasterId = await this.requireMasterId(file.itemId)

    const [candidates, overrides] = await Promise.all([
      this.bomCandidates(file.itemId, context.branchId),
      this.overridesFor(assemblyMasterId),
    ])

    const byMaster = new Map(candidates.map((c) => [c.masterId, c]))

    const nodes = manifest.map((entry): CadModelNode => {
      const base = {
        nodeKey: entry.nodeKey,
        name: entry.name,
        path: entry.path,
        polygonCount: entry.polygonCount,
      }

      if (overrides.has(entry.nodeKey)) {
        const overriddenMaster = overrides.get(entry.nodeKey) ?? null

        // A recorded "not a part" is a decision, and outranks any name match.
        if (overriddenMaster === null) {
          return { ...base, part: null, resolution: 'excluded' }
        }

        const linked = byMaster.get(overriddenMaster)
        if (linked) {
          return { ...base, part: toPart(linked), resolution: 'manual' }
        }

        // The override names a part this assembly's BOM no longer carries.
        // Reported as unmatched rather than resolved anyway, so the model
        // cannot claim a structure the BOM contradicts — and the row is left
        // alone, so the link returns if the part does.
        return { ...base, part: null, resolution: 'unmatched' }
      }

      const matched = matchNodeInPath(entry.path, entry.name, candidates)
      return matched
        ? { ...base, part: toPart(matched), resolution: 'auto' }
        : { ...base, part: null, resolution: 'unmatched' }
    })

    return {
      assemblyItemId: file.itemId,
      nodes,
      candidates: candidates.map(toPart),
    }
  }

  /**
   * Record which part a node is, or that it is none.
   *
   * Keyed by the assembly's masterId, so the decision outlives both the file
   * it was made against and the revision it was made on.
   */
  static async setLink(
    fileId: string,
    nodeKey: string,
    partItemId: string | null,
    userId: string,
  ): Promise<CadModelNode> {
    const file = await this.requireFile(fileId)

    const known = file.cadMetadata?.nodes ?? []
    if (!known.some((node) => node.nodeKey === nodeKey)) {
      throw new ValidationError(
        `This model has no part named '${nodeKey}'. Node names come from the ` +
          'CAD converter; if the model has changed, re-run the conversion.',
      )
    }

    const assemblyMasterId = await this.requireMasterId(file.itemId)

    let partMasterId: string | null = null
    if (partItemId !== null) {
      partMasterId = await this.requireMasterId(partItemId)
    }

    await db
      .insert(cadModelNodeLinks)
      .values({ assemblyMasterId, nodeKey, partMasterId, createdBy: userId })
      .onConflictDoUpdate({
        target: [cadModelNodeLinks.assemblyMasterId, cadModelNodeLinks.nodeKey],
        set: { partMasterId, updatedAt: new Date() },
      })

    return this.readBack(fileId, nodeKey)
  }

  /**
   * Drop a recorded decision, handing the node back to the matcher.
   *
   * Not the same as linking it to nothing, which records that it is not a part.
   */
  static async clearLink(
    fileId: string,
    nodeKey: string,
  ): Promise<CadModelNode> {
    const file = await this.requireFile(fileId)
    const assemblyMasterId = await this.requireMasterId(file.itemId)

    await db
      .delete(cadModelNodeLinks)
      .where(
        and(
          eq(cadModelNodeLinks.assemblyMasterId, assemblyMasterId),
          eq(cadModelNodeLinks.nodeKey, nodeKey),
        ),
      )

    return this.readBack(fileId, nodeKey)
  }

  private static async requireFile(fileId: string) {
    const [file] = await db
      .select({
        itemId: vaultFiles.itemId,
        cadMetadata: vaultFiles.cadMetadata,
      })
      .from(vaultFiles)
      .where(eq(vaultFiles.id, fileId))
      .limit(1)

    if (!file) throw new NotFoundError('File', fileId)
    return file
  }

  private static async requireMasterId(itemId: string): Promise<string> {
    const [item] = await db
      .select({ masterId: items.masterId })
      .from(items)
      .where(eq(items.id, itemId))
      .limit(1)

    if (!item) throw new NotFoundError('Item', itemId)
    return item.masterId
  }

  /** The node as it now reads, so a write answers with what a read would. */
  private static async readBack(
    fileId: string,
    nodeKey: string,
  ): Promise<CadModelNode> {
    const { nodes } = await this.listNodes(fileId)
    const node = nodes.find((n) => n.nodeKey === nodeKey)
    if (!node) throw new NotFoundError('CAD model node', nodeKey)
    return node
  }

  /**
   * The assembly's BOM children, as things a node name could name.
   *
   * Direct children only: a node in this assembly's model is a part this
   * assembly places, and reaching further down the tree would offer a
   * sub-assembly's internals as candidates for the parent's own nodes.
   */
  /**
   * Everything the assembly contains, at any depth — not just its direct
   * children.
   *
   * Direct children are the wrong set, and measurably so. The converter
   * flattens an assembly to its **leaf** parts: the robot arm's top-level
   * model is 225 of them, while its BOM names 5 subassemblies at the first
   * level. Matching leaves against one level resolved 4 of those 225 nodes.
   * The leaves of the CAD and the leaves of the BOM are the same parts, so
   * the walk has to reach them.
   *
   * Deduplicated by `masterId`, which is load-bearing rather than tidiness: a
   * spacer used in three subassemblies would otherwise arrive as three
   * candidates with one item number, and `matchNode` refuses a tie — so the
   * parts appearing most often in an assembly would be exactly the ones that
   * never resolved.
   */
  private static async bomCandidates(
    assemblyItemId: string,
    branchId?: string,
  ): Promise<Array<MatchCandidate>> {
    const byMaster = new Map<string, MatchCandidate>()
    const visited = new Set<string>([assemblyItemId])
    let frontier = [assemblyItemId]

    for (let depth = 0; depth < MAX_BOM_DEPTH && frontier.length > 0; depth++) {
      const next: Array<string> = []

      // One query per node rather than a recursive CTE: the branch-aware
      // version resolution lives in ItemRelationshipService, and a CTE here
      // would be a second implementation of it. A BOM deep and wide enough
      // for the round trips to matter would be past MAX_BOM_CANDIDATES first.
      for (const itemId of frontier) {
        const relationships = branchId
          ? await ItemRelationshipService.getRelationshipsWithDetailsForBranch(
              itemId,
              branchId,
              'BOM',
            )
          : await ItemRelationshipService.getRelationshipsWithDetails(
              itemId,
              'BOM',
            )

        for (const rel of relationships) {
          const target = rel.targetItem
          if (!target) continue
          if (!byMaster.has(target.masterId)) {
            byMaster.set(target.masterId, toMatchCandidate(target))
          }
          if (!visited.has(target.id)) {
            visited.add(target.id)
            next.push(target.id)
          }
        }
      }

      if (byMaster.size >= MAX_BOM_CANDIDATES) break
      frontier = next
    }

    return [...byMaster.values()]
  }

  /**
   * Recorded decisions for one assembly, as nodeKey -> partMasterId.
   *
   * A `null` value is a node someone marked as not a part, which the map has
   * to represent distinctly from a node with no decision at all — hence the
   * `has` check at the call site rather than a truthiness test.
   */
  private static async overridesFor(
    assemblyMasterId: string,
  ): Promise<Map<string, string | null>> {
    const rows = await db
      .select({
        nodeKey: cadModelNodeLinks.nodeKey,
        partMasterId: cadModelNodeLinks.partMasterId,
      })
      .from(cadModelNodeLinks)
      .where(eq(cadModelNodeLinks.assemblyMasterId, assemblyMasterId))

    return new Map(rows.map((row) => [row.nodeKey, row.partMasterId]))
  }
}

/**
 * A candidate as the wire carries it: its identity, without the normalized
 * strings the matcher compares on. Those are an implementation detail of
 * matching and would only invite a client to match on its own.
 */
function toPart(candidate: MatchCandidate): CadModelNodeCandidate {
  return {
    itemId: candidate.itemId,
    masterId: candidate.masterId,
    itemNumber: candidate.itemNumber,
    name: candidate.name,
    itemType: candidate.itemType,
    revision: candidate.revision,
    state: candidate.state,
  }
}
