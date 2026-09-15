// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { orNull } from '../extensions/operations'
import { LifecycleService } from '../services/LifecycleService'
import type {
  ItemDeleteIntent,
  ItemUpdateIntent,
  LifecyclePositionFields,
} from '../extensions/operations'

/**
 * The intents the item guard sites hand a `guard` extension, built in one place.
 *
 * Two services dispatch `item.update` — `ItemService.update` for an in-place
 * edit and `CheckoutService.saveChanges` for an edit on a change-order branch —
 * and a rule must see the same shape from both, or it matches on one path and
 * silently not the other.
 *
 * Build one only after `hasGuardExtensions` says a guard is registered: the
 * lifecycle position costs a lookup, and zero registrations must cost nothing.
 */

/** The fields an intent reads off the item an operation acts on. */
interface GuardedItem {
  id: string
  masterId: string
  itemType: string
  designId?: string | null
  itemNumber?: string | null
  state: string
  revision: string
}

async function lifecyclePosition(
  item: GuardedItem,
): Promise<LifecyclePositionFields> {
  const position = await LifecycleService.statePosition(
    item.itemType,
    item.state,
  )
  return {
    stateId: item.state,
    stateIsInitial: position.isInitial,
    stateIsReleased: position.isReleased,
    stateIsFinal: position.isFinal,
    stateFinalKind: position.finalKind,
  }
}

/** The `item.update` intent for an edit of `item` carrying `changes`. */
export async function itemUpdateIntent(
  item: GuardedItem,
  changes: Record<string, unknown>,
): Promise<ItemUpdateIntent> {
  return {
    ...(await lifecyclePosition(item)),
    itemId: item.id,
    masterId: item.masterId,
    itemType: item.itemType,
    designId: orNull(item.designId),
    itemNumber: orNull(item.itemNumber),
    revision: item.revision,
    changedFields: Object.keys(changes),
    changes,
  }
}

/** The `item.delete` intent for deleting `item`. */
export async function itemDeleteIntent(
  item: GuardedItem,
): Promise<ItemDeleteIntent> {
  return {
    ...(await lifecyclePosition(item)),
    itemId: item.id,
    masterId: item.masterId,
    itemType: item.itemType,
    designId: orNull(item.designId),
    itemNumber: orNull(item.itemNumber),
    revision: item.revision,
  }
}
