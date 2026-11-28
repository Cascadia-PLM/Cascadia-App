// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useMatches } from '@tanstack/react-router'
import { ITEM_TYPE_DEFINITIONS } from '@cascadia/commons/items/item-type-definitions'

/**
 * The page the chat panel is open on, as the ids its route names.
 *
 * Sent with every chat turn so the assistant knows what "this part" means and
 * a new conversation is scoped to the program the user is working in. Ids
 * only: the server checks each against what the user can reach and reads the
 * names itself (`cascadia-api/src/ai/page-context.ts`), so nothing here is
 * trusted and nothing here needs a fetch.
 */
export interface ChatPage {
  itemId?: string
  designId?: string
  programId?: string
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Route ids of the item detail pages, from the shared registry. */
const ITEM_DETAIL_ROUTES = Object.values(ITEM_TYPE_DEFINITIONS).map(
  (definition) => `${definition.detailPath}/$id`,
)

/** True for the route itself and anything nested under it (`…/$id/edit`). */
function isUnder(routeId: string, detailRoute: string): boolean {
  return routeId === detailRoute || routeId.startsWith(`${detailRoute}/`)
}

function uuidOf(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_PATTERN.test(value)
    ? value
    : undefined
}

/**
 * Classify a route match. Pure, and by route id rather than pathname — for
 * the reason `useBreadcrumbRouteInfo` gives: a static segment such as `new`
 * is never mistaken for an id, and the id always belongs to the route it is
 * read with.
 */
export function chatPageOf(match: {
  routeId: string
  params?: object
  search?: object
}): ChatPage | undefined {
  const params = (match.params ?? {}) as Record<string, unknown>
  const search = (match.search ?? {}) as Record<string, unknown>
  const id = uuidOf(params.id)

  const page: ChatPage = {}
  if (id && isUnder(match.routeId, '/designs/$id')) {
    page.designId = id
  } else if (id && isUnder(match.routeId, '/programs/$id')) {
    page.programId = id
  } else if (id && ITEM_DETAIL_ROUTES.some((r) => isUnder(match.routeId, r))) {
    page.itemId = id
  }

  // List pages carry their Program/Design filter in the search string.
  page.designId ??= uuidOf(search.designId)
  page.programId ??= uuidOf(search.programId)

  return page.itemId || page.designId || page.programId ? page : undefined
}

/** The current page, from the deepest route match the router has committed. */
export function useChatPage(): ChatPage | undefined {
  return useMatches({
    select: (matches) => {
      const leaf = matches.at(-1)
      return leaf ? chatPageOf(leaf) : undefined
    },
    // A fresh object every render would re-render the panel on every router
    // tick; the page only changes when one of its three ids does.
    structuralSharing: true,
  })
}
