// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { baseItemSchema } from './base'
import type { BaseItem, RelationshipConfig, StateConfig } from './base'

/**
 * PhysicalPart — a physical instance of a Part: a serialized unit or an
 * identified lot/batch. Non-versioned (no designId, Free lifecycle, Tool
 * pattern); the digital-twin record that accumulates documents (material
 * certs, test reports) in the vault and participates in Consumes/Produces
 * traceability edges.
 *
 * See docs/proposals/physical-parts-and-traceability.md.
 */

export type PhysicalPartInstanceKind = 'unit' | 'lot'

export interface PhysicalPart extends BaseItem {
  itemType: 'PhysicalPart'
  /** 'unit' (serialNumber) or 'lot' (lotNumber) */
  instanceKind: PhysicalPartInstanceKind
  /** items.masterId of the Part this instantiates */
  partMasterId: string
  serialNumber?: string
  lotNumber?: string
  /** Which approved source (manufacturer part) this physically is, if known */
  manufacturerPartId?: string
  /** Exact part version row (items.id) this unit was built as — set at production */
  asBuiltItemId?: string
  /** The work order that produced this instance */
  producingWorkOrderId?: string
  /** Handle for future ERP reconciliation */
  erpRef?: string
  notes?: string
}

export const physicalPartSchema = baseItemSchema
  .extend({
    itemType: z.literal('PhysicalPart'),
    instanceKind: z.enum(['unit', 'lot']),
    partMasterId: z.string().uuid({ message: 'Part is required' }),
    serialNumber: z.string().max(200).optional(),
    lotNumber: z.string().max(200).optional(),
    manufacturerPartId: z.string().uuid().optional(),
    asBuiltItemId: z.string().uuid().optional(),
    producingWorkOrderId: z.string().uuid().optional(),
    erpRef: z.string().max(200).optional(),
    notes: z.string().max(5000).optional(),
  })
  .refine(
    (v) =>
      v.instanceKind === 'unit'
        ? !!v.serialNumber && !v.lotNumber
        : !!v.lotNumber && !v.serialNumber,
    {
      message:
        'Units carry exactly a serialNumber; lots carry exactly a lotNumber',
    },
  )

export const physicalPartStates: Array<StateConfig> = [
  { id: 'Available', name: 'Available', color: 'green' },
  { id: 'Consumed', name: 'Consumed', color: 'blue' },
  { id: 'In Service', name: 'In Service', color: 'purple' },
  { id: 'Scrapped', name: 'Scrapped', color: 'red' },
]

// Consumes/Produces/Evidences edges are created by services (work order
// consumption, production, qualification evidence), not through the generic
// relationship picker — so no user-facing relationship configs here.
export const physicalPartRelationships: Array<RelationshipConfig> = []

export type PhysicalPartInput = z.infer<typeof physicalPartSchema>
