// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { defineDomainEvent } from '../publish'

export const itemCreatedPayloadSchema = z.object({
  itemId: z.string().uuid(),
  masterId: z.string().uuid(),
  itemType: z.string(),
  itemNumber: z.string(),
  name: z.string().nullish(),
  designId: z.string().uuid().nullable(),
  state: z.string(),
  revision: z.string(),
})

export type ItemCreatedPayload = z.infer<typeof itemCreatedPayloadSchema>

/**
 * A new item master came into existence (first revision of any item type).
 * Emitted inside `ItemService.create`'s transaction. Subsequent versions on
 * ECO branches are not "created" — they surface as `change_order.released`
 * items when they reach main.
 */
export const ITEM_CREATED = defineDomainEvent({
  type: 'item.created',
  schemaVersion: 1,
  description: 'A new item (first revision of a new master) was created',
  subjectType: 'item',
  payloadSchema: itemCreatedPayloadSchema,
})

export const itemReleasedPayloadSchema = z.object({
  changeOrderId: z.string().uuid(),
  designId: z.string().uuid(),
  /** The version row that reached main. */
  itemId: z.string().uuid(),
  masterId: z.string().uuid(),
  itemNumber: z.string(),
  name: z.string().nullable(),
  itemType: z.string(),
  /** Empty string when the item is new in this release. */
  previousRevision: z.string(),
  newRevision: z.string(),
  /** 'deleted' means the release removed the item from main. */
  changeType: z.enum(['modified', 'added', 'deleted']),
  /**
   * The affected-item action that produced this release, or null when the
   * item was branch content merged to main.
   */
  action: z.enum(['revise', 'release', 'promote']).nullable(),
})

export type ItemReleasedPayload = z.infer<typeof itemReleasedPayloadSchema>

/**
 * One released version reached main through a change order — the per-item
 * fact an ERP sync, a webhook following one part, or a suspect-link sweep
 * keys on. `subject.masterId` is the stable identity across revisions.
 *
 * Emitted inside the release transaction by every arm of a release — the
 * branch merge and both affected-item passes — one event per item, before
 * the per-design `design.released` summary of the same pass; a consumer
 * therefore sees the parts, then the release that carried them.
 * An 'obsolete' action emits `item.obsoleted` instead.
 */
export const ITEM_RELEASED = defineDomainEvent({
  type: 'item.released',
  schemaVersion: 1,
  description:
    'A released version of an item reached main through a change order',
  subjectType: 'item',
  payloadSchema: itemReleasedPayloadSchema,
})
