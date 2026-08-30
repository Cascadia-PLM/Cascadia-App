// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { ZodError } from 'zod'
import { db, withTx } from '../../db'
import { designs, items } from '../../db/schema'
import { NumberingService } from '../numbering'
import { ItemTypeRegistry } from '../registry'
import { getTypeHandler } from '../type-handlers'
import { isBranchProtectionExempt } from '../branch-protection'
import '../type-handlers/init'
import {
  AlreadyExistsError,
  BranchProtectionError,
  InternalError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../../errors'
import { isUniqueViolation } from '../../errors/pg'
import { CommitService } from '../../services/CommitService'
import { expandSourceFieldChanges } from '../../services/software-source-changes'
import {
  CheckoutService,
  computeFieldChanges,
  computeInitialFieldValues,
} from '../../services/CheckoutService'
import { BranchService } from '../../services/BranchService'
// Imported directly rather than through lib/auth/access.ts, whose static
// FileService import would recreate the ItemService <-> FileService cycle that
// the dynamic import further down this file exists to break.
import { AccessControlService } from '../../auth/AccessControlService'
import { RevisionService } from '../../services/RevisionService'
import { UsageService } from '../../services/UsageService'
import { accessScopeCondition, notDeleted } from '../../db/filters'
import { ItemVersioningFacade } from './ItemVersioningFacade'
import { ItemEditPolicy } from './ItemEditPolicy'
import { ItemSearchService } from './ItemSearchService'
import { ItemRelationshipService } from './ItemRelationshipService'
import type { AccessScope } from '../../db/filters'
import type { TypeHandlerContext } from '../type-handlers'
import type { SQL } from 'drizzle-orm'
import type { TransactionClient } from '../../db'
import type { commits, itemRelationships } from '../../db/schema'
import type {
  ItemFilters,
  VersionContext,
} from '../../services/VersionResolver'
import type { ItemHistoryEntry } from '../../services/CommitService'
import type { BaseItem, PersistedItem } from '../types/base'
import type {
  GlobalSearchCriteria,
  GlobalSearchRow,
  SearchCriteria,
  SearchResult,
} from './ItemSearchService'
import { itemLogger } from '@/lib/logging/logger'
import { takeFirst } from '@/lib/db/take-first'

export type {
  GlobalSearchCriteria,
  GlobalSearchRow,
  SearchCriteria,
  SearchResult,
} from './ItemSearchService'

/**
 * How a lookup by item number is scoped.
 *
 * Item numbers repeat across designs by design — see `findMatchesByNumber` —
 * so a caller that knows which design it means says so here.
 */
export interface FindByNumberOptions {
  /** Only consider items in this design. */
  designId?: string
  /**
   * Only consider items the caller may read. `null`/omitted is unrestricted;
   * an empty scope reaches only the types that scope on nothing. Same
   * contract as `AccessControlService.getAccessScope`, whose result this
   * takes.
   *
   * This is the caller's own reach, not a narrowing the caller asked for —
   * `designId` above is that.
   */
  accessScope?: AccessScope | null
}

/** One row a by-number lookup matched, named by the design it lives in. */
export interface ItemNumberMatch {
  id: string
  masterId: string
  itemNumber: string
  name: string | null
  revision: string
  state: string
  itemType: string
  designId: string | null
  designCode: string | null
  designName: string | null
  designType: string | null
}

/**
 * Which design a colliding item number more likely means, lowest first.
 *
 * An MBOM is a copy of an EBOM that keeps the item numbers, so a bare number
 * matches both the engineering original and its manufacturing shadow. The
 * original is what a caller naming only a number means; the shadow is derived
 * from it and links back through `EBOM_SOURCE`. Library sits behind
 * Engineering because a standard part is the fallback meaning of a number a
 * program design also uses. Family designs are containers that seldom own
 * items at all, so they sort behind designs that do.
 */
const DESIGN_TYPE_PREFERENCE: Record<string, number> = {
  Engineering: 0,
  Library: 1,
  Family: 3,
  Manufacturing: 4,
}

/**
 * Where rows outside any design sort. Change orders, tasks and issues live
 * here; so does any design type not named above.
 */
const NO_DESIGN_PREFERENCE = 2

/**
 * Service layer for item operations
 * Provides CRUD operations and business logic for all item types
 */
export class ItemService {
  /**
   * The state ID a brand-new item (or revision) starts in: the assigned
   * lifecycle's initial state ID when one exists, else the caller's
   * fallback. State identity is IDs everywhere (WI-5.1) — display names
   * are resolved at the display layer only.
   */
  private static async resolveInitialStateId(
    itemType: string,
  ): Promise<string> {
    const { LifecycleService } = await import('../../services/LifecycleService')
    return LifecycleService.getInitialStateId(itemType)
  }

  /**
   * The revision a brand-new item starts at when the caller names none.
   *
   * An ECO-controlled (Driven) type is given its revision by the change order
   * that releases it, so it starts at the unreleased marker and is released as
   * A. Anything else - a Free or Driving lifecycle - has no release that would
   * ever assign one, so the marker would be permanent; those start at the
   * scheme's initial revision, which is what every such create site already
   * wrote by hand.
   *
   * The distinction is the lifecycle's, not a type list's, so a custom type
   * follows its assigned lifecycle with no change here - the same reasoning as
   * `isBranchProtectionExempt`, which asks the same question of the same
   * configuration.
   */
  private static async resolveInitialRevision(
    itemType: string,
  ): Promise<string> {
    const { LifecycleService } = await import('../../services/LifecycleService')
    if ((await LifecycleService.getLifecycleType(itemType)) === 'Driven') {
      return RevisionService.getUnreleasedRevision()
    }
    return RevisionService.getInitialRevision(
      await LifecycleService.getRevisionScheme(itemType),
    )
  }

  /**
   * Create a new item
   *
   * In pre-release phase: Items can be created directly on main branch
   * In post-release phase: Items must be created on a workspace or ECO branch using createOnBranch()
   *
   * @param options.bypassBranchProtection - Skip branch protection check (for ECO operations or tests)
   */
  static async create<T extends BaseItem>(
    type: string,
    data: T,
    userId: string,
    options?: { bypassBranchProtection?: boolean },
  ): Promise<T> {
    const typeConfig = ItemTypeRegistry.getType(type)
    if (!typeConfig) {
      throw new NotFoundError('Item type', type, { operation: 'create' })
    }

    // Merge itemType into data before validation
    const dataWithType = { ...data, itemType: type }

    // Validate data against schema
    let validatedData: T
    try {
      validatedData = typeConfig.schema.parse(dataWithType) as T
    } catch (error) {
      if (error instanceof ZodError) {
        throw ValidationError.fromZodError(error, {
          operation: 'create',
          resource: type,
        })
      }
      throw error
    }

    // Handle item number generation
    if (!validatedData.itemNumber) {
      // Auto-generate item number
      let designCode: string | null = null
      if (validatedData.designId) {
        const design = await db.query.designs.findFirst({
          where: eq(designs.id, validatedData.designId),
          columns: { code: true },
        })
        designCode = design?.code ?? null
      }

      validatedData.itemNumber = await NumberingService.generate(type, {
        designId: validatedData.designId,
        designCode,
        fields: validatedData as unknown as Record<string, unknown>,
      })
    } else {
      // Manual entry - validate if allowed
      if (!NumberingService.allowsManualEntry(type)) {
        throw new ValidationError(
          `Manual item numbers are not allowed for ${type}`,
          undefined,
          { operation: 'create', resource: type },
        )
      }
      if (
        !NumberingService.validateManualNumber(type, validatedData.itemNumber)
      ) {
        throw new ValidationError(
          `Item number '${validatedData.itemNumber}' does not match the required format`,
          undefined,
          { operation: 'create', resource: type },
        )
      }
    }

    // The revision is the lifecycle's to assign, not the caller's. A client
    // that names one is honoured (imports carry the revision the source system
    // recorded); one that omits it gets the value its lifecycle implies. Bound
    // as a const as well as written back, because the insert below runs inside
    // a closure where the narrowing on a mutable field does not survive.
    const revision =
      validatedData.revision ?? (await this.resolveInitialRevision(type))
    validatedData.revision = revision

    // Check branch protection if item is associated with a design
    // Skip this check if:
    // - bypassBranchProtection is true (for ECO operations or tests)
    // - The type is exempt, which its lifecycle decides: only Driven
    //   lifecycles are ECO-controlled (see lib/items/branch-protection.ts)
    const isChangeOrder = type === 'ChangeOrder'
    if (
      validatedData.designId &&
      !options?.bypassBranchProtection &&
      !(await isBranchProtectionExempt(type))
    ) {
      const canEdit = await this.canEditDirectly(validatedData.designId)
      if (!canEdit.allowed) {
        throw new BranchProtectionError(
          `Cannot create ${type} directly on main branch: ${canEdit.reason}`,
          { operation: 'create', designId: validatedData.designId },
        )
      }
    }

    // Generate master ID for first revision
    const masterId = randomUUID()

    // Initial state comes from the assigned lifecycle (its initial state
    // ID — state identity is IDs everywhere, WI-5.1). A caller-supplied
    // state must be one the lifecycle defines: the schema types `state` as a
    // plain string because the state universe is runtime configuration, so
    // this is where the boundary holds.
    if (validatedData.state) {
      const { LifecycleService } =
        await import('../../services/LifecycleService')
      await LifecycleService.validateStateForType(type, validatedData.state)
    }
    const initialState = await this.resolveInitialStateId(type)

    // Auto-assign sysmlType based on whether this is a usage or definition
    // If usageOf is set, this is a usage; otherwise it's a definition
    const isUsage = !!(validatedData as unknown as { usageOf?: string }).usageOf
    const sysmlType = UsageService.getSysmlType(type, isUsage)

    // Wrap all database operations in a transaction for atomicity
    try {
      return await db.transaction(async (tx) => {
        // Insert base item
        const item = takeFirst(
          await tx
            .insert(items)
            .values({
              masterId,
              designId: validatedData.designId,
              itemNumber: validatedData.itemNumber!,
              revision,
              itemType: type,
              name: validatedData.name,
              state: validatedData.state || initialState,
              attributes: (
                validatedData as unknown as {
                  attributes?: Record<string, unknown>
                }
              ).attributes,
              isCurrent: true,
              sysmlType: sysmlType,
              usageOf: (validatedData as unknown as { usageOf?: string })
                .usageOf,
              createdBy: userId,
              modifiedBy: userId,
            })
            .returning(),
        )

        // Insert type-specific data
        await this.insertTypeSpecificData(type, item.id, validatedData, tx, {
          userId,
        })

        // Create commit for history tracking if item has a designId
        // (items without designId are not tracked in version history)
        // Note: ChangeOrders are created WITHOUT designId - they're design-agnostic.
        if (item.designId && !isChangeOrder) {
          try {
            const fieldChanges = computeInitialFieldValues(
              { ...validatedData, state: item.state } as unknown as Record<
                string,
                unknown
              >,
              type,
            )

            const mainBranch = await BranchService.getMainBranch(item.designId)
            const targetBranchId = mainBranch?.id ?? null

            if (targetBranchId) {
              const commit = await CommitService.create(
                {
                  branchId: targetBranchId,
                  message: `${type} ${validatedData.itemNumber || 'item'} created`,
                  itemChanges: [
                    {
                      itemId: item.id,
                      changeType: 'added',
                      fieldChanges,
                    },
                  ],
                },
                userId,
                tx,
              )

              await tx
                .update(items)
                .set({ commitId: commit.id })
                .where(eq(items.id, item.id))
            }
          } catch (error) {
            // Log but don't fail - commit tracking is optional during pre-release
            itemLogger.warn(
              { err: error, itemId: item.id },
              'Failed to create commit for item',
            )
          }
        }

        return {
          ...validatedData,
          id: item.id,
          masterId: item.masterId,
          designId: item.designId,
          state: item.state,
          createdAt: item.createdAt,
          createdBy: item.createdBy,
          modifiedAt: item.modifiedAt,
          modifiedBy: item.modifiedBy,
        }
      })
    } catch (error) {
      // (itemNumber, revision, designId, itemType) is unique. Nothing checks
      // it before the insert, so the commonest mistake in a spreadsheet import
      // — the same item number on two rows — arrived as a driver exception
      // whose message is the INSERT statement and every bound parameter, and
      // bulk importers copy that message straight into their per-row result.
      if (isUniqueViolation(error, { table: 'items' })) {
        throw new AlreadyExistsError(
          `${type} number`,
          validatedData.itemNumber,
          {
            operation: 'create',
            resource: type,
            revision: validatedData.revision,
            designId: validatedData.designId,
          },
        )
      }
      throw error
    }
  }

  /**
   * Refuse a write to an item whose design the caller cannot reach.
   *
   * Type-level RBAC ("may this user update parts?") is checked at the route;
   * it says nothing about *which* parts. Program membership is what scopes
   * that, and it was enforced only on the paths that happened to route through
   * a branch — so PUT and DELETE on every by-id type route wrote across the
   * program boundary. Putting it here covers all of them at once, including
   * batch update, and it runs before the lifecycle and designId validation so
   * a caller who may not touch the item learns that rather than which of its
   * fields are immutable.
   *
   * Items with no design (change orders, tools, physical parts) fall through:
   * there is no design to check. ECOs are gated on their own routes.
   */
  private static async requireDesignAccess(
    item: BaseItem,
    userId: string,
    action: 'update' | 'delete',
  ): Promise<void> {
    if (!item.designId) return
    if (await AccessControlService.canAccessDesign(userId, item.designId)) {
      return
    }
    throw new PermissionDeniedError(item.itemType, action, {
      userId,
      itemId: item.id,
      designId: item.designId,
    })
  }

  /**
   * Update an existing item
   *
   * In pre-release phase: Items can be updated directly
   * In post-release phase: Items on protected main branch cannot be updated directly
   *   - Must checkout to ECO/workspace branch first using CheckoutService
   *   - Exception: ECO release operations can bypass this with bypassBranchProtection option
   *
   * @param options.skipCommit - Skip creating a commit for this update (for bulk operations)
   * @param options.commitMessage - Override the auto-generated commit message
   */
  static async update<T extends BaseItem>(
    id: string,
    data: Partial<T>,
    userId: string,
    options?: {
      bypassBranchProtection?: boolean
      skipCommit?: boolean
      commitMessage?: string
      /**
       * Permit writing lifecycle-controlled fields (state/revision/isCurrent).
       * Reserved for the change-order release machinery — never set this from
       * routes, AI tools, or UI-facing services. Grep usages when auditing.
       */
      allowLifecycleFields?: boolean
      /**
       * Run inside the caller's transaction rather than opening one. The
       * change-order release needs every item it touches to commit or roll back
       * with the rest of the design's merge.
       */
      tx?: TransactionClient
      /**
       * Skip the caller's design-access check. Reserved for the change-order
       * release machinery — never set this from routes, AI tools, or
       * UI-facing services. Grep usages when auditing.
       *
       * The release needs it because a legitimate releaser may reach only a
       * subset of a multi-design ECO's designs (see resolveEcoDesignScope):
       * authorization for the release is decided once, on the ECO, and
       * re-checking it per item would fail releases that are entirely valid.
       */
      skipAccessCheck?: boolean
    },
  ): Promise<T> {
    // Get current item with type-specific data (for computing field changes)
    const oldItem = await this.findById(id, options?.tx)

    if (!oldItem) {
      throw new NotFoundError('Item', id, { operation: 'update' })
    }

    if (!options?.skipAccessCheck) {
      await this.requireDesignAccess(oldItem, userId, 'update')
    }

    // Lifecycle-controlled fields never change through the generic update
    // path (remediation WI-2.1): Free-lifecycle items transition via
    // POST /items/:id/transition, Driven items change state at ECO release,
    // and revisions are assigned by the merge. Identical echoed values
    // (whole-object form saves) are tolerated and stripped; attempts to
    // CHANGE a value are rejected.
    if (!options?.allowLifecycleFields) {
      const lifecycleFields = ['state', 'revision', 'isCurrent'] as const
      const record = data as Record<string, unknown>
      const oldRecord = oldItem as unknown as Record<string, unknown>
      const attempted = lifecycleFields.filter(
        (field) =>
          record[field] !== undefined && record[field] !== oldRecord[field],
      )
      if (attempted.length > 0) {
        throw new ValidationError(
          `Field(s) ${attempted.join(', ')} cannot be changed through item update. ` +
            'Item state transitions go through the lifecycle: Free-lifecycle items via POST /api/v1/items/:id/transition, ECO-controlled items at change-order release.',
        )
      }
      if (lifecycleFields.some((field) => record[field] !== undefined)) {
        data = { ...data }
        for (const field of lifecycleFields) {
          delete (data as Record<string, unknown>)[field]
        }
      }
    }

    // An item's design is not a field it carries — it is what owns the item's
    // branches, commits and BOM structure, none of which move with the row.
    // Clearing it (`designId: null`) strands the item outside versioning while
    // its history stays behind, and reassigning it lands the item in a design
    // whose branches never tracked it. Neither is recoverable through this
    // path, and no caller passes designId here, so both are rejected. Echoed
    // identical values (whole-object form saves) are tolerated and stripped,
    // as with the lifecycle fields above.
    //
    // Assigning a design to an item that has none stays allowed: it is the
    // only direction that adds history rather than orphaning it, and it is how
    // a design-less legacy item gets adopted into a design.
    if (data.designId !== undefined && oldItem.designId) {
      if (data.designId !== oldItem.designId) {
        throw new ValidationError(
          "designId cannot be changed through item update: an item's design " +
            'owns its version history, branches and BOM structure, which do ' +
            'not move with it. Create the item in the target design instead.',
          undefined,
          { operation: 'update', itemId: id },
        )
      }
      data = { ...data }
      delete (data as Record<string, unknown>).designId
    }

    // Enforce branch protection and the edit-lock (checkout) policy.
    // Skip if:
    // - bypassBranchProtection is true (for ECO releases or tests)
    // - Item is a ChangeOrder (workflow control objects are exempt)
    // requireContentEditable throws BranchProtectionError (locked branch or
    // protected main), ItemCheckoutRequiredError (branch working copy without
    // a held checkout), or ResourceLockedError (checked out by someone else).
    const isChangeOrder = oldItem.itemType === 'ChangeOrder'
    let branchInfo: {
      branchId: string
      branchName: string
      isLocked: boolean
      changeType: string | null
    } | null = null

    if (
      oldItem.designId &&
      !options?.bypassBranchProtection &&
      !isChangeOrder
    ) {
      branchInfo = await ItemEditPolicy.requireContentEditable(
        oldItem,
        userId,
        // A shared base row is fine here: the changeType-null delegation
        // below reroutes the edit through saveChanges (working-copy path)
        { allowSharedBase: true },
      )

      // The branch row still points at the shared base version (checked out,
      // but no branch-local copy yet). An in-place update here would mutate
      // the released/main row and leak the edit outside the branch, so route
      // the change through saveChanges, which creates the working copy.
      if (branchInfo && branchInfo.changeType === null) {
        const result = await CheckoutService.saveChanges(
          {
            branchId: branchInfo.branchId,
            itemId: id,
            changes: data,
            commitMessage:
              options?.commitMessage ??
              `${oldItem.itemType} ${oldItem.itemNumber || 'item'} updated`,
          },
          userId,
        )

        const workingCopy = await this.findById(result.item.id)
        if (!workingCopy) {
          throw new InternalError('Failed to fetch updated item', undefined, {
            operation: 'update',
            itemId: result.item.id,
          })
        }
        return workingCopy as T
      }
    }

    const typeConfig = ItemTypeRegistry.getType(oldItem.itemType)
    if (!typeConfig) {
      throw new NotFoundError('Item type', oldItem.itemType, {
        operation: 'update',
      })
    }

    // Wrap all database operations in a transaction for atomicity — the
    // caller's, when it has one
    return withTx(options?.tx, async (tx) => {
      // Update base item - only update fields that are provided
      const updateData: any = {
        modifiedBy: userId,
        modifiedAt: new Date(),
      }

      if (data.name !== undefined) updateData.name = data.name
      if (data.state !== undefined) updateData.state = data.state
      if (data.designId !== undefined) updateData.designId = data.designId
      if ((data as any).revision !== undefined)
        updateData.revision = (data as any).revision
      if ((data as any).isCurrent !== undefined)
        updateData.isCurrent = (data as any).isCurrent
      if (
        (data as unknown as { attributes?: Record<string, unknown> })
          .attributes !== undefined
      ) {
        updateData.attributes = (
          data as unknown as { attributes?: Record<string, unknown> }
        ).attributes
      }

      await tx.update(items).set(updateData).where(eq(items.id, id))

      // Update type-specific data
      await this.updateTypeSpecificData(oldItem.itemType, id, data, tx)

      // Fetch complete item with type-specific data
      // Must use tx to see uncommitted changes within this transaction
      const completeItem = await this.findById(id, tx)

      if (!completeItem) {
        throw new InternalError('Failed to fetch updated item', undefined, {
          operation: 'update',
          itemId: id,
        })
      }

      // Create commit for history tracking if item has a designId and skipCommit is not set
      if (oldItem.designId && !options?.skipCommit) {
        try {
          // Software manifest changes become per-file 'source' rows
          const fieldChanges = await expandSourceFieldChanges(
            oldItem.itemType,
            computeFieldChanges(
              oldItem as unknown as Record<string, unknown>,
              completeItem as unknown as Record<string, unknown>,
              oldItem.itemType,
            ),
          )

          if (fieldChanges.length > 0) {
            let branchId: string | null = null

            if (branchInfo) {
              branchId = branchInfo.branchId
            } else {
              const mainBranch = await BranchService.getMainBranch(
                oldItem.designId,
              )
              branchId = mainBranch?.id || null
            }

            if (branchId) {
              const commit = await CommitService.create(
                {
                  branchId,
                  message:
                    options?.commitMessage ??
                    `${oldItem.itemType} ${oldItem.itemNumber || 'item'} updated`,
                  itemChanges: [
                    {
                      itemId: id,
                      changeType: 'modified',
                      fieldChanges,
                    },
                  ],
                },
                userId,
                tx,
              )

              await tx
                .update(items)
                .set({ commitId: commit.id })
                .where(eq(items.id, id))
            }
          }
        } catch (error) {
          itemLogger.warn(
            { err: error, itemId: id },
            'Failed to create commit for item update',
          )
        }
      }

      return completeItem as T
    })
  }

  /**
   * Refuse a hard delete of a row whose state says it carries evidence meant
   * to outlive it. Expressed in lifecycle configuration, never in state names:
   *
   * - a released-family state is immutable lineage everywhere else in the
   *   codebase; this was the one place it was not;
   * - a final state whose `finalKind` is 'release' or 'complete' is the record
   *   that the release or the build happened. Against the shipped lifecycles
   *   that is an approved change order and a completed work order and nothing
   *   else — 'cancel' finals, and the finals that declare no kind (a retired
   *   tool, a scrapped physical part, a closed issue), stay deletable;
   * - an item governed by a Driving definition — a change order — may only be
   *   deleted while still in the state `create` gave it. Past that it holds
   *   votes, a locked branch and its affected-item list. Bounding it here is
   *   what keeps ChangeOrderService.create's cleanup of a change order it just
   *   failed to link working, and nothing wider.
   *
   * A change order's state mirrors its workflow instance rather than an item
   * lifecycle, so the flags are read from the *governing* definition:
   * `getLifecycleForItemType` deliberately never resolves a Driving workflow
   * as an item lifecycle, and would report every change order stateless.
   */
  private static async requireNoRetainedEvidence(
    item: BaseItem,
    id: string,
  ): Promise<void> {
    const { LifecycleService } = await import('../../services/LifecycleService')
    const label = item.itemNumber || id

    if (
      await LifecycleService.isReleasedFamilyState(item.itemType, item.state)
    ) {
      throw new ValidationError(
        `'${label}' is released. Released versions are never destroyed — obsolete it through a change order instead.`,
      )
    }

    const governing = await LifecycleService.getGoverningDefinition(
      item.itemType,
    )
    if (!governing) return

    const state = governing.states.find((s) => s.id === item.state)

    if (
      state?.isFinal === true &&
      (state.finalKind === 'release' || state.finalKind === 'complete')
    ) {
      throw new ValidationError(
        `'${label}' is the record of ${
          state.finalKind === 'release' ? 'a release' : 'completed work'
        } and cannot be deleted — its approvals, history and the work recorded against it would go with it.`,
      )
    }

    if (governing.lifecycleType === 'Driving' && state?.isInitial !== true) {
      throw new ValidationError(
        `'${label}' has left its initial state and cannot be deleted — deleting it would destroy its approval trail, workflow history and affected-item list. Cancel it through the workflow instead.`,
      )
    }
  }

  /**
   * Delete an item
   *
   * Idempotent for missing items (no error). Enforces the same edit-lock
   * policy as update(): protected main and other users' checkouts block the
   * delete. Branch-tracked rows must go through deleteOnBranch instead —
   * deleting them here would leave branch_items.currentItemId dangling.
   *
   * This is a hard delete, and the schema cascades from `items.id`: the
   * item_versions and item_field_changes rows go with it (the items row IS
   * the version content), and so do the workflow instance, its history and
   * approvals, a change order's affected and impacted lists, and a work
   * order's traveler lines and their executions. None of that is recoverable,
   * so the operation is bounded to rows that do not yet carry evidence meant
   * to outlive them — see `requireNoRetainedEvidence` and
   * docs/features/versioning.md. Anything past that point is retired through
   * its lifecycle, or deleted on a branch where the deletion is itself
   * history.
   */
  static async delete(
    id: string,
    userId: string,
    options?: {
      /**
       * Skip the caller's design-access check. Reserved for internal machinery
       * cleaning up an item it just created — never set this from routes, AI
       * tools, or UI-facing services. Grep usages when auditing.
       */
      skipAccessCheck?: boolean
    },
  ): Promise<void> {
    const item = await this.findById(id)
    if (!item) {
      return // preserve idempotent delete semantics
    }

    if (!options?.skipAccessCheck) {
      await this.requireDesignAccess(item, userId, 'delete')
    }

    const branchInfo = await ItemEditPolicy.requireContentEditable(item, userId)
    if (branchInfo) {
      throw new ValidationError(
        `Item '${item.itemNumber || id}' is tracked on branch "${branchInfo.branchName}". Use the branch delete operation (deleteOnBranch) so the change is recorded on the branch.`,
      )
    }

    await this.requireNoRetainedEvidence(item, id)

    await db.delete(items).where(eq(items.id, id))
  }

  /**
   * Create a new revision of an item
   */
  static async revise(
    id: string,
    newRevision: string,
    userId: string,
    outerTx?: TransactionClient,
  ): Promise<BaseItem> {
    // Wrap all revision operations in a transaction for atomicity — the
    // caller's, when it has one
    return withTx(outerTx, async (tx) => {
      // Get current item
      const result = await tx
        .select()
        .from(items)
        .where(eq(items.id, id))
        .limit(1)
      const currentItem = result.at(0)

      if (!currentItem) {
        throw new NotFoundError('Item', id, { operation: 'revise' })
      }

      // Mark current item as not current
      await tx
        .update(items)
        .set({ isCurrent: false })
        .where(eq(items.masterId, currentItem.masterId))

      // Get type-specific data
      const typeSpecificData = await this.getTypeSpecificData(
        currentItem.itemType,
        id,
      )

      // Create new revision, starting at the lifecycle's initial state
      const revisionInitialState = await this.resolveInitialStateId(
        currentItem.itemType,
      )
      const newItem = takeFirst(
        await tx
          .insert(items)
          .values({
            masterId: currentItem.masterId,
            itemNumber: currentItem.itemNumber,
            revision: newRevision,
            itemType: currentItem.itemType,
            name: currentItem.name,
            state: revisionInitialState,
            isCurrent: true,
            attributes: currentItem.attributes || {},
            sysmlType: currentItem.sysmlType,
            metamodel: currentItem.metamodel,
            usageOf: currentItem.usageOf,
            // Carrying the design forward is what keeps the new revision in
            // its design: without it the row landed with a null designId,
            // dropping out of the design's structure and slipping past the
            // (itemNumber, revision, designId, itemType) uniqueness check
            // that is supposed to catch revision collisions.
            designId: currentItem.designId,
            inDesignStructure: currentItem.inDesignStructure,
            createdBy: userId,
            modifiedBy: userId,
          })
          .returning(),
      )

      // Copy type-specific data
      if (typeSpecificData) {
        await this.insertTypeSpecificData(
          currentItem.itemType,
          newItem.id,
          typeSpecificData,
          tx,
        )
      }

      // Carry the item's files onto the new revision. File rows point at one
      // item *version*, so the revision would otherwise be born with no CAD and
      // no attachments - and this runs during ECO release, where that ships to
      // main. Loaded dynamically because FileService imports this module.
      const { FileService } = await import('../../vault/services/FileService')
      await FileService.copyFilesToItem({
        sourceItemId: currentItem.id,
        targetItemId: newItem.id,
        branchId: null,
        tx,
      })

      return {
        ...newItem,
        name: newItem.name,
        isCurrent: newItem.isCurrent ?? undefined,
        lockedBy: newItem.lockedBy ?? undefined,
        lockedAt: newItem.lockedAt ?? undefined,
      } as BaseItem
    })
  }

  /**
   * Find an item by ID
   */
  static async findById(
    id: string,
    tx?: TransactionClient,
  ): Promise<PersistedItem | null> {
    const run = tx ?? db
    const result = await run
      .select()
      .from(items)
      .where(and(eq(items.id, id), notDeleted()))
      .limit(1)
    const item = result.at(0)

    if (!item) {
      return null
    }

    const typeSpecificData = await this.getTypeSpecificData(
      item.itemType,
      id,
      tx,
    )

    return {
      ...item,
      ...typeSpecificData,
    }
  }

  /**
   * Every item matching `itemNumber`, best match first.
   *
   * Item numbers are not unique. `MbomService` copies an EBOM into a
   * Manufacturing design with the numbers unchanged, and a usage repeats its
   * definition's number in every design that uses it — so a bare number
   * routinely matches several rows. Callers that know which design they mean
   * pass `designId`; the rest get the ranking in `rankedRowsByNumber`, and
   * can show the runner-up rows rather than pretend the answer was unique.
   */
  static async findMatchesByNumber(
    itemNumber: string,
    revision?: string,
    options?: FindByNumberOptions,
  ): Promise<Array<ItemNumberMatch>> {
    const rows = await this.rankedRowsByNumber(itemNumber, revision, options)

    return rows.map(({ item, design }) => ({
      id: item.id,
      masterId: item.masterId,
      itemNumber: item.itemNumber,
      name: item.name,
      revision: item.revision,
      state: item.state,
      itemType: item.itemType,
      designId: item.designId,
      designCode: design?.code ?? null,
      designName: design?.name ?? null,
      designType: design?.designType ?? null,
    }))
  }

  /**
   * Rows matching `itemNumber`, in a total order so the same database always
   * yields the same winner.
   *
   * This used to be an unordered `LIMIT 1`, which handed the caller whichever
   * row the planner reached first — in practice the newest master, i.e. the
   * MBOM shadow rather than the engineering original it was copied from.
   *
   * The order is: design (`DESIGN_TYPE_PREFERENCE`), then released lineage
   * before drafts, then newest first, then id. Only the first two carry
   * meaning; the last two exist so ties resolve the same way every time.
   */
  private static async rankedRowsByNumber(
    itemNumber: string,
    revision?: string,
    options?: FindByNumberOptions,
  ): Promise<
    Array<{
      item: typeof items.$inferSelect
      design: typeof designs.$inferSelect | null
    }>
  > {
    const conditions: Array<SQL<unknown>> = [
      eq(items.itemNumber, itemNumber),
      notDeleted(),
      // Without a revision, "the item" is the current version of each master.
      revision ? eq(items.revision, revision) : eq(items.isCurrent, true),
    ]

    if (options?.designId) {
      conditions.push(eq(items.designId, options.designId))
    }

    const scope = accessScopeCondition(options?.accessScope)
    if (scope) {
      conditions.push(scope)
    }

    const rows = await db
      .select({ item: items, design: designs })
      .from(items)
      .leftJoin(designs, eq(items.designId, designs.id))
      .where(and(...conditions))

    if (rows.length < 2) {
      return rows
    }

    // One lifecycle resolution per distinct item type, not per row.
    const { LifecycleService } = await import('../../services/LifecycleService')
    const releasedStates = new Map<string, Array<string>>()
    for (const itemType of new Set(rows.map((row) => row.item.itemType))) {
      releasedStates.set(
        itemType,
        await LifecycleService.getReleasedFamilyStates(itemType),
      )
    }

    const designRank = (design: typeof designs.$inferSelect | null): number =>
      design
        ? (DESIGN_TYPE_PREFERENCE[design.designType] ?? NO_DESIGN_PREFERENCE)
        : NO_DESIGN_PREFERENCE

    const isReleased = (item: typeof items.$inferSelect): boolean =>
      releasedStates.get(item.itemType)?.includes(item.state) ?? false

    return rows.sort(
      (a, b) =>
        designRank(a.design) - designRank(b.design) ||
        Number(isReleased(b.item)) - Number(isReleased(a.item)) ||
        b.item.createdAt.getTime() - a.item.createdAt.getTime() ||
        a.item.id.localeCompare(b.item.id),
    )
  }

  /**
   * Find an item by number and optionally revision.
   *
   * Returns the best match — see `findMatchesByNumber` for why there can be
   * more than one, and `rankedRowsByNumber` for which one wins.
   */
  static async findByNumber(
    itemNumber: string,
    revision?: string,
    options?: FindByNumberOptions,
  ): Promise<PersistedItem | null> {
    const best = (
      await this.rankedRowsByNumber(itemNumber, revision, options)
    ).at(0)

    if (!best) {
      return null
    }

    const typeSpecificData = await this.getTypeSpecificData(
      best.item.itemType,
      best.item.id,
    )

    return {
      ...best.item,
      ...typeSpecificData,
    }
  }

  /**
   * Search items
   *
   * By default, only returns current items (isCurrent=true) to avoid showing
   * both master items and working copies. Set currentOnly=false to include all.
   *
   * Use definitionsOnly=true for global pages (/parts, /documents) to show only
   * definitions (canonical items) and exclude usages. Combine with includeUsageCount=true
   * to show how many designs use each definition.
   *
   * Supports server-side sorting, column filters, and global search for efficient
   * pagination over large datasets.
   */
  static async search<T = any>(
    type: string,
    criteria: SearchCriteria,
  ): Promise<SearchResult<T>> {
    return ItemSearchService.search<T>(type, criteria)
  }

  /**
   * Resolve exact item numbers to ids, keyed by lowercased item number
   * @delegate ItemSearchService.findIdsByItemNumbers
   */
  static async findIdsByItemNumbers(
    itemNumbers: Array<string>,
    options?: { designIds?: Array<string>; currentOnly?: boolean },
  ): Promise<Map<string, string>> {
    return ItemSearchService.findIdsByItemNumbers(itemNumbers, options)
  }

  /**
   * Search for items by item number or name
   * @delegate ItemSearchService.searchByItemNumber
   */
  static async searchByItemNumber(
    query: string,
    options?: {
      limit?: number
      offset?: number
      itemTypes?: Array<string>
      currentOnly?: boolean
      designIds?: Array<string>
      accessScope?: AccessScope | null
    },
  ): Promise<Array<BaseItem>> {
    return ItemSearchService.searchByItemNumber(query, options)
  }

  /**
   * Cross-type search for the enterprise search results page
   * @delegate ItemSearchService.searchGlobal
   */
  static async searchGlobal(
    criteria: GlobalSearchCriteria,
  ): Promise<SearchResult<GlobalSearchRow>> {
    return ItemSearchService.searchGlobal(criteria)
  }

  /**
   * Get items related to a specific item
   * @delegate ItemRelationshipService.getRelated
   */
  static async getRelated(
    id: string,
    relationshipType?: string,
  ): Promise<Array<PersistedItem>> {
    return ItemRelationshipService.getRelated(id, relationshipType)
  }

  /**
   * Get relationships with full details (including relationship metadata)
   * @delegate ItemRelationshipService.getRelationshipsWithDetails
   */
  static async getRelationshipsWithDetails(
    id: string,
    relationshipType?: string,
  ) {
    return ItemRelationshipService.getRelationshipsWithDetails(
      id,
      relationshipType,
    )
  }

  /**
   * Add a relationship between items
   * @delegate ItemRelationshipService.addRelationship
   */
  static async addRelationship(
    sourceId: string,
    targetId: string,
    relationshipType: string,
    userId: string,
    data?: {
      quantity?: string
      referenceDesignator?: string
      findNumber?: number
    },
    options?: { bypassEditGuard?: boolean },
  ): Promise<typeof itemRelationships.$inferSelect> {
    return ItemRelationshipService.addRelationship(
      sourceId,
      targetId,
      relationshipType,
      userId,
      data,
      options,
    )
  }

  /**
   * Remove a relationship between items
   * @delegate ItemRelationshipService.removeRelationship
   */
  static async removeRelationship(
    relationshipId: string,
    userId: string,
    options?: { bypassEditGuard?: boolean },
  ): Promise<void> {
    return ItemRelationshipService.removeRelationship(
      relationshipId,
      userId,
      options,
    )
  }

  /**
   * Update a relationship's properties (quantity, referenceDesignator, findNumber)
   * @delegate ItemRelationshipService.updateRelationship
   */
  static async updateRelationship(
    relationshipId: string,
    userId: string,
    data: {
      quantity?: string | null
      referenceDesignator?: string | null
      findNumber?: number | null
    },
    options?: { bypassEditGuard?: boolean },
  ): Promise<typeof itemRelationships.$inferSelect> {
    return ItemRelationshipService.updateRelationship(
      relationshipId,
      userId,
      data,
      options,
    )
  }

  /**
   * Get unique relationship types for an item
   * @delegate ItemRelationshipService.getRelationshipTypes
   */
  static async getRelationshipTypes(id: string): Promise<Array<string>> {
    return ItemRelationshipService.getRelationshipTypes(id)
  }

  // Private helper methods

  /** @internal Used by ItemVersioningFacade */
  static async insertTypeSpecificData(
    type: string,
    itemId: string,
    data: any,
    tx?: TransactionClient,
    ctx?: TypeHandlerContext,
  ): Promise<void> {
    const handler = getTypeHandler(type)
    if (!handler) {
      throw new InternalError(`No type handler registered for "${type}"`)
    }
    await handler.insert(itemId, data, tx, ctx)
  }

  /** @internal Used by ItemVersioningFacade */
  static async getTypeSpecificData(
    type: string,
    itemId: string,
    tx?: TransactionClient,
  ): Promise<any> {
    const handler = getTypeHandler(type)
    if (!handler) return null
    return handler.get(itemId, tx)
  }

  private static async updateTypeSpecificData(
    type: string,
    itemId: string,
    data: any,
    tx?: TransactionClient,
  ): Promise<void> {
    const handler = getTypeHandler(type)
    if (!handler) return
    await handler.update(itemId, data, tx)
  }

  // ============================================================================
  // Versioning Methods — delegated to ItemVersioningFacade
  //
  // These one-line delegates are the reason `ItemVersioningFacade` can stay a
  // private split of this class rather than a second service callers must know
  // about. Deleting them would push a facade import into every calling file.
  //
  // Only operations with logic of their own are delegated. `getHistory` and
  // `deleteOnBranch` forward straight to `CommitService`/`CheckoutService`
  // instead — routing a pure forward through the facade bought nothing but a
  // second hop.
  // ============================================================================

  /** @see ItemVersioningFacade.getAtContext */
  static async getAtContext(
    itemMasterId: string,
    designId: string,
    context: VersionContext,
  ): Promise<BaseItem | null> {
    return ItemVersioningFacade.getAtContext(itemMasterId, designId, context)
  }

  /** @see ItemVersioningFacade.listAtContext */
  static async listAtContext(
    designId: string,
    context: VersionContext,
    filters?: ItemFilters,
  ): Promise<{ items: Array<BaseItem>; total: number }> {
    return ItemVersioningFacade.listAtContext(designId, context, filters)
  }

  /**
   * Get version history for an item.
   *
   * @param itemMasterId - The master ID of the item
   * @param designId - The design ID
   * @param options.untilCommitId - Optional commit ID to limit history to (for viewing at a specific version)
   * @param options.branchId - Optional branch ID to filter commits by (only show commits on this branch)
   */
  static async getHistory(
    itemMasterId: string,
    designId: string,
    options?: {
      untilCommitId?: string
      branchId?: string
    },
  ): Promise<Array<ItemHistoryEntry>> {
    return CommitService.getItemCommits(itemMasterId, designId, options)
  }

  /** @see ItemVersioningFacade.diff */
  static async diff(
    itemId1: string,
    itemId2: string,
  ): Promise<{
    fields: Array<{
      field: string
      oldValue: unknown
      newValue: unknown
    }>
  }> {
    return ItemVersioningFacade.diff(itemId1, itemId2)
  }

  /** @see ItemVersioningFacade.createOnBranch */
  static async createOnBranch(
    type: string,
    data: BaseItem,
    branchId: string,
    commitMessage: string,
    userId: string,
  ): Promise<{ item: BaseItem; commit: typeof commits.$inferSelect }> {
    return ItemVersioningFacade.createOnBranch(
      type,
      data,
      branchId,
      commitMessage,
      userId,
    )
  }

  /** Delete an item on a branch (soft delete, recorded as a commit). */
  static async deleteOnBranch(
    itemMasterId: string,
    branchId: string,
    commitMessage: string,
    userId: string,
  ): Promise<typeof commits.$inferSelect> {
    return CheckoutService.deleteOnBranch(
      itemMasterId,
      branchId,
      commitMessage,
      userId,
    )
  }

  // ============================================================================
  // Edit-lock policy — delegated to ItemEditPolicy
  //
  // Same reasoning as the versioning delegates above: `ItemEditPolicy` is a
  // private split of this class, and these keep it that way.
  // ============================================================================

  /** @see ItemEditPolicy.canEditDirectly */
  static async canEditDirectly(designId: string): Promise<{
    allowed: boolean
    reason?: string
    requiresCheckout: boolean
  }> {
    return ItemEditPolicy.canEditDirectly(designId)
  }

  /** @see ItemEditPolicy.getItemBranchInfo */
  static async getItemBranchInfo(itemId: string): Promise<{
    branchId: string
    branchName: string
    branchType: string
    isLocked: boolean
    checkedOutBy: string | null
    changeType: string | null
  } | null> {
    return ItemEditPolicy.getItemBranchInfo(itemId)
  }

  /** @see ItemEditPolicy.requireContentEditable */
  static async requireContentEditable(
    item: {
      id: string
      masterId: string
      designId?: string | null
      itemType: string
      itemNumber?: string | null
      state?: string | null
    },
    userId: string,
    options?: { allowSharedBase?: boolean },
  ) {
    return ItemEditPolicy.requireContentEditable(item, userId, options)
  }
}
