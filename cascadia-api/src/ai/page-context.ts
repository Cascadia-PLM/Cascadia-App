// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { AccessControlService } from '@/auth/AccessControlService'
import { requireItemAccess } from '@/auth/access'
import { DesignService } from '@/services/DesignService'
import { ProgramService } from '@/services/ProgramService'

/**
 * The page the chat panel was opened on, resolved into what the assistant may
 * be told about it.
 *
 * The panel sends ids, never names: the item, design or program its route
 * names (`/parts/$id`, `/designs/$id`, a list page's `?designId=`). Each id is
 * a claim from a request body, so it is treated the way `resolveChatScope`
 * treats `programId` — checked against what this caller can reach before
 * anything is read from it. The difference is what a failed check does. A
 * scope the caller asked for and may not have is a refusal; a page is ambient
 * — the user did not type it — so one that does not resolve is dropped and
 * the turn goes ahead without it. Not-found and not-permitted drop the same
 * way, so the panel cannot be used to probe which ids exist.
 *
 * What the ids resolve to is derived downwards, never trusted sideways: an
 * item names its own design, and a design its own program, so a body pairing
 * a reachable item with someone else's `programId` gets the item's program.
 * A claimed `designId` or `programId` is used only when nothing above it
 * resolved one.
 */

/**
 * The wire shape. Every field degrades to absent rather than failing the
 * body: a route whose `$id` is not a UUID must not turn a chat turn into a
 * 400.
 */
const optionalId = z.string().uuid().optional().catch(undefined)

export const chatPageSchema = z
  .object({
    itemId: optionalId,
    designId: optionalId,
    programId: optionalId,
  })
  .optional()
  .catch(undefined)

export type ChatPageRequest = z.infer<typeof chatPageSchema>

export interface ChatPageContext {
  item: {
    id: string
    itemNumber: string
    name: string | null
    itemType: string
    revision: string
  } | null
  design: { id: string; name: string; code: string } | null
  program: { id: string; name: string; code: string } | null
}

async function reachableItem(userId: string, itemId: string) {
  try {
    const item = await requireItemAccess(userId, itemId)
    return item.isDeleted ? null : item
  } catch {
    return null
  }
}

export async function resolveChatPage(
  userId: string,
  page: ChatPageRequest,
): Promise<ChatPageContext | null> {
  if (!page) return null

  const item = page.itemId ? await reachableItem(userId, page.itemId) : null

  // `requireItemAccess` passes a design-less row without consulting a design,
  // so the design is gated here in its own right either way.
  const designId = item ? item.designId : (page.designId ?? null)
  const design =
    designId && (await AccessControlService.canAccessDesign(userId, designId))
      ? await DesignService.getById(designId)
      : null

  // A design that resolved names its program; `canAccessDesign` admits a
  // program-less design, so that program is still checked rather than assumed.
  const programId = design
    ? design.programId
    : item
      ? null
      : (page.programId ?? null)
  const program =
    programId &&
    (await AccessControlService.canAccessProgram(userId, programId))
      ? await ProgramService.getById(programId)
      : null

  if (!item && !design && !program) return null

  return {
    item: item
      ? {
          id: item.id,
          itemNumber: item.itemNumber,
          name: item.name,
          itemType: item.itemType,
          revision: item.revision,
        }
      : null,
    design: design
      ? { id: design.id, name: design.name, code: design.code }
      : null,
    program: program
      ? { id: program.id, name: program.name, code: program.code }
      : null,
  }
}
