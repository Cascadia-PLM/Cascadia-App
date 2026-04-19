import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  items,
  workInstructionChangeAlerts,
  workInstructionPartAttachments,
} from '@/lib/db/schema'

interface CreateAlertsInput {
  ecoId: string
  changedPartIds: Array<string>
  changeDetails?: Record<
    string,
    {
      changedFields?: Array<string>
      previousValues?: Record<string, unknown>
      newValues?: Record<string, unknown>
      changeType?: 'part_modified' | 'part_obsoleted' | 'parametric_stale'
    }
  >
}

interface AlertWithDetails {
  id: string
  workInstructionId: string
  partId: string
  ecoId: string | null
  changeType: string
  changedFields: Array<string> | null
  previousValues: Record<string, unknown> | null
  newValues: Record<string, unknown> | null
  status: string
  acknowledgedBy: string | null
  acknowledgedAt: Date | null
  notes: string | null
  createdAt: Date
  part?: {
    id: string
    itemNumber: string
    name: string | null
  }
  eco?: {
    id: string
    itemNumber: string
    name: string | null
  }
}

export class WorkInstructionChangeAlertService {
  /**
   * Create alerts for all work instructions attached to changed parts.
   * Called by the background job handler after ECO merge.
   */
  static async createAlerts(
    input: CreateAlertsInput,
  ): Promise<{ alertsCreated: number; workInstructionsAffected: number }> {
    if (input.changedPartIds.length === 0) {
      return { alertsCreated: 0, workInstructionsAffected: 0 }
    }

    // Find all WI attachments for the changed parts.
    // changedPartIds contains masterIds (constant across revisions), so we join
    // through items to match on masterId rather than the specific revision ID.
    const attachments = await db
      .select({
        workInstructionId: workInstructionPartAttachments.workInstructionId,
        partId: workInstructionPartAttachments.partId,
      })
      .from(workInstructionPartAttachments)
      .innerJoin(items, eq(workInstructionPartAttachments.partId, items.id))
      .where(inArray(items.masterId, input.changedPartIds))

    if (attachments.length === 0) {
      return { alertsCreated: 0, workInstructionsAffected: 0 }
    }

    // Deduplicate: one alert per WI-part pair
    const alertKeys = new Set<string>()
    const alertValues: Array<{
      workInstructionId: string
      partId: string
      ecoId: string
      changeType: string
      changedFields: Array<string> | undefined
      previousValues: Record<string, unknown> | undefined
      newValues: Record<string, unknown> | undefined
    }> = []

    for (const attachment of attachments) {
      const key = `${attachment.workInstructionId}:${attachment.partId}`
      if (alertKeys.has(key)) continue
      alertKeys.add(key)

      const details = input.changeDetails?.[attachment.partId]

      alertValues.push({
        workInstructionId: attachment.workInstructionId,
        partId: attachment.partId,
        ecoId: input.ecoId,
        changeType: details?.changeType ?? 'part_modified',
        changedFields: details?.changedFields,
        previousValues: details?.previousValues,
        newValues: details?.newValues,
      })
    }

    // Insert all alerts
    await db.insert(workInstructionChangeAlerts).values(alertValues)

    const affectedWiIds = new Set(alertValues.map((a) => a.workInstructionId))

    return {
      alertsCreated: alertValues.length,
      workInstructionsAffected: affectedWiIds.size,
    }
  }

  /**
   * Get alerts for a specific work instruction
   */
  static async getAlertsForWI(
    wiId: string,
    options?: { status?: string },
  ): Promise<Array<AlertWithDetails>> {
    const query = db
      .select({
        id: workInstructionChangeAlerts.id,
        workInstructionId: workInstructionChangeAlerts.workInstructionId,
        partId: workInstructionChangeAlerts.partId,
        ecoId: workInstructionChangeAlerts.ecoId,
        changeType: workInstructionChangeAlerts.changeType,
        changedFields: workInstructionChangeAlerts.changedFields,
        previousValues: workInstructionChangeAlerts.previousValues,
        newValues: workInstructionChangeAlerts.newValues,
        status: workInstructionChangeAlerts.status,
        acknowledgedBy: workInstructionChangeAlerts.acknowledgedBy,
        acknowledgedAt: workInstructionChangeAlerts.acknowledgedAt,
        notes: workInstructionChangeAlerts.notes,
        createdAt: workInstructionChangeAlerts.createdAt,
        part: {
          id: items.id,
          itemNumber: items.itemNumber,
          name: items.name,
        },
      })
      .from(workInstructionChangeAlerts)
      .innerJoin(items, eq(workInstructionChangeAlerts.partId, items.id))
      .where(
        options?.status
          ? and(
              eq(workInstructionChangeAlerts.workInstructionId, wiId),
              eq(workInstructionChangeAlerts.status, options.status),
            )
          : eq(workInstructionChangeAlerts.workInstructionId, wiId),
      )
      .orderBy(desc(workInstructionChangeAlerts.createdAt))

    return (await query) as Array<AlertWithDetails>
  }

  /**
   * Get pending alert count for a work instruction
   */
  static async getAlertCounts(
    wiId: string,
  ): Promise<{ pending: number; total: number }> {
    const [result] = await db
      .select({
        total: sql<number>`count(*)::int`,
        pending: sql<number>`count(*) filter (where ${workInstructionChangeAlerts.status} = 'pending')::int`,
      })
      .from(workInstructionChangeAlerts)
      .where(eq(workInstructionChangeAlerts.workInstructionId, wiId))

    return {
      pending: result?.pending ?? 0,
      total: result?.total ?? 0,
    }
  }

  /**
   * Acknowledge a single alert
   */
  static async acknowledgeAlert(
    alertId: string,
    userId: string,
    notes?: string,
  ): Promise<void> {
    await db
      .update(workInstructionChangeAlerts)
      .set({
        status: 'acknowledged',
        acknowledgedBy: userId,
        acknowledgedAt: new Date(),
        notes: notes || null,
      })
      .where(eq(workInstructionChangeAlerts.id, alertId))
  }

  /**
   * Dismiss a single alert
   */
  static async dismissAlert(
    alertId: string,
    userId: string,
    notes?: string,
  ): Promise<void> {
    await db
      .update(workInstructionChangeAlerts)
      .set({
        status: 'dismissed',
        acknowledgedBy: userId,
        acknowledgedAt: new Date(),
        notes: notes || null,
      })
      .where(eq(workInstructionChangeAlerts.id, alertId))
  }

  /**
   * Bulk acknowledge all pending alerts for a work instruction
   */
  static async bulkAcknowledge(
    wiId: string,
    userId: string,
  ): Promise<{ acknowledged: number }> {
    const result = await db
      .update(workInstructionChangeAlerts)
      .set({
        status: 'acknowledged',
        acknowledgedBy: userId,
        acknowledgedAt: new Date(),
      })
      .where(
        and(
          eq(workInstructionChangeAlerts.workInstructionId, wiId),
          eq(workInstructionChangeAlerts.status, 'pending'),
        ),
      )
      .returning()

    return { acknowledged: result.length }
  }
}
