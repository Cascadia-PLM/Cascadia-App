import { eq } from 'drizzle-orm'
import { registerTypeHandler } from './index'
import { db } from '@/lib/db'
import { issueAffectedItems, issueDesigns, issues } from '@/lib/db/schema'

registerTypeHandler('Issue', {
  async insert(itemId, data, tx) {
    const run = tx ?? db
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
      programId: data.programId || null,
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
    const designs = await run
      .select({ designId: issueDesigns.designId })
      .from(issueDesigns)
      .where(eq(issueDesigns.issueItemId, itemId))
    const designIds = designs.map((d) => d.designId)

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
