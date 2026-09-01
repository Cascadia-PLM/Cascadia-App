// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { users } from './users'

/**
 * Approved Manufacturer List (AML).
 *
 * A manufacturer part is the sourcing definition of a purchasable component:
 * who makes it and under what part number. Suppliers (distributors) of that
 * manufacturer's part live as sub-rows in supplierLinks — Yamaha is a
 * manufacturer, Digi-Key is a supplier of Yamaha's part (AML vs AVL).
 *
 * See docs/features/physical-parts-and-traceability.md §4.2/§4.3.
 */

export interface SupplierLink {
  supplier: string
  sku?: string
  url?: string
  price?: number
  leadTimeDays?: number
}

export const manufacturerParts = pgTable(
  'manufacturer_parts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    manufacturer: text('manufacturer').notNull(),
    mpn: text('mpn').notNull(), // manufacturer part number
    description: text('description'),
    specs: jsonb('specs').$type<Record<string, unknown>>(),
    datasheetUrl: text('datasheet_url'),
    supplierLinks: jsonb('supplier_links').$type<Array<SupplierLink>>(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    modifiedAt: timestamp('modified_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    modifiedBy: uuid('modified_by').references(() => users.id),
  },
  (table) => [
    unique('uq_manufacturer_parts_mfr_mpn').on(table.manufacturer, table.mpn),
    index('idx_manufacturer_parts_manufacturer').on(table.manufacturer),
    index('idx_manufacturer_parts_mpn').on(table.mpn),
  ],
)

export const partManufacturerParts = pgTable(
  'part_manufacturer_parts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // items.masterId of the Part — deliberately NOT an FK to items.id: the AML
    // binds to the part lineage across revisions, not to one version row.
    partMasterId: uuid('part_master_id').notNull(),
    // FK named in the table extras below — see the note there.
    manufacturerPartId: uuid('manufacturer_part_id').notNull(),
    qualificationStatus: varchar('qualification_status', { length: 20 })
      .notNull()
      .default('proposed'), // 'proposed' | 'approved' | 'obsolete'
    isPreferred: boolean('is_preferred').notNull().default(false),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid('created_by').references(() => users.id),
  },
  (table) => [
    // Named explicitly: the implicit name is 69 bytes, past Postgres's 63.
    foreignKey({
      name: 'fk_part_mfr_parts_mfr_part',
      columns: [table.manufacturerPartId],
      foreignColumns: [manufacturerParts.id],
    }).onDelete('cascade'),
    unique('uq_part_manufacturer_parts').on(
      table.partMasterId,
      table.manufacturerPartId,
    ),
    index('idx_part_manufacturer_parts_part').on(table.partMasterId),
    index('idx_part_manufacturer_parts_mfr').on(table.manufacturerPartId),
  ],
)

export const manufacturerPartsRelations = relations(
  manufacturerParts,
  ({ many }) => ({
    partMappings: many(partManufacturerParts),
  }),
)

export const partManufacturerPartsRelations = relations(
  partManufacturerParts,
  ({ one }) => ({
    manufacturerPart: one(manufacturerParts, {
      fields: [partManufacturerParts.manufacturerPartId],
      references: [manufacturerParts.id],
    }),
    creator: one(users, {
      fields: [partManufacturerParts.createdBy],
      references: [users.id],
    }),
  }),
)
