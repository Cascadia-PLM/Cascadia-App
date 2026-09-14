// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq } from 'drizzle-orm'
import type { ExtensionPhase } from './types'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { eventLogger } from '@/lib/logging/logger'

/**
 * Which extensions are switched off, as data.
 *
 * This is the data half of the line the whole design rests on: **code decides
 * what runs; data decides whether, where and with what parameters.** Handler
 * bodies are TypeScript in a compiled package — never source in a database row
 * — and enablement is a row, so an operator can switch a misbehaving extension
 * off without a rebuild and a redeploy.
 *
 * It rides the existing `settings` table under one key rather than earning a
 * table of its own, which is what keeps this stage free of DDL and stage 6 a
 * legitimate publish point. One row, one read, cached.
 */
export const EXTENSIONS_DISABLED_SETTING_KEY = 'extensions.disabled'

/** How long a loaded disabled-set is trusted before it is read again. */
const CACHE_TTL_MS = 5_000

interface Cache {
  disabled: ReadonlySet<string>
  loadedAt: number
}

let cache: Cache | null = null
let loadsFromDatabase = 0
let inFlight: Promise<ReadonlySet<string>> | null = null

/**
 * Where the disabled set is read from.
 *
 * An object rather than a bare function, so a test can make the read fail with
 * `vi.spyOn(enablementSource, 'read')`. Patching the database handle cannot do
 * that: `db` is a proxy, and a property written onto it never reaches the calls
 * made through it — a test that tried passed whether or not failing open worked.
 */
export const enablementSource = {
  async read(): Promise<unknown> {
    const row = (
      await db
        .select({ jsonValue: settings.jsonValue })
        .from(settings)
        .where(eq(settings.key, EXTENSIONS_DISABLED_SETTING_KEY))
        .limit(1)
    ).at(0)
    return row?.jsonValue
  },
}

function parse(jsonValue: unknown): ReadonlySet<string> {
  // Two accepted shapes so an operator editing the row by hand cannot get it
  // subtly wrong: a bare array, or `{ ids: [...] }`.
  const ids = Array.isArray(jsonValue)
    ? jsonValue
    : typeof jsonValue === 'object' &&
        jsonValue !== null &&
        Array.isArray((jsonValue as { ids?: unknown }).ids)
      ? (jsonValue as { ids: Array<unknown> }).ids
      : []
  return new Set(ids.filter((id): id is string => typeof id === 'string'))
}

async function load(): Promise<ReadonlySet<string>> {
  try {
    const jsonValue = await enablementSource.read()
    loadsFromDatabase += 1
    const disabled = parse(jsonValue)
    cache = { disabled, loadedAt: Date.now() }
    return disabled
  } catch (error) {
    // **Fail open, deliberately and loudly.** A configuration lookup must
    // never be able to stop a write: without this, a database hiccup on this
    // one row would make every `guard` and every `in-transaction` extension
    // undecidable, and the safe-looking choice — refuse — would brick item
    // creation and every write an extension joins. Failing open means a
    // disabled extension may run for up to one cache window during an
    // outage, which is the lesser fault by a wide margin.
    //
    // The stale cache is preferred over an empty set when there is one: it is
    // the last answer known to be true.
    eventLogger.warn(
      { err: error, key: EXTENSIONS_DISABLED_SETTING_KEY },
      'Extension enablement lookup failed; failing open',
    )
    return cache?.disabled ?? new Set<string>()
  }
}

/**
 * The disabled set, from cache when it is fresh.
 *
 * Concurrent callers share one in-flight read: a burst of dispatches on a cold
 * cache must not become a burst of identical queries.
 */
export async function disabledExtensionIds(): Promise<ReadonlySet<string>> {
  const now = Date.now()
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.disabled
  inFlight ??= load().finally(() => {
    inFlight = null
  })
  return inFlight
}

/**
 * Whether an extension runs, combining its own declaration with the row.
 *
 * The extension's own answer is taken first and costs no query — that is how a
 * module package says "not licensed here" without an operator having to switch
 * anything off. It may be a static boolean or a predicate; see
 * `ExtensionCommon.enabled` for when each is right.
 *
 * **A predicate that throws is answered by phase.** A `consumed` extension
 * runs: its handler then fails as well and records the failure on its cursor
 * row, which is the visible outcome — sitting out would be a consumer that
 * silently stops for a reason nothing reports. A `guard` or `in-transaction`
 * extension does not run. Those act inside a user's write — a guard can refuse
 * it, an in-transaction handler joins its transaction — and a predicate that
 * cannot say whether the extension belongs here (its licence check threw, say)
 * is no warrant for either. Skipping it lets the write proceed as if the
 * extension were not registered, which is what an unlicensed module's is.
 *
 * The row lookup is answered differently, on purpose. The row says nothing
 * about whether an extension belongs on this instance, only whether an operator
 * switched it off, so a database hiccup there fails open in every phase — see
 * `load`.
 */
export async function isExtensionEnabled(extension: {
  id: string
  phase?: ExtensionPhase
  enabled?: boolean | (() => boolean | Promise<boolean>)
}): Promise<boolean> {
  if (extension.enabled === false) return false
  if (typeof extension.enabled === 'function') {
    try {
      if (!(await extension.enabled())) return false
    } catch (error) {
      const insideAWrite =
        extension.phase === 'guard' || extension.phase === 'in-transaction'
      eventLogger.warn(
        { err: error, extensionId: extension.id, phase: extension.phase },
        insideAWrite
          ? 'Extension enablement predicate threw; not running it inside a write'
          : 'Extension enablement predicate threw; treating it as enabled',
      )
      if (insideAWrite) return false
    }
  }
  const disabled = await disabledExtensionIds()
  return !disabled.has(extension.id)
}

/**
 * How many times the disabled-set has actually been read from the database.
 *
 * Exported because the promise that zero registrations cost zero queries, and
 * that N dispatches do not cost N queries, is worth a test rather than a
 * docstring — the per-dispatch enablement lookup is the obvious way to break
 * it.
 */
export function extensionEnablementLoadCount(): number {
  return loadsFromDatabase
}

/**
 * Forget the cached set, so the next check reads the row again. Tests use it;
 * otherwise a change to the row takes effect within one cache window.
 */
export function resetExtensionEnablementCache(): void {
  cache = null
  inFlight = null
  loadsFromDatabase = 0
}
