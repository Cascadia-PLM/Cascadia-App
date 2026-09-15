// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { JobContext, JobHandler } from '../types'
import type {
  WiPartChangedPayload,
  WiPartChangedResult,
} from '../definitions/workinstruction/types'

export const wiPartChangedHandler: JobHandler<
  WiPartChangedPayload,
  WiPartChangedResult
> = {
  type: 'notification.workinstruction.partchanged',

  async execute(
    payload: WiPartChangedPayload,
    context: JobContext,
  ): Promise<WiPartChangedResult> {
    // Either key: see the payload schema
    const changeOrderId = payload.changeOrderId ?? payload.ecoId
    if (!changeOrderId) throw new Error('Payload names no change order')

    await context.log.info('Starting WI part change alert creation', {
      changeOrderId,
      changedPartIds: payload.changedPartIds,
    })

    // Dynamic import to avoid circular dependencies
    const { WorkInstructionChangeAlertService } =
      await import('../../services/WorkInstructionChangeAlertService')

    if (context.signal.aborted) throw new Error('Job cancelled')

    await context.updateProgress(10, 'Querying affected work instructions...')

    const result = await WorkInstructionChangeAlertService.createAlerts({
      ecoId: changeOrderId,
      changedPartIds: payload.changedPartIds,
      changeDetails: payload.changeDetails,
    })

    await context.updateProgress(100, 'Alerts created')

    await context.log.info('WI alerts created', {
      alertsCreated: result.alertsCreated,
      workInstructionsAffected: result.workInstructionsAffected,
    })

    return result
  },
}
