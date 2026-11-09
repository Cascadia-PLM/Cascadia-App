// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { ItemService } from './ItemService'
import type { BaseItem } from '@cascadia/commons/items/types/base'
import type { BatchCreateRequest } from '@/api/schemas'
import type { BatchCreateResult } from '@/jobs/definitions/import/types'
import type { BulkRunOptions } from '@/import/bulk-run'
import { formatCount, throwIfStopped } from '@/import/bulk-run'

/**
 * The write loop of `POST /api/v1/items/batch-create`.
 *
 * Runs on the jobs worker. The route authorizes the whole batch before
 * queuing it — the type verb for every item type in it, program membership
 * for every design and branch it names, `system:manage` for
 * `bypassBranchProtection`, and the refusal of change orders — so a batch
 * that reaches this has already been admitted whole, and every row here is
 * one the caller may write.
 *
 * Each row is created on its own and its outcome recorded, so one bad row
 * never costs the others. There is no size cap; see `BulkRunOptions`.
 */
export class BatchCreateService {
  static async run(
    request: BatchCreateRequest,
    userId: string,
    options: BulkRunOptions = {},
  ): Promise<BatchCreateResult> {
    const { items: requestItems, bypassBranchProtection } = request
    const result: BatchCreateResult = { created: [], errors: [] }

    for (const [i, itemRequest] of requestItems.entries()) {
      throwIfStopped(options.signal)
      const { itemType, data } = itemRequest

      try {
        // `data` is a free record; the type handler validates it on create.
        const itemData = data as unknown as BaseItem & {
          branchId?: string
          commitMessage?: string
        }

        let createdItem: BaseItem
        if (itemData.branchId) {
          // ECO and workspace branches: the design comes from the branch.
          const branchResult = await ItemService.createOnBranch(
            itemType,
            itemData,
            itemData.branchId,
            itemData.commitMessage || `Created ${itemType}`,
            userId,
          )
          createdItem = branchResult.item
        } else {
          createdItem = await ItemService.create(itemType, itemData, userId, {
            bypassBranchProtection,
          })
        }
        result.created.push(createdItem)
      } catch (error) {
        const { itemNumber } = data as { itemNumber?: unknown }
        result.errors.push({
          itemNumber:
            typeof itemNumber === 'string' && itemNumber
              ? itemNumber
              : 'unknown',
          error: 'Failed to create item',
          details: (error as Error).message,
        })
      }

      await options.onProgress?.({
        done: i + 1,
        total: requestItems.length,
        message: `Processed ${formatCount(i + 1)} of ${formatCount(requestItems.length)} items`,
      })
    }

    return result
  }
}
