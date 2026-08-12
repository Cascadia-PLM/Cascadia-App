// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { designDetailQuery, entityQuery } from '@/lib/query'
import {
  itemSearchQuery,
  itemTextSearchQuery,
} from '@/lib/query/options/item-search'
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue'

/** The relationship type that carries BOM structure. */
export const BOM_RELATIONSHIP_TYPE = 'BOM'

/**
 * BOM lines are Part-to-Part — see the `BOM` entry in `partRelationships`
 * (`@/lib/items/types/part`), whose `targetTypes` is `['Part']`.
 */
export const BOM_TARGET_ITEM_TYPE = 'Part'

/**
 * How many candidates to fetch per scope once BOM has narrowed the picker.
 *
 * These dialogs filter what they fetched rather than asking the server to
 * search, so the fetch has to be wide enough to hold everything the box could
 * match. Unscoped that is hopeless and the list stays short; the design and
 * the library are each a bounded set, so fetch them whole and the filter
 * becomes complete. Per scope, so neither one can crowd out the other.
 */
export const BOM_TARGET_FETCH_LIMIT = 200

/**
 * How many items to list when browsing an unscoped relationship type.
 *
 * Unscoped there is no bounded set to fetch whole, so this is a sample of what
 * exists — most-recently-created first — not a searchable universe. Finding a
 * specific item is the search box's job, and it asks the server.
 */
const BROWSE_FETCH_LIMIT = 20

/**
 * How many matches a server-side search returns.
 *
 * Larger than the browse list because these rows all matched what the user
 * typed, and smaller than the BOM fetch because nothing filters them further
 * in the page.
 */
const SEARCH_FETCH_LIMIT = 50

/**
 * Shortest term worth sending. `searchByItemNumber` returns nothing below two
 * characters, so a one-character term narrows the browse list in the page
 * rather than making a request that is guaranteed to come back empty.
 */
const MIN_SERVER_SEARCH_CHARS = 2

/** The fields of the source item that decide what its BOM may point at. */
interface SourceItem {
  masterId: string
  designId?: string | null
}

/** A row in a relationship target picker, as the search endpoint returns it. */
export interface TargetItem {
  id: string
  masterId: string
  itemNumber: string
  revision: string
  itemType: string
  name: string
  state: string
  /** Design metadata the endpoint adds, relative to `contextDesignId`. */
  designCode?: string | null
  designName?: string | null
  isExternal?: boolean
}

export interface BomTargetScope {
  /** The chosen relationship type is BOM, so the target picker is confined. */
  active: boolean
  /** Design the picker is confined to. Undefined until the source item loads. */
  designId?: string
  /** Design code (or name) for display, once it loads. */
  designLabel?: string
  /** Master ID of the source item, so a picker can drop it from its own list. */
  sourceMasterId?: string
  /** The scope is still resolving — hold the search rather than run it unscoped. */
  loading: boolean
  /** Restricted, but the source item is in no design: only the library is open. */
  noDesign: boolean
}

/**
 * Work out whether a relationship picker is building BOM structure, and which
 * design it is building it in.
 *
 * A BOM line belongs to a design: parent and child are versioned together on
 * that design's branches, an ECO releases them together, and the structure
 * endpoints read the tree one design at a time. So BOM narrows the picker to
 * the source item's own design — plus the Standard Library, whose parts are
 * global and are exactly what a BOM reaches for in fasteners and raw stock.
 * Every other relationship type is left unscoped; cross-design references are
 * the point of `Reference`, `Document`, and friends.
 *
 * The source item's design comes from its detail record, which the detail page
 * that hosts the dialog has already cached, so the usual case costs no request.
 */
export function useBomTargetScope(
  itemId: string,
  relationshipType: string,
): BomTargetScope {
  const active = relationshipType === BOM_RELATIONSHIP_TYPE

  const { data: source, isPending: sourcePending } = useQuery(
    entityQuery<SourceItem>('items', itemId, 'item', active),
  )
  const designId = source?.designId ?? undefined

  const { data: design } = useQuery(
    designDetailQuery(designId ?? '', active && Boolean(designId)),
  )

  if (!active) {
    return { active: false, loading: false, noDesign: false }
  }

  return {
    active: true,
    designId,
    designLabel: design ? design.code || design.name : undefined,
    sourceMasterId: source?.masterId,
    loading: sourcePending,
    // A failed lookup lands here too, which is the safe side to fail on: the
    // library alone beats a picker silently widened to every design.
    noDesign: !sourcePending && !designId,
  }
}

/**
 * The items a relationship picker may offer, and why.
 *
 * Two modes, chosen by whether the user has typed a search term.
 *
 * **Browsing** (no term) lists what exists. Under BOM that is the source
 * item's design plus the Standard Library, each fetched on its own so neither
 * crowds the other out of the row limit; under any other type it is a short
 * by-type list.
 *
 * **Searching** (a term) asks the server, rather than filtering the browse
 * list in the page. Filtering the fetched rows meant the search box could only
 * ever find items inside the most recent `BROWSE_FETCH_LIMIT` of them — type an
 * item number that existed but sorted outside that window and the dialog said
 * "No items found" about a part sitting in the database. Scope is preserved
 * across the switch: a BOM search still asks only about the design and the
 * library.
 */
export function useRelationshipTargets({
  itemId,
  relationshipType,
  itemType,
  search = '',
}: {
  itemId: string
  relationshipType: string
  /** The user's item-type choice. Ignored while BOM fixes the type to Part. */
  itemType: string
  /** Raw search box text. Debounced here; callers pass it through unchanged. */
  search?: string
}): { scope: BomTargetScope; candidates: Array<TargetItem>; loading: boolean } {
  const scope = useBomTargetScope(itemId, relationshipType)

  const debounced = useDebouncedValue(search.trim())
  // Below the server's own minimum the request would return nothing, so short
  // terms narrow the browse list in the page instead of asking about them.
  const searching = debounced.length >= MIN_SERVER_SEARCH_CHARS

  // --- Browsing ---
  const designBrowse = useQuery(
    itemSearchQuery<TargetItem>(
      {
        itemType: BOM_TARGET_ITEM_TYPE,
        limit: BOM_TARGET_FETCH_LIMIT,
        designScope: 'current',
        contextDesignId: scope.designId,
      },
      scope.active && !searching,
    ),
  )

  const libraryBrowse = useQuery(
    itemSearchQuery<TargetItem>(
      {
        itemType: BOM_TARGET_ITEM_TYPE,
        limit: BOM_TARGET_FETCH_LIMIT,
        designScope: 'library',
        // Sent so library hits come back flagged external to this design,
        // which is what earns them their badge in the list
        contextDesignId: scope.designId,
      },
      scope.active && !searching,
    ),
  )

  const typeBrowse = useQuery(
    itemSearchQuery<TargetItem>(
      { itemType, limit: BROWSE_FETCH_LIMIT },
      !scope.active && !searching,
    ),
  )

  // --- Searching ---
  // Mirrors the browse split: `designScope` names one scope at a time, so BOM
  // asks twice rather than widening to every design.
  const designSearch = useQuery(
    itemTextSearchQuery<TargetItem>(
      {
        q: debounced,
        types: [BOM_TARGET_ITEM_TYPE],
        limit: SEARCH_FETCH_LIMIT,
        designScope: 'current',
        contextDesignId: scope.designId,
      },
      scope.active && searching && Boolean(scope.designId),
    ),
  )

  const librarySearch = useQuery(
    itemTextSearchQuery<TargetItem>(
      {
        q: debounced,
        types: [BOM_TARGET_ITEM_TYPE],
        limit: SEARCH_FETCH_LIMIT,
        designScope: 'library',
        contextDesignId: scope.designId,
      },
      scope.active && searching,
    ),
  )

  const typeSearch = useQuery(
    itemTextSearchQuery<TargetItem>(
      { q: debounced, types: [itemType], limit: SEARCH_FETCH_LIMIT },
      !scope.active && searching,
    ),
  )

  const candidates = useMemo(() => {
    const sources = scope.active
      ? searching
        ? [designSearch.data, librarySearch.data]
        : [designBrowse.data, libraryBrowse.data]
      : [searching ? typeSearch.data : typeBrowse.data]

    // A term too short to send still narrows what is on screen, so the list
    // reacts to the first keystroke instead of sitting still until the second.
    const narrow = !searching && debounced.length > 0
    const term = debounced.toLowerCase()

    // Deduped by id because a library assembly's own design *is* the library,
    // so both queries return the same rows
    const byId = new Map<string, TargetItem>()
    for (const item of sources.flatMap((rows) => rows ?? [])) {
      // An item is never its own BOM child — by masterId, so the copies it has
      // on other branches go too
      const isSelf = scope.sourceMasterId
        ? item.masterId === scope.sourceMasterId
        : item.id === itemId
      if (isSelf) continue
      if (
        narrow &&
        !item.itemNumber.toLowerCase().includes(term) &&
        !item.name.toLowerCase().includes(term)
      ) {
        continue
      }
      byId.set(item.id, item)
    }
    return [...byId.values()]
  }, [
    scope.active,
    scope.sourceMasterId,
    itemId,
    searching,
    debounced,
    designBrowse.data,
    libraryBrowse.data,
    typeBrowse.data,
    designSearch.data,
    librarySearch.data,
    typeSearch.data,
  ])

  // `isLoading` rather than `isPending`, so a query still held back by its
  // `enabled` guard doesn't read as one in flight
  const loading =
    (scope.active
      ? scope.loading ||
        (searching
          ? designSearch.isLoading || librarySearch.isLoading
          : designBrowse.isLoading || libraryBrowse.isLoading)
      : searching
        ? typeSearch.isLoading
        : typeBrowse.isLoading) ||
    // The settled term trailing the box is still work in progress from the
    // user's side, so the list reads as loading rather than as stale results
    search.trim() !== debounced

  return { scope, candidates, loading }
}

/** Explains why the target picker is showing these parts and no others. */
export function BomScopeNotice({ scope }: { scope: BomTargetScope }) {
  if (!scope.active) return null

  return (
    <div className="flex gap-3 p-3 bg-cyan-50 dark:bg-cyan-950/30 border border-cyan-200 dark:border-cyan-800 rounded-lg">
      <Info className="h-5 w-5 text-cyan-600 dark:text-cyan-400 flex-shrink-0 mt-0.5" />
      <div className="text-sm">
        <p className="font-medium text-cyan-900 dark:text-cyan-100">
          BOM lines stay within one design
        </p>
        <p className="text-cyan-700 dark:text-cyan-300 mt-0.5">
          {scope.noDesign ? (
            <>
              This item belongs to no design, so only Standard Library parts can
              be added.
            </>
          ) : (
            <>
              Only parts in{' '}
              <strong>{scope.designLabel ?? 'this item’s design'}</strong> and
              the Standard Library can be added. To reference a part from
              another design, use a different relationship type.
            </>
          )}
        </p>
      </div>
    </div>
  )
}
