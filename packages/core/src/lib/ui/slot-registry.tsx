// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Fragment } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { Part } from '@/lib/items/types/part'

/**
 * Named places in core's UI where a module may render something.
 *
 * **Core owns this contract.** An extension point is a deliberate design
 * decision about where the UI can be extended and what data is available
 * there — not something a module invents by widening a type. So the names and
 * their props are declared here, and modules supply components that satisfy
 * them. That direction also keeps the props honest: core can only offer what it
 * actually has in scope at the render site.
 *
 * A slot with nothing registered renders nothing, which is what lets core's
 * components run unchanged with every optional package absent.
 *
 * This is for **presentational** extension. When a module also needs to feed
 * state back — gate a submit button, add fields to a request — use a purpose-
 * built registry instead; `approval-form-registry.tsx` is the worked example.
 */
export interface SlotProps {
  /**
   * Below the approval list on a change order. Receives the workflow instance
   * rather than a signing-specific scope, because core does not know what a
   * chain scope is — the module derives whatever it needs.
   */
  'change-order-approval-manifest': { instanceId: string }
  /**
   * Extra sections at the foot of the admin AI settings page. Takes no props:
   * a module contributing here brings its own heading and copy, because core
   * has no basis for describing a feature it does not ship.
   */
  'admin-ai-settings-sections': Record<string, never>
  /**
   * Extra entries in the sidebar's Designs section, below My Workspaces.
   *
   * A module that contributes whole routes has to contribute the way in as
   * well: core cannot link to a route it does not have, and a `NavSubItem`
   * whose `to` matches nothing falls through to `/designs/$id` and asks the
   * API for a design named after the path segment. Contributions render
   * `NavSubItem` themselves — the sidebar's own children are the shape to
   * follow — and are passed the click handler that closes the sidebar on
   * mobile.
   */
  'designs-nav-items': { onNavClick: () => void }
  /**
   * Extra actions in the part detail header, alongside Edit and Delete.
   * Rendered only when viewing an existing part, never while creating one.
   * A contribution owns its own trigger, state, and any dialog it opens.
   */
  'part-detail-actions': { part: Part }
  /**
   * Per-row actions in a file list, left of the built-in preview and download
   * buttons. Declared structurally rather than as the `FileRecord` the list
   * uses, so this module does not have to import a component to describe its
   * own contract — and so the offer stays limited to what a contribution
   * plausibly needs.
   */
  'file-row-actions': {
    file: {
      id: string
      originalFileName: string
      isLatestVersion: boolean
    }
  }
}

export type SlotName = keyof SlotProps

/**
 * Heterogeneous by nature: one map holds components for every slot, each with
 * different props. The `any` is contained to this line and re-narrowed by the
 * generic signatures of `registerSlot` and `Slot`, which are what callers
 * actually touch — neither can be called with mismatched props.
 */
type AnySlotComponent = ComponentType<any>

const registry = new Map<SlotName, Array<AnySlotComponent>>()

/**
 * Contribute a component to a slot. Called from a composition root.
 *
 * Deliberately additive, unlike the name-keyed registries (`JobTypeRegistry`,
 * `ApprovalRegistry`, `ReleaseHookRegistry`, `registerPackage`) which throw on
 * a duplicate. A slot is a *list* of contributions rendered in registration
 * order — several modules decorating one extension point is the contract, not
 * a collision, so there is nothing here that could conflict.
 */
export function registerSlot<TName extends SlotName>(
  name: TName,
  component: ComponentType<SlotProps[TName]>,
): void {
  const existing = registry.get(name)
  if (existing) {
    existing.push(component)
  } else {
    registry.set(name, [component])
  }
}

/** Names with at least one contribution, for debugging and tests. */
export function registeredSlots(): Array<SlotName> {
  return [...registry.keys()]
}

/** Drop every contribution. Tests only. */
export function clearSlots(): void {
  registry.clear()
}

/**
 * Render whatever is registered for `name`, or nothing.
 *
 * Contributions render as real components, not called as functions, so each one
 * gets its own hook scope and may use `useQuery` and friends freely.
 */
export function Slot<TName extends SlotName>({
  name,
  props,
}: {
  name: TName
  props: SlotProps[TName]
}): ReactNode {
  const components = registry.get(name)
  if (!components || components.length === 0) return null

  return components.map((Component, index) => (
    <Fragment key={index}>
      <Component {...props} />
    </Fragment>
  ))
}
