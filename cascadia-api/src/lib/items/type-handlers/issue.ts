// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq, inArray } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import type { DbInstance, TransactionClient } from '@/lib/db'
import { db } from '@/lib/db'
import {
  designs,
  issueAffectedItems,
  issueDesigns,
  issues,
} from '@/lib/db/schema'

/**
 * The program an issue's chosen designs resolve to, or null.
 *
 * `issues.program_id` is one of the three axes the item-list predicate and
 * `requireIssueAccess` scope an issue on, and it is the only one an issue
 * raised off a branch would otherwise have. The designs are the input: the
 * create form collects them by hand from a list already bounded by the
 * caller's own reach, so taking the program from them adds no authority the
 * caller did not already exercise.
 *
 * Narrowed the same three ways the work-order backfill is:
 *
 *  - a design carrying no program (the Standard Library) resolves nothing
 *  - two distinct programs resolve nothing, because an issue spanning
 *    programs has no single answer and guessing one would move it
 *  - an explicit `programId` always wins; this only fills an absence
 *
 * It lives here rather than in the route on purpose. The issue create form is
 * not the only way an issue is born: the CSV import wizard
 * (`POST /api/v1/import/issues`) and the AI create tool, whose `itemType` is
 * an unconstrained string, both call `ItemService.create` directly. A
 * derivation placed in `POST /api/v1/items` would simply be absent on those
 * paths. The type handler is the one funnel they all go through.
 *
 * This originally cited `POST /api/v1/items/batch-create` as that other path,
 * which was wrong: `batchCreateItemSchema.itemType` does not accept `Issue`,
 * so that route 400s on an issue row before any handler runs. It would join
 * the list if `Issue` were ever added to the enum — and it now takes the
 * design/branch access pre-flight the original comment noted it lacked.
 */
async function deriveProgramFromDesigns(
  run: DbInstance | TransactionClient,
  designIds: Array<string> | undefined,
): Promise<string | null> {
  if (!designIds?.length) return null

  const rows = await run
    .selectDistinct({ programId: designs.programId })
    .from(designs)
    .where(inArray(designs.id, designIds))

  const resolved = rows
    .map((r) => r.programId)
    .filter((id): id is string => id !== null)

  return resolved.length === 1 ? resolved[0]! : null
}

registerTypeHandler('Issue', {
  table: issues,

  async insert(itemId, data, tx) {
    const run = tx ?? db
    const programId: string | null =
      data.programId || (await deriveProgramFromDesigns(run, data.designIds))
    await run.insert(issues).values({
      itemId,
      description: data.description || null,
      severity: data.severity || null,
      priority: data.priority || null,
      category: data.category || null,
      reportedBy: data.reportedBy || null,
      reportedDate: data.reportedDate || null,
      assignedTo: data.assignedTo || null,
      resolution: data.resolution || null,
      resolvedDate: data.resolvedDate || null,
      rootCause: data.rootCause || null,
      programId,
    })

    // Insert junction table rows for designIds
    if (data.designIds?.length) {
      await run.insert(issueDesigns).values(
        data.designIds.map((designId: string) => ({
          issueItemId: itemId,
          designId,
        })),
      )
    }

    // Insert junction table rows for affectedItemIds
    if (data.affectedItemIds?.length) {
      await run.insert(issueAffectedItems).values(
        data.affectedItemIds.map((affectedItemId: string) => ({
          issueItemId: itemId,
          affectedItemId,
        })),
      )
    }
  },

  async get(itemId, tx) {
    const run = tx ?? db
    const [issue] = await run
      .select()
      .from(issues)
      .where(eq(issues.itemId, itemId))
      .limit(1)
    if (!issue) return undefined

    // Fetch related design IDs
    const designLinks = await run
      .select({ designId: issueDesigns.designId })
      .from(issueDesigns)
      .where(eq(issueDesigns.issueItemId, itemId))
    const designIds = designLinks.map((d) => d.designId)

    // Fetch related affected item IDs
    const affected = await run
      .select({ affectedItemId: issueAffectedItems.affectedItemId })
      .from(issueAffectedItems)
      .where(eq(issueAffectedItems.issueItemId, itemId))
    const affectedItemIds = affected.map((a) => a.affectedItemId)

    return {
      ...issue,
      designIds: designIds.length > 0 ? designIds : undefined,
      affectedItemIds: affectedItemIds.length > 0 ? affectedItemIds : undefined,
    }
  },

  async update(itemId, data, tx) {
    const run = tx ?? db
    const updateData: Record<string, unknown> = {}

    if (data.description !== undefined)
      updateData.description = data.description || null
    if (data.severity !== undefined) updateData.severity = data.severity || null
    if (data.priority !== undefined) updateData.priority = data.priority || null
    if (data.category !== undefined) updateData.category = data.category || null
    if (data.reportedBy !== undefined)
      updateData.reportedBy = data.reportedBy || null
    if (data.reportedDate !== undefined)
      updateData.reportedDate = data.reportedDate || null
    if (data.assignedTo !== undefined)
      updateData.assignedTo = data.assignedTo || null
    if (data.resolution !== undefined)
      updateData.resolution = data.resolution || null
    if (data.resolvedDate !== undefined)
      updateData.resolvedDate = data.resolvedDate || null
    if (data.rootCause !== undefined)
      updateData.rootCause = data.rootCause || null
    if (data.programId !== undefined)
      updateData.programId = data.programId || null

    if (Object.keys(updateData).length > 0) {
      await run.update(issues).set(updateData).where(eq(issues.itemId, itemId))
    }

    // Replace design associations if provided
    if (data.designIds !== undefined) {
      await run.delete(issueDesigns).where(eq(issueDesigns.issueItemId, itemId))
      if (data.designIds?.length) {
        await run.insert(issueDesigns).values(
          data.designIds.map((designId: string) => ({
            issueItemId: itemId,
            designId,
          })),
        )
      }
    }

    // Replace affected item associations if provided
    if (data.affectedItemIds !== undefined) {
      await run
        .delete(issueAffectedItems)
        .where(eq(issueAffectedItems.issueItemId, itemId))
      if (data.affectedItemIds?.length) {
        await run.insert(issueAffectedItems).values(
          data.affectedItemIds.map((affectedItemId: string) => ({
            issueItemId: itemId,
            affectedItemId,
          })),
        )
      }
    }
  },
})
