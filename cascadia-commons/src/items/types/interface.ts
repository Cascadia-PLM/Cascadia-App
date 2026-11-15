// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { z } from 'zod'
import { baseItemSchema } from './base'
import type { BaseItem } from './base'

/**
 * What flows across an interface. A label for the reader: it colours the
 * line in the block diagram and nothing else depends on it.
 */
export const interfaceKindSchema = z.enum([
  'power',
  'data',
  'mechanical',
  'fluid',
  'thermal',
  'other',
])
export type InterfaceKind = z.infer<typeof interfaceKindSchema>

export const INTERFACE_KINDS: ReadonlyArray<InterfaceKind> =
  interfaceKindSchema.options

export const INTERFACE_KIND_LABELS: Record<InterfaceKind, string> = {
  power: 'Power',
  data: 'Data',
  mechanical: 'Mechanical',
  fluid: 'Fluid',
  thermal: 'Thermal',
  other: 'Other',
}

/**
 * An interface between system elements — the 28 V bus, a CAN network, a
 * coolant loop — as an item in its own right.
 *
 * It is an item rather than a link so that it can be what an interface is
 * in practice: numbered, revised through a change order of its own, the
 * home of its interface control document and of the requirements allocated
 * to it. It also means two interfaces between the same two elements are two
 * items, and that one interface can join more than two elements (a bus).
 *
 * What it joins is the `CONNECTS` edge (interface → element), one per
 * element, naming the port it attaches to in the edge's metadata. The edges
 * are the interface's own content: they ride its checkout and its release.
 */
export interface InterfaceItem extends BaseItem {
  itemType: 'Interface'
  /** Required: an interface belongs to a design, which versions it. */
  designId: string
  interfaceKind?: InterfaceKind
  description?: string
}

export const interfaceItemSchema = baseItemSchema.extend({
  itemType: z.literal('Interface'),
  designId: z.string().uuid({ message: 'Design is required' }),
  interfaceKind: interfaceKindSchema.optional(),
  description: z.string().max(5000).optional(),
})

/** The key under which a `CONNECTS` edge's metadata names its port. */
export const CONNECTS_PORT_KEY = 'portId'

// The cataloged edge an interface is the source of; the catalog
// (`relationships/catalog.ts`) fixes its ends.
export const interfaceRelationships = [
  {
    type: 'CONNECTS',
    label: 'Connects',
    targetTypes: ['SystemElement'],
    allowMultiple: true,
  },
]

export type InterfaceItemInput = z.infer<typeof interfaceItemSchema>
