// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Side-effect module: importing it puts every core event definition in the
 * `EventTypeRegistry` (definitions self-register via `defineDomainEvent`).
 * Imported by the events barrel, so any consumer of `@/lib/events` sees the
 * full core catalog. Module-owned definitions register from their
 * composition root instead — never from here.
 */
import './approvals'
import './branches'
import './change-orders'
import './checkouts'
import './files'
import './item-edits'
import './items'
import './lifecycles'
import './relationships'
import './work-orders'
import './hierarchy'

/*
 * ## What the catalog deliberately does not say
 *
 * Each of these was considered and left out. A consumer that reads a partial
 * stream as complete will be wrong, so the reasons live here rather than in
 * somebody's memory.
 *
 * **`physical_part.registered`** — the registration method delegates its write
 * to `ItemService.create`, which owns its own transaction and accepts none, so
 * the event would commit separately from the row it describes. That is the
 * first crack in the outbox contract everything else rests on. It is also
 * unnecessary: `item.created` already fires for every registration with the
 * physical-part type, and the traceability identity is one read away. Revisit
 * only if `ItemService.create` grows a transaction option the way `update` has.
 *
 * **`branch.deleted`** — nothing deletes a branch. Deleting a workspace
 * archives it through `archiveBranch`, so it is one `branch.archived` with the
 * owner as its actor, plus one `item.deleted` per draft it discards and one
 * `item.checkout_cancelled` per lock it releases.
 *
 * **`work_order.run_started`** — the start method has a resume path and a
 * race-winner path that both return an existing row, so "started" is not a fact
 * that site can state unambiguously without new bookkeeping. Carrying the start
 * time and duration on `work_order.run_completed` makes it self-sufficient for
 * cycle time regardless.
 *
 * **`work_order.run_abandoned`** — an incomplete record is telemetry nothing
 * acts on, and the work-order identity is not even in scope at that site.
 *
 * **Volume paths, and consistently.** The design-clone job mints thousands of
 * masters in one job; emitting per row would flood both the log and every
 * matching webhook subscription for something the jobs system already reports
 * as a single completion. MBOM generation has the same shape and gets the same
 * treatment. If a consumer ever needs either, the right shape is one
 * `design.cloned` summary — not ten thousand creations.
 */
