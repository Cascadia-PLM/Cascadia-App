// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Materialization Service
 *
 * Converts the session's reviewed artifacts (requirements + BOM draft) into
 * real PLM data. The contract is computed by plan() and shared between
 * preview() and execute(), so what the user is told will happen is exactly
 * what happens:
 *
 * - No target design: a new design is created in the session's program, then
 *   requirements, parts, and BOM relationships are created on its main branch
 *   in the 'Draft' lifecycle state. No ECO is involved — pre-release designs
 *   are directly editable, and revision letters are assigned later when the
 *   design is first released through an ECO.
 * - Existing pre-release design: same as above, minus the design creation.
 * - Existing design with released items: an ECO is created and the new items
 *   are added to its branch (as 'added' working copies, and registered on the
 *   ECO with the 'release' change action). They are released with revision
 *   letters when the ECO is reviewed, approved, and merged to main.
 */

import { and, asc, sql } from 'drizzle-orm'
import { DesignSessionService } from './session-service'
import { activeRequirements } from './types'
import type { BaseItem } from '@/items/types/base'
import type { DesignSession } from './session-service'
import type {
  BomNodeDraft,
  MaterializationJournal,
  MaterializationPlan,
  MaterializationPreview,
  MaterializationResult,
} from './types'
import { ItemService } from '@/items/services/ItemService'
import { DesignService } from '@/services/DesignService'
import { ProgramService } from '@/services/ProgramService'
import { BranchService } from '@/services/BranchService'
import { CatalogService } from '@/services/CatalogService'
import { ChangeOrderService } from '@/items/services/ChangeOrderService'
import { AlreadyExistsError, ConflictError, ValidationError } from '@/errors'
import { serviceLogger } from '@/logging/logger'
import { db } from '@/db'
// Aliased: `preview()` builds a local `items` array of its own.
import { items as itemsTable } from '@/db/schema'
import { notDeleted } from '@/db/filters'

/**
 * Attribute key stamped onto everything materialization creates, so a run
 * that crashed between a create and its journal write can find the orphan on
 * resume instead of minting a second item for the same tempId.
 */
const MATERIALIZATION_KEY = 'materializationKey'

/**
 * The ECO's stand-in tempId. Requirements and BOM nodes carry LLM-generated
 * tempIds; the underscores keep this one out of that namespace.
 */
const CHANGE_ORDER_TEMP_ID = '__eco__'

/**
 * The change type a materialization's change order runs as. A design
 * session's output is an engineering change, so it is the standard ECO;
 * named once here rather than inlined where the change order is created.
 */
const MATERIALIZATION_CHANGE_TYPE = 'ECO'

/** The marker value: unique per (session, tempId) pair. */
function materializationKey(sessionId: string, tempId: string): string {
  return `${sessionId}:${tempId}`
}

/**
 * The design code a session's materialization uses, derived from the session
 * rather than from the clock.
 *
 * A run that crashed after `DesignService.create` committed but before its
 * journal write has to recognise that design when it resumes, and a timestamp
 * code never matches one — so the previous shape created a second design, a
 * second main branch, and a second set of item numbers for the same session.
 * `designs.code` is UNIQUE, which makes the derived code both the
 * reconciliation key and the backstop against two runs racing into two
 * designs. Twelve hex digits keep the code short enough to sit inside an item
 * number (numbering schemes may embed the design code) while leaving
 * collisions at 2^-48 per pair.
 */
function sessionDesignCode(sessionId: string): string {
  return `CD-${sessionId.replace(/-/g, '').slice(0, 12).toUpperCase()}`
}

/**
 * The item a previous run created under this marker, if there is one.
 *
 * Containment rather than `attributes->>'materializationKey' = …`: the GIN
 * index on `items.attributes` answers `@>` and cannot answer a key
 * extraction, so the extraction form would sequential-scan every item in the
 * instance. Ordered by creation so a marker that ever matches more than one
 * row — a later revision copies attributes forward — still resolves to the
 * row materialization itself created.
 */
async function findByMaterializationKey(
  key: string,
): Promise<{ itemId: string; itemNumber: string } | null> {
  const rows = await db
    .select({ id: itemsTable.id, itemNumber: itemsTable.itemNumber })
    .from(itemsTable)
    .where(
      and(
        sql`${itemsTable.attributes} @> ${JSON.stringify({ [MATERIALIZATION_KEY]: key })}::jsonb`,
        notDeleted(),
      ),
    )
    .orderBy(asc(itemsTable.createdAt))
    .limit(1)

  const row = rows.at(0)
  return row ? { itemId: row.id, itemNumber: row.itemNumber } : null
}

export class MaterializationService {
  /**
   * Determine what materialization will do for this session.
   *
   * preview() displays this plan and execute() follows it — keep all
   * mode/target decisions here so the two cannot drift apart.
   */
  static async plan(session: DesignSession): Promise<MaterializationPlan> {
    const program = await ProgramService.getById(session.programId)
    const programName = program?.name ?? null

    if (!session.designId) {
      return {
        mode: 'create_design',
        supported: true,
        programId: session.programId,
        programName,
        targetDesignId: null,
        targetDesignName: null,
        newDesignName: session.title ?? 'Collaborative Design',
        initialState: 'Draft',
        targetBranch: 'main',
      }
    }

    const design = await DesignService.getById(session.designId)
    const targetDesignName = design?.name ?? design?.code ?? null
    const isProtected = await BranchService.isMainBranchProtected(
      session.designId,
    )

    if (isProtected) {
      return {
        mode: 'eco_required',
        supported: true,
        programId: session.programId,
        programName,
        targetDesignId: session.designId,
        targetDesignName,
        ecoName: `ECO for ${session.title ?? 'Collaborative Design'}`,
        initialState: 'Draft',
        targetBranch: 'main',
      }
    }

    return {
      mode: 'add_to_design',
      supported: true,
      programId: session.programId,
      programName,
      targetDesignId: session.designId,
      targetDesignName,
      initialState: 'Draft',
      targetBranch: 'main',
    }
  }

  /**
   * Generate a preview of what materialization will create.
   */
  static async preview(
    session: DesignSession,
  ): Promise<MaterializationPreview> {
    const plan = await this.plan(session)

    const artifacts = session.artifacts
    if (!artifacts?.bom) {
      return {
        plan,
        newPartsCount: 0,
        reusedPartsCount: 0,
        newRequirementsCount: 0,
        bomRelationshipsCount: 0,
        items: [],
      }
    }

    const bom = artifacts.bom

    // Count parts
    let newParts = 0
    let reusedParts = 0
    let bomRelationships = 0
    const items: MaterializationPreview['items'] = []

    function walkNode(node: BomNodeDraft) {
      if (node.isNew) {
        newParts++
      } else {
        reusedParts++
      }

      items.push({
        tempId: node.tempId,
        name: node.name,
        itemType: 'Part',
        isNew: node.isNew,
        existingItemNumber: node.existingItemNumber,
      })

      bomRelationships += node.children.length

      for (const child of node.children) {
        walkNode(child)
      }
    }

    walkNode(bom.rootAssembly)

    // Count requirements to create (rejected requirements never materialize)
    const requirementsToCreate = activeRequirements(artifacts.requirements)
    const newRequirementsCount = requirementsToCreate.length

    // Add requirements to items list
    for (const req of requirementsToCreate) {
      items.push({
        tempId: req.tempId,
        name: req.name,
        itemType: 'Requirement',
        isNew: true,
      })
    }

    return {
      plan,
      newPartsCount: newParts,
      reusedPartsCount: reusedParts,
      newRequirementsCount,
      bomRelationshipsCount: bomRelationships,
      items,
    }
  }

  /**
   * Execute materialization following the plan: create the design if needed,
   * then create all requirements, parts, and BOM relationships in 'Draft'
   * state on the target design's main branch.
   */
  static async execute(
    session: DesignSession,
    userId: string,
  ): Promise<MaterializationResult> {
    const artifacts = session.artifacts
    if (!artifacts?.bom) {
      throw new ValidationError('No BOM to materialize')
    }

    const plan = await this.plan(session)
    if (!plan.supported) {
      throw new ValidationError(
        plan.blockedReason ??
          'Materialization is not supported for this target design',
      )
    }

    // Claim the journal: 409 if another run is mid-flight; otherwise this
    // run owns it, carrying any previous failed run's completed steps so we
    // resume rather than duplicate. Each step below persists its outcome
    // into the journal the moment it succeeds — the journal write is the
    // commit point, so a crash leaves at most one step unaccounted for: the
    // one that landed in the database but never reached the journal.
    //
    // A resumed run reconciles that step instead of repeating it. Every
    // create looks for its own previous output first — items and the ECO by
    // the `materializationKey` marker stamped into their attributes, the
    // design by its session-derived code, the ECO's workflow by its
    // instance — and BOM edges absorb AlreadyExistsError. `resumed` gates
    // all of it, so a first run pays for none of those lookups.
    const { journal, resumed } =
      await DesignSessionService.claimMaterialization(session.id)
    const saveJournal = () =>
      DesignSessionService.saveMaterializationJournal(session.id, journal)

    try {
      return await this.executeWithJournal(
        session,
        userId,
        plan,
        journal,
        resumed,
        saveJournal,
      )
    } catch (error) {
      journal.status = 'failed'
      await saveJournal()
      throw error
    }
  }

  /**
   * Merge the materialization result into the session's *current* artifacts.
   *
   * Not `session.artifacts`: that is the snapshot execute() was handed, and
   * materialization runs for minutes. Writing it back wholesale discarded
   * every review edit — an item comment, a BOM tweak — that landed through
   * the PATCH route while items were being created. Re-reading and writing
   * under the version the re-read saw keeps both, and turns a lost race into
   * a retry rather than a silent overwrite.
   *
   * One retry: the only writers that can race this are the review PATCH
   * route and the stage generators, and losing the compare-and-set twice in
   * the milliseconds between read and write means a client is hammering the
   * session. A second loss surfaces as the ConflictError it is.
   */
  private static async saveMaterializationResult(
    sessionId: string,
    result: MaterializationResult,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = await DesignSessionService.getById(sessionId)
      if (!fresh?.artifacts) return

      try {
        await DesignSessionService.updateArtifacts(
          sessionId,
          { ...fresh.artifacts, materializationResult: result },
          fresh.artifactsVersion,
        )
        return
      } catch (error) {
        if (!(error instanceof ConflictError) || attempt > 0) throw error
      }
    }
  }

  private static async executeWithJournal(
    session: DesignSession,
    userId: string,
    plan: MaterializationPlan,
    journal: MaterializationJournal,
    resumed: boolean,
    saveJournal: () => Promise<void>,
  ): Promise<MaterializationResult> {
    const artifacts = session.artifacts
    if (!artifacts?.bom) {
      throw new ValidationError('No BOM to materialize')
    }
    const bom = artifacts.bom
    const tempIdToItemId = new Map<string, string>()
    const tempIdToItemNumber = new Map<string, string>()
    const createdItems: MaterializationResult['createdItems'] = []
    let bomRelationshipsCreated = 0

    // Step 1: Resolve or create the target design (journaled: a resumed run
    // reuses the design the failed run already created — and, when the crash
    // fell between the create and that journal write, finds it by the
    // session-derived code rather than making a second one)
    let resolvedDesignId = plan.targetDesignId ?? journal.designId ?? null
    let designName = plan.targetDesignId
      ? plan.targetDesignName
      : (journal.designName ?? null)
    if (!resolvedDesignId) {
      const code = sessionDesignCode(session.id)
      const orphan = resumed ? await DesignService.getByCode(code) : null
      const design =
        orphan ??
        (await DesignService.create(
          {
            name: plan.newDesignName ?? 'Collaborative Design',
            code,
            programId: session.programId,
            designType: 'Engineering',
          },
          userId,
        ))
      resolvedDesignId = design.id
      designName = design.name
      journal.designId = design.id
      journal.designName = design.name
      await saveJournal()
    }
    if (!resolvedDesignId) {
      throw new ValidationError('Failed to create design for materialization')
    }
    const designId = resolvedDesignId

    // Step 1b: For a released (branch-protected) design, create an ECO and a
    // branch to hold the new items. They are created on that branch as 'added'
    // working copies and released with revision letters when the ECO merges.
    let changeOrderId: string | undefined = journal.ecoId
    let changeOrderNumber: string | undefined = journal.ecoNumber
    let changeOrderBranchId: string | null = journal.ecoBranchId ?? null
    if (plan.mode === 'eco_required' && !changeOrderBranchId) {
      // Through `ChangeOrderService.create`, the one door for change orders:
      // it links the design, creates the branch and starts the workflow as
      // one creation, and rolls the change order back if any of them fails.
      // A resumed run finds the change order by its materialization key
      // rather than making a second one; because creation and workflow start
      // are one step now, a journaled `ecoId` implies a running instance and
      // there is no separate start to journal or to guard against repeating.
      if (!changeOrderId) {
        const changeOrderKey = materializationKey(
          session.id,
          CHANGE_ORDER_TEMP_ID,
        )
        const orphan = resumed
          ? await findByMaterializationKey(changeOrderKey)
          : null
        if (orphan) {
          changeOrderId = orphan.itemId
          changeOrderNumber = orphan.itemNumber
        } else {
          const changeOrder = await ChangeOrderService.create(
            {
              name:
                plan.ecoName ?? `ECO for ${session.title ?? 'Design Session'}`,
              revision: '-',
              itemType: 'ChangeOrder',
              changeType: MATERIALIZATION_CHANGE_TYPE,
              priority: 'medium',
              reasonForChange: `Materialized from collaborative design session ${session.id}`,
              attributes: { [MATERIALIZATION_KEY]: changeOrderKey },
            },
            [designId],
            userId,
            { bypassBranchProtection: true },
          )
          changeOrderId = changeOrder.id ?? undefined
          changeOrderNumber = changeOrder.itemNumber ?? undefined
        }
        if (!changeOrderId) {
          throw new ValidationError('Failed to create ECO for materialization')
        }
        journal.ecoId = changeOrderId
        journal.ecoNumber = changeOrderNumber
        journal.ecoWorkflowStarted = true
        await saveJournal()
      }

      // The branch for this design was made by `create`; addDesign is
      // idempotent (an existing association returns early), so re-running a
      // resumed materialization is safe.
      await ChangeOrderService.addDesign(changeOrderId, designId, userId)

      const ecoDesigns =
        await ChangeOrderService.getChangeOrderDesigns(changeOrderId)
      changeOrderBranchId =
        ecoDesigns.find((d) => d.designId === designId)?.branchId ?? null
      if (!changeOrderBranchId) {
        throw new ValidationError(
          'Failed to create ECO branch for materialization',
        )
      }
      journal.ecoBranchId = changeOrderBranchId
      await saveJournal()
    }

    // Create a requirement or part, either directly on main (create/add modes)
    // or on the ECO branch (eco_required). On the ECO branch the item is an
    // 'added' working copy; it is also registered on the ECO with the 'release'
    // change action so it appears in the Affected Items tab for review.
    const createItem = async (
      tempId: string,
      type: 'Requirement' | 'Part',
      data: BaseItem,
    ): Promise<{ itemId: string; itemNumber: string }> => {
      // Already journaled: the previous run created (and, on the ECO path,
      // registered) this item — reuse it rather than minting a duplicate.
      const done = journal.items[tempId]
      if (done) {
        return { itemId: done.itemId, itemNumber: done.itemNumber }
      }

      // Not journaled is ambiguous on a resumed run: either this item was
      // never created, or the previous run crashed in the window between its
      // create and its journal write. The marker settles it, and adopting is
      // not tidiness — a second create mints a second item number, so the
      // user ends up with two parts where the BOM edges hang off the one
      // they were never shown.
      //
      // An adopted item is not re-registered on the ECO's affected items:
      // that registration is best-effort display metadata (see below), and
      // the item is an 'added' working copy that releases at merge either way.
      const orphan = resumed
        ? await findByMaterializationKey(materializationKey(session.id, tempId))
        : null

      let itemId: string
      let itemNumber: string
      if (orphan) {
        itemId = orphan.itemId
        itemNumber = orphan.itemNumber
      } else {
        const item = await createItemUnjournaled(type, data)
        itemId = item.id ?? ''
        itemNumber = item.itemNumber ?? ''
      }

      journal.items[tempId] = {
        itemId,
        itemNumber,
        itemType: type,
        name: data.name ?? '',
      }
      await saveJournal()
      return { itemId, itemNumber }
    }

    const createItemUnjournaled = async (
      type: 'Requirement' | 'Part',
      data: BaseItem,
    ): Promise<BaseItem> => {
      if (changeOrderBranchId) {
        const { item } = await ItemService.createOnBranch(
          type,
          data,
          changeOrderBranchId,
          `Materialized ${type} ${data.name ?? ''}`.trim(),
          userId,
        )
        // Register on the ECO so the item shows in its Affected Items tab.
        // Best-effort: this is display metadata only — the item is already an
        // 'added' working copy on the branch and is released at merge whether or
        // not it is registered. Skip (with a warning) for item types whose
        // lifecycle doesn't define a 'release' action, rather than aborting.
        if (changeOrderId && item.id) {
          try {
            await ChangeOrderService.addAffectedItem(
              changeOrderId,
              {
                affectedItemId: item.id,
                changeAction: 'release',
                currentState: item.state ?? 'Draft',
                currentRevision: item.revision,
              },
              userId,
            )
          } catch (err) {
            serviceLogger.warn(
              { ecoId: changeOrderId, itemId: item.id, itemType: type, err },
              'Could not register materialized item on ECO affected items; item remains on the ECO branch and will release at merge',
            )
          }
        }
        return item
      }
      return ItemService.create(type, data, userId)
    }

    // Step 2: Create requirements in Draft state (on main, or on the ECO branch)
    // Map design engine enums → PLM Requirement schema enums
    const priorityMap: Record<string, string> = {
      critical: 'MustHave',
      high: 'ShouldHave',
      medium: 'CouldHave',
      low: 'WontHave',
    }
    const typeMap: Record<string, string> = {
      Functional: 'Functional',
      Performance: 'Performance',
      Interface: 'Non-Functional',
      Constraint: 'Non-Functional',
      Other: 'Business',
    }

    for (const req of activeRequirements(artifacts.requirements)) {
      const { itemId, itemNumber } = await createItem(
        req.tempId,
        'Requirement',
        {
          name: req.name,
          revision: '-',
          itemType: 'Requirement',
          state: plan.initialState,
          description: req.description,
          type: typeMap[req.requirementType] ?? 'Functional',
          priority: priorityMap[req.priority] ?? 'CouldHave',
          verificationMethod: req.verificationMethod,
          designId,
          attributes: {
            [MATERIALIZATION_KEY]: materializationKey(session.id, req.tempId),
          },
        } as BaseItem,
      )

      tempIdToItemId.set(req.tempId, itemId)
      tempIdToItemNumber.set(req.tempId, itemNumber)

      createdItems.push({
        tempId: req.tempId,
        itemId,
        itemNumber,
        itemType: 'Requirement',
        name: req.name,
      })
    }

    // Step 3: Create parts depth-first (leaves before parents for BOM relationships)
    async function createPartNode(
      node: BomNodeDraft,
      parentNode?: BomNodeDraft,
    ): Promise<string> {
      // Create children first
      const childItemIds: Array<{
        tempId: string
        itemId: string
        quantity: number
        findNumber?: number
      }> = []

      for (const child of node.children) {
        const childId = await createPartNode(child, node)
        childItemIds.push({
          tempId: child.tempId,
          itemId: childId,
          quantity: child.quantity,
          findNumber: child.findNumber,
        })
      }

      // Create or use existing item
      let itemId: string

      if (node.isNew) {
        // Snapshot catalog specs into item attributes if catalogComponentId is
        // present. `items.attributes` is a JSON document, so these go in as
        // nested objects. They were briefly written as JSON *text* instead,
        // because `baseItemSchema` then narrowed the map to
        // `Record<string, string>` and rejected the objects outright — a
        // catalog-backed or mechanism node failed materialization rather than
        // merely losing its metadata. The schema was widened to match the
        // column; nothing needs encoding here any more.
        //
        // Rows written during that window still hold the string form. Nothing
        // reads either key back, so there is no decoder to keep honest and no
        // backfill was run - the first reader has to accept both shapes, or
        // convert them first.
        const attributes: Record<string, unknown> = {}
        let cost: string | undefined

        if (node.catalogComponentId) {
          try {
            const catalogEntry = await CatalogService.getById(
              node.catalogComponentId,
            )
            attributes.catalogSnapshot = {
              catalogComponentId: catalogEntry.id,
              name: catalogEntry.name,
              dimensions: catalogEntry.dimensions,
              mountingFeatures: catalogEntry.mountingFeatures,
              electrical: catalogEntry.electrical,
              specs: catalogEntry.specs,
              suppliers: catalogEntry.suppliers,
              designNotes: catalogEntry.designNotes,
              selectedStockSize: node.selectedStockSize,
              snapshotDate: new Date().toISOString(),
            }
            // Extract cost from first supplier. `parts.cost` is a decimal
            // column, which Drizzle and `partSchema` both take as a string.
            const primarySupplier = catalogEntry.suppliers[0]
            if (primarySupplier?.approximatePrice) {
              cost = String(primarySupplier.approximatePrice)
            }
          } catch {
            // Catalog entry may have been deleted — proceed without snapshot
          }
        }

        // Store mechanism metadata if this node is part of a mechanism template
        if (parentNode?.mechanismTemplate) {
          const roleMapping = parentNode.mechanismTemplate.partMapping.find(
            (m) => m.tempId === node.tempId,
          )
          if (roleMapping) {
            attributes.mechanismMetadata = {
              mechanismType: parentNode.mechanismTemplate.mechanismType,
              role: roleMapping.role,
              parameters: parentNode.mechanismTemplate.parameters,
              parentAssemblyTempId: parentNode.tempId,
            }
          }
        }

        const created = await createItem(node.tempId, 'Part', {
          name: node.name,
          revision: '-',
          itemType: 'Part',
          state: plan.initialState,
          partType: node.partType,
          material: node.material,
          designId,
          attributes: {
            ...attributes,
            [MATERIALIZATION_KEY]: materializationKey(session.id, node.tempId),
          },
          ...(cost !== undefined ? { cost } : {}),
        } as BaseItem)

        itemId = created.itemId
        const itemNumber = created.itemNumber
        tempIdToItemId.set(node.tempId, itemId)
        tempIdToItemNumber.set(node.tempId, itemNumber)

        createdItems.push({
          tempId: node.tempId,
          itemId,
          itemNumber,
          itemType: 'Part',
          name: node.name,
        })
      } else {
        // Use existing item
        itemId = node.existingItemId ?? node.tempId
        tempIdToItemId.set(node.tempId, itemId)
      }

      // Create BOM relationships. Materialization is a system flow assembling
      // freshly created branch items, so it bypasses the per-user edit lock.
      // Each landed edge is journaled by its tempId pair; on resume a
      // journaled pair is skipped, and an edge that landed in the crash
      // window before its journal write surfaces as AlreadyExists — equally
      // done, so both count toward the total.
      for (const child of childItemIds) {
        const pairKey = `${node.tempId}->${child.tempId}`
        if (!journal.relationships.includes(pairKey)) {
          try {
            await ItemService.addRelationship(
              itemId,
              child.itemId,
              'BOM',
              userId,
              {
                quantity: String(child.quantity),
                findNumber: child.findNumber,
              },
              { bypassEditGuard: true },
            )
          } catch (error) {
            if (!(error instanceof AlreadyExistsError)) throw error
          }
          journal.relationships.push(pairKey)
          await saveJournal()
        }
        bomRelationshipsCreated++
      }

      return itemId
    }

    await createPartNode(bom.rootAssembly)

    // Step 4: Update session and save materialization result to artifacts
    await DesignSessionService.setMaterializedDesign(session.id, designId)

    const result: MaterializationResult = {
      mode: plan.mode,
      designId,
      designName,
      initialState: plan.initialState,
      ...(changeOrderId ? { ecoId: changeOrderId } : {}),
      ...(changeOrderNumber ? { ecoNumber: changeOrderNumber } : {}),
      createdItems,
      bomRelationshipsCreated,
    }

    // Save result into artifacts for downstream CAD generation stage
    await this.saveMaterializationResult(session.id, result)

    return result
  }
}
