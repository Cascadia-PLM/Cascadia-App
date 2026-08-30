// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Item relationship graph — the walk behind GET /items/:id/graph.
 *
 * Extracted from the route file (GRAPH-2) and restructured from a per-node
 * queue into per-depth-level frontiers: every query the old walk ran once per
 * node — the item row, its lineage, its relationships, pinned incoming edges,
 * usage lookups, the physical-domain bridges, attached files — now runs once
 * per *level* over the whole frontier, so a walk's query count is O(depth),
 * not O(nodes).
 *
 * The output contract is unchanged and deliberately frozen: node and edge
 * construction, the canonical-node dedup across revisions (first seen wins,
 * in frontier order), the edge remap second pass, and level assignment all
 * work exactly as the route-resident walk did. Batched rows are sorted by id
 * before grouping so repeated walks of the same graph produce identical
 * output — the old per-node queries had no ORDER BY, which left edge and
 * enqueue order to the heap.
 */

import { and, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import { UsageService } from './UsageService'
import { db } from '@/lib/db'
import {
  itemRelationships,
  items,
  physicalParts,
  vaultFiles,
  workOrders,
} from '@/lib/db/schema'
import { notDeleted } from '@/lib/db/filters'
import { designs } from '@/lib/db/schema/designs'

export interface GraphNode {
  id: string
  type: 'itemNode'
  data: {
    itemId: string
    itemNumber: string
    revision: string
    itemType: string
    name: string
    state: string
    level: number // 0 = center, 1 = direct relation, 2 = second-level relation
    // Definition/Usage pattern fields
    isDefinition: boolean
    isUsage: boolean
    usageCount?: number // For definitions: how many usages reference this
    definitionItemNumber?: string // For usages: the item number of the definition
    isCrossDesign?: boolean // True if item is in a different design than the center item
    designCodes?: Array<string> // Design code(s) for cross-design items
  }
  position: { x: number; y: number }
}

// Vault files attached to an item, rendered as leaf nodes hanging below it.
// Files are not items: they never enter the relationship walk and carry no
// expand state — the client renders them with a dedicated component.
export interface FileGraphNode {
  id: string // vault file id
  type: 'fileNode'
  data: {
    fileId: string
    fileName: string
    fileSize: number
    mimeType: string
    fileCategory: string | null
    isPrimaryModel: boolean
    fileVersion: number
    level: number
  }
  position: { x: number; y: number }
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  label?: string
  data: {
    relationshipType: string
    quantity?: string | null
    referenceDesignator?: string | null
    findNumber?: number | null
    isUsageRelationship?: boolean // True for usageOf edges
    isPhysicalRelationship?: boolean // True for derived INSTANCE_OF/BUILDS edges
    isFileRelationship?: boolean // True for derived ATTACHED_FILE edges
  }
}

export interface GraphData {
  nodes: Array<GraphNode | FileGraphNode>
  edges: Array<GraphEdge>
}

export interface ItemGraphOptions {
  depth: number
  direction: 'all' | 'outgoing' | 'incoming'
  /** Empty array = no type filter. */
  relationshipTypes: Array<string>
  includeUsages: boolean
  includeFiles: boolean
  /** Branch context for file visibility only. */
  fileBranchId?: string
  /**
   * The caller's reachable designs: null is unrestricted; a Set reaches only
   * those designs, and an empty Set reaches none. Conflating null with the
   * empty set would invert the whole check — resolve it with
   * `AccessControlService.getAccessibleDesignIds` and pass it verbatim.
   */
  designScope: Set<string> | null
  /** The center item's design, for cross-design flagging. */
  centerDesignId: string | null
}

/**
 * Synthetic physical-domain edge types derived from columns rather than
 * stored relationships (physical_parts.partMasterId, work_orders.partId).
 * They are emitted in top-down display direction — part → instance and
 * part → work order — so the physical domain hangs below the design
 * domains and expanding a part downstream reveals it.
 */
const GRAPH_INSTANCE_OF = 'INSTANCE_OF'

const GRAPH_BUILDS = 'BUILDS'

/** Stored physical edges; always WO/PhysicalPart as edge source. */
const PHYSICAL_STORED_TYPES = ['Consumes', 'Produces', 'Evidences']

/**
 * Synthetic attachment edge from an item to a vault file it carries
 * (vault_files.itemId is a column, not a stored relationship). Emitted
 * top-down — item → file — so files hang below their owner and expanding
 * an item downstream reveals them. Opt-in via ?includeFiles=true.
 */
const GRAPH_ATTACHED_FILE = 'ATTACHED_FILE'

/** Display labels for derived edges (arrow reads source → target). */
const SYNTHETIC_EDGE_LABELS: Record<string, string> = {
  [GRAPH_INSTANCE_OF]: 'instance',
  [GRAPH_BUILDS]: 'built by',
  [GRAPH_ATTACHED_FILE]: 'file',
}

/** The base-table projection the walk reads — no type-specific enrichment. */
interface WalkItem {
  id: string
  masterId: string | null
  designId: string | null
  itemNumber: string | null
  revision: string
  itemType: string
  name: string | null
  state: string | null
  usageOf: string | null
}

interface CollectedRelationship {
  sourceId: string
  targetId: string
  relationshipType: string
  quantity: string | null
  referenceDesignator: string | null
  findNumber: number | null
  isUsageRelationship?: boolean
  isPhysicalRelationship?: boolean
}

/** Stable in-code ordering for batched rows (queries carry no ORDER BY). */
function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export class GraphService {
  /**
   * Walk the relationship neighbourhood of `rootId` and return the graph the
   * client renders — `{ nodes, edges }`, un-enveloped by design.
   *
   * Access decisions stay with the caller: the route gates the center item
   * and resolves `designScope`; the walk only prunes with it. Skipping an
   * unreachable item before it enters the key maps is what also drops its
   * edges — the second pass adds an edge only when both endpoints resolved
   * to a node.
   */
  static async buildItemGraph(
    rootId: string,
    opts: ItemGraphOptions,
  ): Promise<GraphData> {
    const {
      depth,
      direction,
      relationshipTypes,
      includeUsages,
      includeFiles,
      fileBranchId,
      designScope,
      centerDesignId,
    } = opts

    const typeAllowed = (relationshipType: string) =>
      relationshipTypes.length === 0 ||
      relationshipTypes.includes(relationshipType)

    const graphData: GraphData = { nodes: [], edges: [] }

    // Track visited items by itemNumber+designId to deduplicate revisions
    // but keep usages and definitions as separate nodes (they may share
    // itemNumber). Map (itemNumber + designId) -> canonical node ID.
    const visitedItemKeys = new Map<string, string>()
    // Cache itemId -> composite key for edge remapping
    const itemIdToKey = new Map<string, string>()
    // Cache itemId -> designId for cross-design detection
    const itemIdToDesignId = new Map<string, string | null>()
    // Also track raw item IDs we've processed to avoid reprocessing
    const processedItemIds = new Set<string>()
    // Collect all relationships for edge creation after nodes are processed
    const collectedRelationships: Array<CollectedRelationship> = []

    let frontier: Array<{ itemId: string; level: number }> = [
      { itemId: rootId, level: 0 },
    ]

    while (frontier.length > 0) {
      const level = frontier[0]!.level
      if (level > depth) break

      // Dedup the frontier in first-enqueued order — the same order the old
      // queue would have shifted them, which is what "first seen wins" keys
      // canonical-node selection to.
      const ids: Array<string> = []
      for (const entry of frontier) {
        if (!processedItemIds.has(entry.itemId)) {
          processedItemIds.add(entry.itemId)
          ids.push(entry.itemId)
        }
      }
      const nextFrontier: Array<{ itemId: string; level: number }> = []
      if (ids.length === 0) break

      // ---- Level batch: the item rows (base columns only) ----
      const rows = await db
        .select({
          id: items.id,
          masterId: items.masterId,
          designId: items.designId,
          itemNumber: items.itemNumber,
          revision: items.revision,
          itemType: items.itemType,
          name: items.name,
          state: items.state,
          usageOf: items.usageOf,
        })
        .from(items)
        .where(and(inArray(items.id, ids), notDeleted()))
      const rowById = new Map<string, WalkItem>(rows.map((r) => [r.id, r]))

      // Reachability pass, in frontier order. Out of the caller's reach:
      // drop it before it reaches itemIdToKey. A design-less item stays,
      // matching every other read, which gates only on a design the item
      // actually has.
      const levelItems: Array<WalkItem> = []
      for (const id of ids) {
        const row = rowById.get(id)
        if (!row) continue
        if (designScope && row.designId && !designScope.has(row.designId)) {
          continue
        }
        levelItems.push(row)
      }
      if (levelItems.length === 0) {
        frontier = nextFrontier
        continue
      }

      // Canonical-node resolution, in frontier order, before the dependent
      // batches — usage counts and files are fetched only for canonical rows.
      const canonicalIds = new Set<string>()
      for (const item of levelItems) {
        const compositeKey = `${item.itemNumber ?? ''}::${item.designId ?? 'no-design'}`
        itemIdToKey.set(item.id, compositeKey)
        itemIdToDesignId.set(item.id, item.designId)
        if (!visitedItemKeys.has(compositeKey)) {
          visitedItemKeys.set(compositeKey, item.id)
          canonicalIds.add(item.id)
        }
      }

      const levelIds = levelItems.map((i) => i.id)

      // ---- Level batch: every row of each item's lineage ----
      // A stored edge names one item *version*, and the row rendered here is
      // often not the one it names, so both the relationship walk and the
      // physical bridge need to know which other rows stand for the same item.
      const masterIds = [
        ...new Set(
          levelItems
            .map((i) => i.masterId)
            .filter((m): m is string => m !== null),
        ),
      ]
      const lineageRows =
        masterIds.length > 0
          ? await db
              .select({ id: items.id, masterId: items.masterId })
              .from(items)
              .where(and(inArray(items.masterId, masterIds), notDeleted()))
          : []
      lineageRows.sort(byId)
      const lineageByMaster = new Map<string, Array<string>>()
      for (const row of lineageRows) {
        if (!row.masterId) continue
        const list = lineageByMaster.get(row.masterId) ?? []
        list.push(row.id)
        lineageByMaster.set(row.masterId, list)
      }
      const lineageIdsOf = (item: WalkItem): Array<string> =>
        item.masterId ? (lineageByMaster.get(item.masterId) ?? []) : []
      const otherVersionIdsOf = (item: WalkItem): Array<string> =>
        lineageIdsOf(item).filter((id) => id !== item.id)

      // Which lineage row belongs to which frontier item, for regrouping the
      // pinned-incoming rows below.
      const otherVersionOwner = new Map<string, Array<string>>()
      for (const item of levelItems) {
        for (const versionId of otherVersionIdsOf(item)) {
          const owners = otherVersionOwner.get(versionId) ?? []
          owners.push(item.id)
          otherVersionOwner.set(versionId, owners)
        }
      }
      const allOtherVersionIds = [...otherVersionOwner.keys()]

      // ---- Level batch: stored relationships — direct and lineage-pinned
      // in one query, split in code ----
      const directConditions = []
      if (direction === 'outgoing') {
        directConditions.push(inArray(itemRelationships.sourceId, levelIds))
      } else if (direction === 'incoming') {
        directConditions.push(inArray(itemRelationships.targetId, levelIds))
      } else {
        directConditions.push(
          inArray(itemRelationships.sourceId, levelIds),
          inArray(itemRelationships.targetId, levelIds),
        )
      }
      // Incoming edges pinned to another row of a lineage: a merge re-points
      // only the lines owned by the items the change order touched, so an
      // assembly it never touched keeps naming the row the release
      // superseded. Matching the rendered row alone, a released revision
      // looked unused the moment it was released.
      if (direction !== 'outgoing' && allOtherVersionIds.length > 0) {
        directConditions.push(
          inArray(itemRelationships.targetId, allOtherVersionIds),
        )
      }
      const relationshipRows = await db
        .select()
        .from(itemRelationships)
        .where(or(...directConditions))
      relationshipRows.sort(byId)

      const levelIdSet = new Set(levelIds)
      const directRelsByItem = new Map<
        string,
        Array<(typeof relationshipRows)[number]>
      >()
      const pinnedRelsByItem = new Map<
        string,
        Array<(typeof relationshipRows)[number]>
      >()
      const attach = (
        map: Map<string, Array<(typeof relationshipRows)[number]>>,
        itemId: string,
        rel: (typeof relationshipRows)[number],
      ) => {
        const list = map.get(itemId) ?? []
        list.push(rel)
        map.set(itemId, list)
      }
      for (const rel of relationshipRows) {
        // Direct hits — matching the old per-node queries, a relationship
        // between two frontier items is collected once per matching endpoint
        // (the edge-id dedup in the second pass collapses the duplicates).
        if (direction !== 'incoming' && levelIdSet.has(rel.sourceId)) {
          attach(directRelsByItem, rel.sourceId, rel)
        }
        if (direction !== 'outgoing' && levelIdSet.has(rel.targetId)) {
          attach(directRelsByItem, rel.targetId, rel)
        }
        // Lineage-pinned hits, regrouped to the frontier item whose lineage
        // carries the named version row.
        if (direction !== 'outgoing') {
          for (const owner of otherVersionOwner.get(rel.targetId) ?? []) {
            attach(pinnedRelsByItem, owner, rel)
          }
        }
      }

      // ---- Level batch: usage rows for every definition in the frontier ----
      // One query serves both getUsageCount (group size) and
      // getUsagesOfDefinition (the rows): the walk only asks for items that
      // are themselves definitions, so UsageService's resolveDefinition chain
      // is the identity here.
      const definitionIds = includeUsages
        ? levelItems
            .filter((i) => UsageService.isDefinition(i))
            .map((i) => i.id)
        : []
      const usageRows =
        definitionIds.length > 0
          ? await db
              .select({ id: items.id, usageOf: items.usageOf })
              .from(items)
              .where(and(inArray(items.usageOf, definitionIds), notDeleted()))
          : []
      usageRows.sort(byId)
      const usagesByDefinition = new Map<string, Array<string>>()
      for (const row of usageRows) {
        if (!row.usageOf) continue
        const list = usagesByDefinition.get(row.usageOf) ?? []
        list.push(row.id)
        usagesByDefinition.set(row.usageOf, list)
      }

      // ---- Level batch: definition item numbers for the frontier's usages ----
      const usageDefinitionIds = [
        ...new Set(
          levelItems
            .map((i) => i.usageOf)
            .filter((d): d is string => d !== null),
        ),
      ]
      const definitionRows =
        usageDefinitionIds.length > 0
          ? await db
              .select({ id: items.id, itemNumber: items.itemNumber })
              .from(items)
              .where(and(inArray(items.id, usageDefinitionIds), notDeleted()))
          : []
      const definitionNumberById = new Map(
        definitionRows.map((r) => [r.id, r.itemNumber]),
      )

      // ---- Level batch: physical-domain bridges ----
      const walkPhysical = direction !== 'outgoing'
      const woItemIds = walkPhysical
        ? levelItems.filter((i) => i.itemType === 'WorkOrder').map((i) => i.id)
        : []
      const woRows =
        woItemIds.length > 0 && typeAllowed(GRAPH_BUILDS)
          ? await db
              .select({ itemId: workOrders.itemId, partId: workOrders.partId })
              .from(workOrders)
              .where(inArray(workOrders.itemId, woItemIds))
          : []
      const woPartByItem = new Map(woRows.map((r) => [r.itemId, r.partId]))

      const ppItemIds = walkPhysical
        ? levelItems
            .filter((i) => i.itemType === 'PhysicalPart')
            .map((i) => i.id)
        : []
      const ppRows =
        ppItemIds.length > 0 && typeAllowed(GRAPH_INSTANCE_OF)
          ? await db
              .select({
                itemId: physicalParts.itemId,
                partMasterId: physicalParts.partMasterId,
                asBuiltItemId: physicalParts.asBuiltItemId,
              })
              .from(physicalParts)
              .where(inArray(physicalParts.itemId, ppItemIds))
          : []
      const ppByItem = new Map(ppRows.map((r) => [r.itemId, r]))
      // The as-built pin when recorded (and not deleted — a deleted as-built
      // row yields no edge, it does not fall back), else the lineage's
      // current version.
      const asBuiltIds = ppRows
        .map((r) => r.asBuiltItemId)
        .filter((id): id is string => id !== null)
      const asBuiltRows =
        asBuiltIds.length > 0
          ? await db
              .select({ id: items.id })
              .from(items)
              .where(and(inArray(items.id, asBuiltIds), notDeleted()))
          : []
      const liveAsBuilt = new Set(asBuiltRows.map((r) => r.id))
      const fallbackMasterIds = [
        ...new Set(
          ppRows.filter((r) => !r.asBuiltItemId).map((r) => r.partMasterId),
        ),
      ]
      const currentPartRows =
        fallbackMasterIds.length > 0
          ? await db
              .select({ id: items.id, masterId: items.masterId })
              .from(items)
              .where(
                and(
                  inArray(items.masterId, fallbackMasterIds),
                  eq(items.itemType, 'Part'),
                  eq(items.isCurrent, true),
                  notDeleted(),
                ),
              )
          : []
      currentPartRows.sort(byId)
      const currentPartByMaster = new Map<string, string>()
      for (const row of currentPartRows) {
        if (row.masterId && !currentPartByMaster.has(row.masterId)) {
          currentPartByMaster.set(row.masterId, row.id)
        }
      }

      // Physical instances and building work orders of the frontier's Parts.
      const partItems = levelItems.filter(
        (i) => i.itemType === 'Part' && i.masterId !== null,
      )
      const walkPartPhysical = direction !== 'incoming' && partItems.length > 0
      const partMasterIds = walkPartPhysical
        ? [...new Set(partItems.map((i) => i.masterId as string))]
        : []
      const instanceRows =
        partMasterIds.length > 0 && typeAllowed(GRAPH_INSTANCE_OF)
          ? await db
              .select({
                itemId: physicalParts.itemId,
                partMasterId: physicalParts.partMasterId,
              })
              .from(physicalParts)
              .innerJoin(items, eq(items.id, physicalParts.itemId))
              .where(
                and(
                  inArray(physicalParts.partMasterId, partMasterIds),
                  notDeleted(),
                ),
              )
          : []
      instanceRows.sort((a, b) =>
        a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0,
      )
      const instancesByMaster = new Map<string, Array<string>>()
      for (const row of instanceRows) {
        const list = instancesByMaster.get(row.partMasterId) ?? []
        list.push(row.itemId)
        instancesByMaster.set(row.partMasterId, list)
      }
      const partLineageIds = walkPartPhysical
        ? [...new Set(partItems.flatMap((i) => lineageIdsOf(i)))]
        : []
      const buildingWoRows =
        partLineageIds.length > 0 && typeAllowed(GRAPH_BUILDS)
          ? await db
              .select({
                itemId: workOrders.itemId,
                partId: workOrders.partId,
              })
              .from(workOrders)
              .innerJoin(items, eq(items.id, workOrders.itemId))
              .where(
                and(inArray(workOrders.partId, partLineageIds), notDeleted()),
              )
          : []
      buildingWoRows.sort((a, b) =>
        a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0,
      )
      const buildingWosByPartVersion = new Map<string, Array<string>>()
      for (const row of buildingWoRows) {
        if (!row.partId) continue
        const list = buildingWosByPartVersion.get(row.partId) ?? []
        list.push(row.itemId)
        buildingWosByPartVersion.set(row.partId, list)
      }

      // ---- Level batch: attached vault files ----
      // Files hang off the canonical (first-rendered) row of an item, one
      // level below their owner: frontier items at the depth cap contribute
      // none — their files appear when the node is expanded instead.
      const fileOwnerIds =
        includeFiles &&
        direction !== 'incoming' &&
        level < depth &&
        typeAllowed(GRAPH_ATTACHED_FILE)
          ? levelIds.filter((id) => canonicalIds.has(id))
          : []
      let filesByOwner = new Map<
        string,
        Array<typeof vaultFiles.$inferSelect>
      >()
      if (fileOwnerIds.length > 0) {
        const fileConditions = [
          inArray(vaultFiles.itemId, fileOwnerIds),
          eq(vaultFiles.isLatestVersion, true),
          isNull(vaultFiles.deletedAt),
          // Generated thumbnails are internal artifacts, not attachments
          or(
            isNull(vaultFiles.fileCategory),
            ne(vaultFiles.fileCategory, 'thumbnail'),
          ),
        ]
        if (fileBranchId) {
          fileConditions.push(
            or(
              isNull(vaultFiles.branchId),
              eq(vaultFiles.branchId, fileBranchId),
            ),
          )
        }
        const fileRows = await db
          .select()
          .from(vaultFiles)
          .where(and(...fileConditions))
        fileRows.sort(byId)
        filesByOwner = new Map()
        for (const file of fileRows) {
          if (!file.itemId) continue
          const list = filesByOwner.get(file.itemId) ?? []
          list.push(file)
          filesByOwner.set(file.itemId, list)
        }
      }

      // ---- Emit pass: nodes, collected edges, and the next frontier, in
      // frontier order — the same order and logic the queue walk used ----
      const enqueue = (itemId: string) => {
        if (!processedItemIds.has(itemId)) {
          nextFrontier.push({ itemId, level: level + 1 })
        }
      }

      for (const item of levelItems) {
        const itemId = item.id
        const isCanonical = canonicalIds.has(itemId)

        if (isCanonical) {
          const isDefinition = UsageService.isDefinition(item)
          const isUsage = UsageService.isUsage(item)

          let usageCount: number | undefined
          if (isDefinition && includeUsages) {
            usageCount = (usagesByDefinition.get(itemId) ?? []).length
          }

          let definitionItemNumber: string | undefined
          if (isUsage && item.usageOf) {
            definitionItemNumber =
              definitionNumberById.get(item.usageOf) ?? undefined
          }

          const isCrossDesign =
            item.designId != null &&
            centerDesignId != null &&
            item.designId !== centerDesignId

          graphData.nodes.push({
            id: itemId,
            type: 'itemNode',
            data: {
              itemId,
              itemNumber: item.itemNumber ?? '',
              revision: item.revision,
              itemType: item.itemType,
              name: item.name || '',
              state: item.state || '',
              level,
              isDefinition,
              isUsage,
              usageCount,
              definitionItemNumber,
              isCrossDesign,
            },
            position: { x: 0, y: 0 }, // Calculated by the client layout
          })
        }

        // Stored relationships touching this row directly.
        for (const rel of directRelsByItem.get(itemId) ?? []) {
          if (!typeAllowed(rel.relationshipType)) continue

          collectedRelationships.push({
            sourceId: rel.sourceId,
            targetId: rel.targetId,
            relationshipType: rel.relationshipType,
            quantity: rel.quantity,
            referenceDesignator: rel.referenceDesignator,
            findNumber: rel.findNumber,
            isUsageRelationship: false,
          })

          const relatedItemId =
            rel.sourceId === itemId ? rel.targetId : rel.sourceId
          enqueue(relatedItemId)
        }

        // Incoming edges pinned to another row of this lineage, rendered
        // against this one. The physical bridge owns its own types.
        for (const rel of pinnedRelsByItem.get(itemId) ?? []) {
          if (PHYSICAL_STORED_TYPES.includes(rel.relationshipType)) continue
          if (!typeAllowed(rel.relationshipType)) continue

          collectedRelationships.push({
            sourceId: rel.sourceId,
            targetId: itemId,
            relationshipType: rel.relationshipType,
            quantity: rel.quantity,
            referenceDesignator: rel.referenceDesignator,
            findNumber: rel.findNumber,
            isUsageRelationship: false,
          })
          enqueue(rel.sourceId)
        }

        // Usage/definition edges. Included for ALL directions (the client
        // visually swaps UsageOf edges so definitions appear upstream).
        if (includeUsages) {
          if (item.usageOf) {
            collectedRelationships.push({
              sourceId: itemId,
              targetId: item.usageOf,
              relationshipType: 'UsageOf',
              quantity: null,
              referenceDesignator: null,
              findNumber: null,
              isUsageRelationship: true,
            })
            enqueue(item.usageOf)
          }

          if (UsageService.isDefinition(item) && direction !== 'outgoing') {
            for (const usageId of usagesByDefinition.get(itemId) ?? []) {
              collectedRelationships.push({
                sourceId: usageId,
                targetId: itemId,
                relationshipType: 'UsageOf',
                quantity: null,
                referenceDesignator: null,
                findNumber: null,
                isUsageRelationship: true,
              })
              enqueue(usageId)
            }
          }
        }

        // ---- Physical domain (work orders and physical parts) ----
        // Two gaps the stored-edge walk cannot cover: derived links
        // (physical_parts.partMasterId, work_orders.partId are columns, not
        // relationships), and stored Consumes/Produces/Evidences edges that
        // pin an exact part *version row* other than the one rendered here.
        const collectPhysical = (
          sourceId: string,
          targetId: string,
          relationshipType: string,
          quantity: string | null = null,
        ) => {
          collectedRelationships.push({
            sourceId,
            targetId,
            relationshipType,
            quantity,
            referenceDesignator: null,
            findNumber: null,
            isPhysicalRelationship:
              relationshipType === GRAPH_INSTANCE_OF ||
              relationshipType === GRAPH_BUILDS,
          })
          enqueue(sourceId === itemId ? targetId : sourceId)
        }

        if (item.itemType === 'WorkOrder') {
          // Bridge up to the exact part version this WO builds.
          if (walkPhysical && typeAllowed(GRAPH_BUILDS)) {
            const partId = woPartByItem.get(itemId)
            if (partId) {
              collectPhysical(partId, itemId, GRAPH_BUILDS)
            }
          }
        } else if (item.itemType === 'PhysicalPart') {
          // Bridge up to the part this instance instantiates.
          if (walkPhysical && typeAllowed(GRAPH_INSTANCE_OF)) {
            const pp = ppByItem.get(itemId)
            if (pp) {
              const partId = pp.asBuiltItemId
                ? liveAsBuilt.has(pp.asBuiltItemId)
                  ? pp.asBuiltItemId
                  : undefined
                : currentPartByMaster.get(pp.partMasterId)
              if (partId) {
                collectPhysical(partId, itemId, GRAPH_INSTANCE_OF)
              }
            }
          }
        } else if (item.masterId) {
          // Versioned design item: stored physical edges pinned to any OTHER
          // version row of its lineage, re-pointed onto this rendered row.
          if (walkPhysical) {
            for (const rel of pinnedRelsByItem.get(itemId) ?? []) {
              if (!PHYSICAL_STORED_TYPES.includes(rel.relationshipType)) {
                continue
              }
              if (!typeAllowed(rel.relationshipType)) continue
              collectPhysical(
                rel.sourceId,
                itemId,
                rel.relationshipType,
                rel.quantity,
              )
            }
          }

          if (item.itemType === 'Part' && direction !== 'incoming') {
            // Physical instances of this lineage (units and lots).
            if (typeAllowed(GRAPH_INSTANCE_OF)) {
              for (const instanceId of instancesByMaster.get(item.masterId) ??
                []) {
                collectPhysical(itemId, instanceId, GRAPH_INSTANCE_OF)
              }
            }
            // Work orders building any version of this lineage.
            if (typeAllowed(GRAPH_BUILDS)) {
              for (const versionId of lineageIdsOf(item)) {
                for (const woId of buildingWosByPartVersion.get(versionId) ??
                  []) {
                  collectPhysical(itemId, woId, GRAPH_BUILDS)
                }
              }
            }
          }
        }

        // ---- Attached vault files ----
        for (const file of filesByOwner.get(itemId) ?? []) {
          graphData.nodes.push({
            id: file.id,
            type: 'fileNode',
            data: {
              fileId: file.id,
              fileName: file.originalFileName,
              fileSize: file.fileSize,
              mimeType: file.mimeType,
              fileCategory: file.fileCategory,
              isPrimaryModel: file.isPrimaryModel ?? false,
              fileVersion: file.fileVersion,
              level: level + 1,
            },
            position: { x: 0, y: 0 },
          })
          // File edges skip the second-pass remap: each file belongs to
          // exactly one item row, canonical by construction here, and file
          // nodes need no key bookkeeping.
          graphData.edges.push({
            id: `${itemId}-${file.id}-${GRAPH_ATTACHED_FILE}`,
            source: itemId,
            target: file.id,
            label: SYNTHETIC_EDGE_LABELS[GRAPH_ATTACHED_FILE],
            data: {
              relationshipType: GRAPH_ATTACHED_FILE,
              isFileRelationship: true,
            },
          })
        }
      }

      frontier = nextFrontier
    }

    // Enrich cross-design nodes with design codes
    const crossDesignIds = new Set<string>()
    for (const node of graphData.nodes) {
      if (node.type === 'itemNode' && node.data.isCrossDesign) {
        const designId = itemIdToDesignId.get(node.id)
        if (designId) crossDesignIds.add(designId)
      }
    }

    if (crossDesignIds.size > 0) {
      const designRows = await db
        .select({ id: designs.id, code: designs.code })
        .from(designs)
        .where(inArray(designs.id, [...crossDesignIds]))

      const designCodeMap = new Map(designRows.map((d) => [d.id, d.code]))

      for (const node of graphData.nodes) {
        if (node.type === 'itemNode' && node.data.isCrossDesign) {
          const designId = itemIdToDesignId.get(node.id)
          if (designId) {
            const code = designCodeMap.get(designId)
            if (code) node.data.designCodes = [code]
          }
        }
      }
    }

    // Second pass: add edges with remapped IDs using cached data
    const addedEdges = new Set<string>()
    for (const rel of collectedRelationships) {
      const sourceKey = itemIdToKey.get(rel.sourceId)
      const targetKey = itemIdToKey.get(rel.targetId)

      // Endpoints the walk never admitted (out of scope, past the depth cap,
      // or deleted) contribute no edge.
      if (!sourceKey || !targetKey) continue

      const canonicalSourceId = visitedItemKeys.get(sourceKey)
      const canonicalTargetId = visitedItemKeys.get(targetKey)
      if (!canonicalSourceId || !canonicalTargetId) continue

      // Skip self-loops (can happen when remapping different revisions)
      if (canonicalSourceId === canonicalTargetId) continue

      const edgeId = `${canonicalSourceId}-${canonicalTargetId}-${rel.relationshipType}`
      if (!addedEdges.has(edgeId)) {
        addedEdges.add(edgeId)
        graphData.edges.push({
          id: edgeId,
          source: canonicalSourceId,
          target: canonicalTargetId,
          label: rel.isUsageRelationship
            ? 'usage of'
            : (SYNTHETIC_EDGE_LABELS[rel.relationshipType] ??
              rel.relationshipType),
          data: {
            relationshipType: rel.relationshipType,
            quantity: rel.quantity,
            referenceDesignator: rel.referenceDesignator,
            findNumber: rel.findNumber,
            isUsageRelationship: rel.isUsageRelationship ?? false,
            isPhysicalRelationship: rel.isPhysicalRelationship ?? false,
          },
        })
      }
    }

    return graphData
  }
}
