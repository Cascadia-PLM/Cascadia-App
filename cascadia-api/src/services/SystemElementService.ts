// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * System elements: the logical architecture of a design (systems-engineering
 * Phase 5). An element is a versioned, ECO-controlled item; the architecture
 * is two edge types on it:
 *
 * - `DECOMPOSES` (element → child element) is the tree. It is deliberately
 *   not the BOM — one tree serving two masters was rejected in the proposal
 *   — and `ItemRelationshipService` refuses an edge that would close a loop.
 * - `REALIZED_BY` (element → Part/Software) is the hop from the logical
 *   element to the item that implements it, and the hop the requirements
 *   matrix follows after an allocation to the element.
 *
 * An element also carries its **ports** — named connection points, a field
 * of its own row — and the design's **interfaces** (items of their own, see
 * `InterfaceService`) attach to them by `CONNECTS` edges (interface →
 * element). The architecture read returns both.
 *
 * Both are edges between version rows, so they ride a checkout onto the
 * branch's working copy and the release rebuilds them on the released row,
 * like every other outgoing edge. The architecture read here resolves them
 * at a version context by the rules the requirements matrix applies — the
 * same helpers, so the two surfaces never disagree about which row answers
 * for an item at a tag.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { CONNECTS_PORT_KEY } from '@cascadia/commons/items/types/interface'
import {
  MAX_SYSTEM_PORTS,
  systemPortsSchema,
} from '@cascadia/commons/items/types/system-element'
import { userMetadataOf } from '@cascadia/commons/items/relationships/metadata'
import { db } from '../db'
import { notDeleted } from '../db/filters'
import { architectureLayouts } from '../db/schema/designs'
import {
  interfaces,
  itemRelationships,
  items,
  systemElements,
} from '../db/schema/items'
import { NotFoundError, ValidationError } from '../errors'
import { ItemService } from '../items/services/ItemService'
import { ItemRelationshipService } from '../items/services/ItemRelationshipService'
import {
  ALLOCATED_TO_RELATIONSHIP,
  CONNECTS_RELATIONSHIP,
  DECOMPOSES_RELATIONSHIP,
  REALIZED_BY_RELATIONSHIP,
} from '../items/traceability-relationships'
import { DesignService } from './DesignService'
import {
  resolveLinkEndIds,
  resolveLinkEnds,
  resolveOnBranch,
} from './link-ends'
import { suspectFields } from './RequirementService'
import {
  RequirementsMatrixService,
  describeContext,
} from './RequirementsMatrixService'
import type { LinkWriteOptions } from './link-ends'
import type { SuspectLinkFields } from './RequirementService'
import type { VersionContext } from './VersionResolver'
import type { SuspectState } from '../items/trace-affirmation'
import type { PersistedItem } from '@cascadia/commons/items/types/base'
import type {
  SystemElement,
  SystemPort,
  SystemPortDirection,
} from '@cascadia/commons/items/types/system-element'
import type {
  ArchitectureInterface,
  ArchitectureLayout,
  ArchitectureLink,
  ArchitectureNode,
  ArchitectureTotals,
  DesignArchitecture,
} from '@cascadia/commons/services/types/architecture'

// Wire types live in commons so the web can name them; re-exported so server
// callers keep importing them from here.
export type {
  ArchitectureInterface,
  ArchitectureLayout,
  ArchitectureLink,
  ArchitectureNode,
  ArchitectureTotals,
  DesignArchitecture,
} from '@cascadia/commons/services/types/architecture'

type ItemRow = typeof items.$inferSelect
type EdgeRow = typeof itemRelationships.$inferSelect

/** A child or parent element, as the element's own tree reads list it. */
export interface RelatedElement {
  id: string
  masterId: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  elementKind: string | null
  relationshipId: string
}

/** An item linked to an element by a suspectable edge. */
export interface ElementLinkedItem extends SuspectLinkFields {
  id: string
  itemNumber: string
  name: string | null
  itemType: string
  revision: string
  state: string
  relationshipId: string
}

const ITEM_SUMMARY = {
  id: items.id,
  masterId: items.masterId,
  itemNumber: items.itemNumber,
  name: items.name,
  itemType: items.itemType,
  revision: items.revision,
  state: items.state,
}

/** What a caller says about a port; the id is the server's. */
export interface PortInput {
  name: string
  direction: SystemPortDirection
  description?: string
}

/** The port a `CONNECTS` edge names in its metadata, if it names one. */
export function portIdOf(metadata: unknown): string | null {
  const portId = userMetadataOf(metadata)?.[CONNECTS_PORT_KEY]
  return typeof portId === 'string' && portId ? portId : null
}

function byItemNumber<T extends { itemNumber: string }>(a: T, b: T): number {
  return a.itemNumber.localeCompare(b.itemNumber)
}

export class SystemElementService {
  // ---- The element's own reads ------------------------------------------

  private static async requireElement(
    elementId: string,
    operation: string,
  ): Promise<PersistedItem> {
    const element = await ItemService.findById(elementId)
    if (!element || element.itemType !== 'SystemElement') {
      throw new NotFoundError('SystemElement', elementId, { operation })
    }
    return element
  }

  private static async elementSummaries(
    rows: Array<EdgeRow>,
    end: 'sourceId' | 'targetId',
  ): Promise<Array<RelatedElement>> {
    if (rows.length === 0) return []
    const ids = rows.map((row) => row[end])
    const summaries = await db
      .select({ ...ITEM_SUMMARY, elementKind: systemElements.elementKind })
      .from(items)
      .leftJoin(systemElements, eq(systemElements.itemId, items.id))
      .where(and(inArray(items.id, ids), notDeleted()))
    return summaries
      .map((row) => {
        const edge = rows.find((candidate) => candidate[end] === row.id)
        return {
          id: row.id,
          masterId: row.masterId,
          itemNumber: row.itemNumber,
          name: row.name,
          revision: row.revision,
          state: row.state,
          elementKind: row.elementKind,
          relationshipId: edge!.id,
        }
      })
      .sort(byItemNumber)
  }

  /** The elements this element decomposes into (outgoing `DECOMPOSES`). */
  static async getChildren(elementId: string): Promise<Array<RelatedElement>> {
    const edges =
      (
        await ItemRelationshipService.findOutgoingLinks(
          [elementId],
          DECOMPOSES_RELATIONSHIP,
        )
      ).get(elementId) ?? []
    return this.elementSummaries(edges, 'targetId')
  }

  /**
   * The element this one sits under (incoming `DECOMPOSES`), or null for a
   * root. An element placed under two parents answers with the first by
   * item number, as the design's tree does.
   */
  static async getParent(elementId: string): Promise<RelatedElement | null> {
    const edges =
      (
        await ItemRelationshipService.findIncomingLinks(
          [elementId],
          DECOMPOSES_RELATIONSHIP,
        )
      ).get(elementId) ?? []
    const parents = await this.elementSummaries(edges, 'sourceId')
    return parents[0] ?? null
  }

  /**
   * Place `childIds` under `parentId`. Both ends must be system elements of
   * one design; an edge that would close a loop is refused by the
   * relationship service, which is what `POST /items/:id/relationships`
   * and the AI tools go through as well.
   */
  static async addChildren(
    parentId: string,
    childIds: Array<string>,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<void> {
    const parent = await this.requireElement(parentId, 'addChildren')
    for (const childId of childIds) {
      const child = await this.requireElement(childId, 'addChildren')
      if (child.designId !== parent.designId) {
        throw new ValidationError(
          `${child.itemNumber} is not in the same design as ${parent.itemNumber}; the architecture tree does not cross designs`,
          [{ field: 'itemIds', message: 'Child element is in another design' }],
        )
      }
      await this.link(parent, child, DECOMPOSES_RELATIONSHIP, userId, options)
    }
  }

  static async removeChild(
    parentId: string,
    childId: string,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<void> {
    await this.unlink(
      parentId,
      childId,
      DECOMPOSES_RELATIONSHIP,
      userId,
      options,
    )
  }

  /** The items that realize this element (outgoing `REALIZED_BY`). */
  static async getRealizedBy(
    elementId: string,
  ): Promise<Array<ElementLinkedItem>> {
    const edges =
      (
        await ItemRelationshipService.findOutgoingLinks(
          [elementId],
          REALIZED_BY_RELATIONSHIP,
        )
      ).get(elementId) ?? []
    return this.linkedItems(edges, 'targetId')
  }

  /**
   * Record that `itemIds` realize the element. The catalog fixes the item
   * types a realization may name (parts and software).
   */
  static async realize(
    elementId: string,
    itemIds: Array<string>,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<void> {
    const element = await this.requireElement(elementId, 'realize')
    for (const itemId of itemIds) {
      const item = await ItemService.findById(itemId)
      if (!item) {
        throw new NotFoundError('Item', itemId, { operation: 'realize' })
      }
      await this.link(element, item, REALIZED_BY_RELATIONSHIP, userId, options)
    }
  }

  static async unrealize(
    elementId: string,
    itemId: string,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<void> {
    await this.unlink(
      elementId,
      itemId,
      REALIZED_BY_RELATIONSHIP,
      userId,
      options,
    )
  }

  // ---- Ports -------------------------------------------------------------

  /**
   * The element row a port write lands on: the row `branchId` is working
   * from, or the row named. Whether it may be edited is `ItemService.update`'s
   * call — a working copy whose checkout the caller holds, or main before
   * anything in the design has released.
   */
  private static async elementForWrite(
    elementId: string,
    operation: string,
    options?: LinkWriteOptions,
  ): Promise<PersistedItem & { ports: Array<SystemPort> }> {
    const element = await this.requireElement(elementId, operation)
    const row = options?.branchId
      ? await resolveOnBranch(element, options.branchId)
      : element
    return { ...row, ports: (row as SystemElement).ports ?? [] }
  }

  /** The ports of an element as its row at `branchId` (or the row named) has them. */
  static async getPorts(
    elementId: string,
    options?: LinkWriteOptions,
  ): Promise<Array<SystemPort>> {
    return (await this.elementForWrite(elementId, 'getPorts', options)).ports
  }

  /**
   * Store `ports` as the element's port list, after the checks the schema
   * makes of any port list: unique ids, unique names, a bounded count.
   */
  private static async writePorts(
    element: PersistedItem,
    ports: Array<SystemPort>,
    userId: string,
  ): Promise<void> {
    const parsed = systemPortsSchema.safeParse(ports)
    if (!parsed.success) {
      const message =
        ports.length > MAX_SYSTEM_PORTS
          ? `An element holds at most ${MAX_SYSTEM_PORTS} ports`
          : (parsed.error.issues[0]?.message ?? 'Invalid port list')
      throw new ValidationError(`${element.itemNumber}: ${message}`, [
        { field: 'name', message },
      ])
    }
    await ItemService.update<SystemElement>(
      element.id,
      { ports: parsed.data },
      userId,
    )
  }

  /** Add a port to the element; its id is assigned here and never changes. */
  static async addPort(
    elementId: string,
    input: PortInput,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<SystemPort> {
    const element = await this.elementForWrite(elementId, 'addPort', options)
    const port: SystemPort = {
      id: randomUUID(),
      name: input.name.trim(),
      direction: input.direction,
      ...(input.description && { description: input.description }),
    }
    await this.writePorts(element, [...element.ports, port], userId)
    return port
  }

  /** Rename a port, or change its direction or description. */
  static async updatePort(
    elementId: string,
    portId: string,
    patch: Partial<PortInput>,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<SystemPort> {
    const element = await this.elementForWrite(elementId, 'updatePort', options)
    const existing = element.ports.find((port) => port.id === portId)
    if (!existing) {
      throw new NotFoundError('Port', portId, { operation: 'updatePort' })
    }
    const { description, ...rest } = existing
    const nextDescription =
      patch.description === undefined ? description : patch.description
    const updated: SystemPort = {
      ...rest,
      ...(patch.name !== undefined && { name: patch.name.trim() }),
      ...(patch.direction !== undefined && { direction: patch.direction }),
      ...(nextDescription && { description: nextDescription }),
    }
    await this.writePorts(
      element,
      element.ports.map((port) => (port.id === portId ? updated : port)),
      userId,
    )
    return updated
  }

  /**
   * Remove a port. An interface still attached to it is not touched — the
   * interface is its own item, under its own change control — and reads as
   * attached to a missing port until someone re-attaches or detaches it.
   */
  static async removePort(
    elementId: string,
    portId: string,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<void> {
    const element = await this.elementForWrite(elementId, 'removePort', options)
    if (!element.ports.some((port) => port.id === portId)) {
      throw new NotFoundError('Port', portId, { operation: 'removePort' })
    }
    await this.writePorts(
      element,
      element.ports.filter((port) => port.id !== portId),
      userId,
    )
  }

  // ---- The diagram's layout ---------------------------------------------

  /** The saved block positions of a design's diagram; empty when none. */
  static async getLayout(designId: string): Promise<ArchitectureLayout> {
    const [row] = await db
      .select({ positions: architectureLayouts.positions })
      .from(architectureLayouts)
      .where(eq(architectureLayouts.designId, designId))
      .limit(1)
    return row?.positions ?? {}
  }

  /**
   * Save block positions into the design's layout. Merged by element, not
   * replaced: the diagram sends the blocks it drew at one context, and a
   * block that exists only on some other branch keeps the position it had.
   */
  static async saveLayout(
    designId: string,
    positions: ArchitectureLayout,
    userId: string,
  ): Promise<ArchitectureLayout> {
    const design = await DesignService.getById(designId)
    if (!design) {
      throw new NotFoundError('Design', designId, { operation: 'saveLayout' })
    }
    const merged = { ...(await this.getLayout(designId)), ...positions }
    await db
      .insert(architectureLayouts)
      .values({ designId, positions: merged, updatedBy: userId })
      .onConflictDoUpdate({
        target: architectureLayouts.designId,
        set: { positions: merged, updatedBy: userId, updatedAt: new Date() },
      })
    return merged
  }

  /** Forget every saved position: the diagram arranges itself again. */
  static async resetLayout(designId: string): Promise<void> {
    await db
      .delete(architectureLayouts)
      .where(eq(architectureLayouts.designId, designId))
  }

  /**
   * The requirements allocated to this element (incoming `ALLOCATED_TO`),
   * inherited from the rows it succeeded the way every incoming trace read
   * is.
   */
  static async getAllocatedRequirements(
    elementId: string,
  ): Promise<Array<ElementLinkedItem>> {
    const edges =
      (
        await ItemRelationshipService.findIncomingLinks(
          [elementId],
          ALLOCATED_TO_RELATIONSHIP,
        )
      ).get(elementId) ?? []
    return this.linkedItems(edges, 'sourceId')
  }

  private static async linkedItems(
    edges: Array<EdgeRow>,
    end: 'sourceId' | 'targetId',
  ): Promise<Array<ElementLinkedItem>> {
    if (edges.length === 0) return []
    const rows = await db
      .select(ITEM_SUMMARY)
      .from(items)
      .where(
        and(
          inArray(
            items.id,
            edges.map((edge) => edge[end]),
          ),
          notDeleted(),
        ),
      )
    const states = await ItemRelationshipService.suspectStatesFor(
      edges.map((edge) => edge.id),
    )
    return rows
      .map((row) => {
        const edge = edges.find((candidate) => candidate[end] === row.id)!
        return {
          id: row.id,
          itemNumber: row.itemNumber,
          name: row.name,
          itemType: row.itemType,
          revision: row.revision,
          state: row.state,
          relationshipId: edge.id,
          ...suspectFields(states, edge.id),
        }
      })
      .sort(byItemNumber)
  }

  private static async link(
    source: PersistedItem,
    target: PersistedItem,
    relationshipType: string,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<void> {
    const ends = await resolveLinkEnds(source, target, options?.branchId)
    const existing = await db
      .select({ id: itemRelationships.id })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, ends.source.id),
          eq(itemRelationships.targetId, ends.target.id),
          eq(itemRelationships.relationshipType, relationshipType),
        ),
      )
      .limit(1)
    if (existing.length > 0) return
    await ItemService.addRelationship(
      ends.source.id,
      ends.target.id,
      relationshipType,
      userId,
    )
  }

  private static async unlink(
    sourceId: string,
    targetId: string,
    relationshipType: string,
    userId: string,
    options?: LinkWriteOptions,
  ): Promise<void> {
    const ends = await resolveLinkEndIds(sourceId, targetId, options?.branchId)
    const [relationship] = await db
      .select({ id: itemRelationships.id })
      .from(itemRelationships)
      .where(
        and(
          eq(itemRelationships.sourceId, ends.sourceId),
          eq(itemRelationships.targetId, ends.targetId),
          eq(itemRelationships.relationshipType, relationshipType),
        ),
      )
      .limit(1)
    if (relationship) {
      await ItemService.removeRelationship(relationship.id, userId)
    }
  }

  // ---- The design's architecture at a context ---------------------------

  /**
   * The architecture of one design at `context`: the `DECOMPOSES` forest of
   * its system elements, each with the items that realize it and the
   * requirements allocated to it and its ports, the design's interfaces with
   * the ports they attach to, and the diagram's saved layout.
   *
   * Resolution is the requirements matrix's: an element's row at the context
   * answers for the allocations made against the rows it succeeded, a
   * realization or a child is followed to the target's row at the context,
   * and a suspect state is judged there — live at a head, against the rows
   * the snapshot holds at a tag or commit. An element placed under two
   * parents appears under the first by item number; a loop that reached the
   * store despite the write guard is broken at the edge that closes it, so
   * the answer is always a forest.
   */
  static async forDesign(
    designId: string,
    context: VersionContext,
  ): Promise<DesignArchitecture> {
    const design = await DesignService.getById(designId)
    if (!design) {
      throw new NotFoundError('Design', designId, {
        operation: 'designArchitecture',
      })
    }
    const base = {
      designId,
      designCode: design.code,
      designName: design.name,
      context: describeContext(context),
    }

    const atContext = await RequirementsMatrixService.rowsAtContext(
      designId,
      context,
    )
    const elementRows = [...atContext.values()]
      .filter((row) => row.itemType === 'SystemElement')
      .sort(byItemNumber)
    if (elementRows.length === 0) {
      return {
        ...base,
        roots: [],
        interfaces: [],
        layout: {},
        totals: emptyTotals(),
      }
    }
    const elementIds = elementRows.map((row) => row.id)
    const extensionByItem = new Map(
      (
        await db
          .select()
          .from(systemElements)
          .where(inArray(systemElements.itemId, elementIds))
      ).map((row) => [row.itemId, row]),
    )

    // The element's own edges, and the allocations made against it or the
    // rows it succeeded. Working copies never lend theirs.
    const outgoing = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.sourceId, elementIds),
          inArray(itemRelationships.relationshipType, [
            DECOMPOSES_RELATIONSHIP,
            REALIZED_BY_RELATIONSHIP,
          ]),
        ),
      )
    const ancestorToOwner =
      await RequirementsMatrixService.predecessorsOf(elementRows)
    const incoming = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.targetId, [...ancestorToOwner.keys()]),
          eq(itemRelationships.relationshipType, ALLOCATED_TO_RELATIONSHIP),
        ),
      )

    const namedIds = [
      ...new Set([
        ...outgoing.map((edge) => edge.targetId),
        ...incoming.map((edge) => edge.sourceId),
      ]),
    ]
    const namedRows =
      namedIds.length > 0
        ? await db.select().from(items).where(inArray(items.id, namedIds))
        : []
    const namedById = new Map(namedRows.map((row) => [row.id, row]))
    const resolvedByMaster =
      await RequirementsMatrixService.resolveCounterparts(
        designId,
        atContext,
        namedRows,
      )

    // A child or a realization is followed to the target's row at the
    // context; an allocation counts only when its source row IS the
    // requirement's row there.
    const keptOutgoing = outgoing.filter((edge) => {
      const named = namedById.get(edge.targetId)
      return (
        named !== undefined && Boolean(resolvedByMaster.get(named.masterId))
      )
    })
    const keptIncoming = incoming.filter((edge) => {
      const named = namedById.get(edge.sourceId)
      const resolved = named ? resolvedByMaster.get(named.masterId) : undefined
      return (
        resolved !== undefined &&
        resolved !== null &&
        resolved.id === edge.sourceId
      )
    })

    const rowById = new Map<string, ItemRow>()
    for (const row of elementRows) rowById.set(row.id, row)
    for (const row of resolvedByMaster.values()) {
      if (row) rowById.set(row.id, row)
    }
    const suspectStates = await RequirementsMatrixService.suspectStates(
      context,
      keptIncoming,
      keptOutgoing,
      ancestorToOwner,
      namedById,
      resolvedByMaster,
      rowById,
    )

    const toLink = (
      edge: EdgeRow,
      row: ItemRow,
      state: SuspectState | undefined,
    ): ArchitectureLink => ({
      relationshipId: edge.id,
      itemId: row.id,
      masterId: row.masterId,
      itemNumber: row.itemNumber,
      name: row.name,
      itemType: row.itemType,
      revision: row.revision,
      state: row.state,
      suspect: state?.suspect ?? false,
      suspectReasons: state?.reasons ?? [],
    })

    const nodeById = new Map<string, ArchitectureNode>()
    for (const row of elementRows) {
      const extension = extensionByItem.get(row.id)
      nodeById.set(row.id, {
        itemId: row.id,
        masterId: row.masterId,
        itemNumber: row.itemNumber,
        name: row.name,
        revision: row.revision,
        state: row.state,
        elementKind: extension?.elementKind ?? null,
        description: extension?.description ?? null,
        ports: extension?.ports ?? [],
        realizedBy: [],
        allocatedRequirements: [],
        children: [],
      })
    }

    // Edges in item-number order of their source, then target, so "first
    // parent wins" and the dedup below are deterministic.
    const orderedOutgoing = [...keptOutgoing].sort((a, b) => {
      const bySource = byItemNumber(
        rowById.get(a.sourceId)!,
        rowById.get(b.sourceId)!,
      )
      if (bySource !== 0) return bySource
      const targetA = resolvedByMaster.get(namedById.get(a.targetId)!.masterId)!
      const targetB = resolvedByMaster.get(namedById.get(b.targetId)!.masterId)!
      return byItemNumber(targetA, targetB)
    })
    const parentOf = new Map<string, string>()
    const seen = new Set<string>()
    for (const edge of orderedOutgoing) {
      const node = nodeById.get(edge.sourceId)
      if (!node) continue
      const target = resolvedByMaster.get(
        namedById.get(edge.targetId)!.masterId,
      )!
      const key = `${edge.relationshipType}:${edge.sourceId}:${target.masterId}`
      if (seen.has(key)) continue
      seen.add(key)
      if (edge.relationshipType === DECOMPOSES_RELATIONSHIP) {
        const child = nodeById.get(target.id)
        if (!child || child === node || parentOf.has(child.itemId)) continue
        parentOf.set(child.itemId, node.itemId)
        child.relationshipId = edge.id
        node.children.push(child)
      } else {
        node.realizedBy.push(toLink(edge, target, suspectStates.get(edge.id)))
      }
    }
    for (const edge of keptIncoming) {
      const owner = ancestorToOwner.get(edge.targetId)
      const node = owner ? nodeById.get(owner) : undefined
      const source = namedById.get(edge.sourceId)
      if (!node || !source) continue
      const key = `allocated:${node.itemId}:${source.masterId}`
      if (seen.has(key)) continue
      seen.add(key)
      node.allocatedRequirements.push(
        toLink(edge, source, suspectStates.get(edge.id)),
      )
    }

    // Roots are the unparented elements. A loop has no root, so whatever is
    // not reachable from one is promoted and the edge closing the loop is
    // dropped on the way down.
    const roots = [...nodeById.values()].filter(
      (node) => !parentOf.has(node.itemId),
    )
    const reached = new Set<string>()
    const prune = (node: ArchitectureNode, stack: Set<string>) => {
      reached.add(node.itemId)
      stack.add(node.itemId)
      node.children = node.children.filter((child) => !stack.has(child.itemId))
      for (const child of node.children) {
        if (!reached.has(child.itemId)) prune(child, stack)
      }
      stack.delete(node.itemId)
    }
    for (const root of roots) prune(root, new Set())
    for (const node of nodeById.values()) {
      if (!reached.has(node.itemId)) {
        roots.push(node)
        prune(node, new Set())
      }
    }
    roots.sort(byItemNumber)

    const architectureInterfaces = await this.interfacesAt(
      [...atContext.values()],
      [...nodeById.values()],
    )

    // Only positions of what is drawn at this context cross the wire: the
    // stored map also remembers blocks that exist on other branches.
    const saved = await this.getLayout(designId)
    const layout: ArchitectureLayout = {}
    for (const { masterId } of [
      ...nodeById.values(),
      ...architectureInterfaces,
    ]) {
      const position = saved[masterId]
      if (position) layout[masterId] = position
    }

    return {
      ...base,
      roots,
      interfaces: architectureInterfaces,
      layout,
      totals: totalsOf([...nodeById.values()]),
    }
  }

  /**
   * The design's interfaces among `rowsAtContext`, each with its ends: the
   * `CONNECTS` edges of the interface's own row, followed by master to the
   * element's row at the context. An end whose element is not at the context
   * is left out; one whose port the element no longer has is flagged.
   */
  private static async interfacesAt(
    rowsAtContext: Array<ItemRow>,
    nodes: Array<ArchitectureNode>,
  ): Promise<Array<ArchitectureInterface>> {
    const interfaceRows = rowsAtContext
      .filter((row) => row.itemType === 'Interface')
      .sort(byItemNumber)
    if (interfaceRows.length === 0) return []
    const interfaceIds = interfaceRows.map((row) => row.id)

    const kindByItem = new Map(
      (
        await db
          .select()
          .from(interfaces)
          .where(inArray(interfaces.itemId, interfaceIds))
      ).map((row) => [row.itemId, row.interfaceKind]),
    )
    const edges = await db
      .select()
      .from(itemRelationships)
      .where(
        and(
          inArray(itemRelationships.sourceId, interfaceIds),
          eq(itemRelationships.relationshipType, CONNECTS_RELATIONSHIP),
        ),
      )
    const targetIds = [...new Set(edges.map((edge) => edge.targetId))]
    const masterOfTarget = new Map(
      targetIds.length > 0
        ? (
            await db
              .select({ id: items.id, masterId: items.masterId })
              .from(items)
              .where(inArray(items.id, targetIds))
          ).map((row) => [row.id, row.masterId])
        : [],
    )
    const nodeByMaster = new Map(nodes.map((node) => [node.masterId, node]))

    return interfaceRows.map((row) => {
      const seen = new Set<string>()
      const ends = edges
        .filter((edge) => edge.sourceId === row.id)
        .flatMap((edge) => {
          const master = masterOfTarget.get(edge.targetId)
          const node = master ? nodeByMaster.get(master) : undefined
          // One end per element: an edge to a superseded row of an element
          // already attached says nothing new.
          if (!node || seen.has(node.itemId)) return []
          seen.add(node.itemId)
          const portId = portIdOf(edge.metadata)
          return [
            {
              relationshipId: edge.id,
              elementItemId: node.itemId,
              portId,
              portMissing:
                portId !== null &&
                !node.ports.some((port) => port.id === portId),
            },
          ]
        })
      return {
        itemId: row.id,
        masterId: row.masterId,
        itemNumber: row.itemNumber,
        name: row.name,
        revision: row.revision,
        state: row.state,
        kind: kindByItem.get(row.id) ?? null,
        ends,
      }
    })
  }
}

function emptyTotals(): ArchitectureTotals {
  return { elements: 0, realized: 0, allocated: 0, suspect: 0 }
}

function totalsOf(nodes: Array<ArchitectureNode>): ArchitectureTotals {
  const totals = emptyTotals()
  totals.elements = nodes.length
  for (const node of nodes) {
    if (node.realizedBy.length > 0) totals.realized += 1
    if (node.allocatedRequirements.length > 0) totals.allocated += 1
    totals.suspect += [
      ...node.realizedBy,
      ...node.allocatedRequirements,
    ].filter((link) => link.suspect).length
  }
  return totals
}
