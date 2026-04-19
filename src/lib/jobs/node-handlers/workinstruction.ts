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
    await context.log.info('Starting WI part change alert creation', {
      ecoId: payload.ecoId,
      changedPartIds: payload.changedPartIds,
    })

    // Dynamic import to avoid circular dependencies
    const { WorkInstructionChangeAlertService } =
      await import('../../services/WorkInstructionChangeAlertService')

    if (context.signal.aborted) throw new Error('Job cancelled')

    await context.updateProgress(10, 'Querying affected work instructions...')

    const result = await WorkInstructionChangeAlertService.createAlerts({
      ecoId: payload.ecoId,
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
