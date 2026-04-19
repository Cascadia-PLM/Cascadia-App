import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { parts } from './items'
import { users } from './users'

export const cotsComponents = pgTable(
  'cots_components',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    manufacturer: text('manufacturer'),
    mpn: text('mpn'), // manufacturer part number
    description: text('description'),

    // Flexible specs storage for voltage, current, interfaces, etc.
    specs: jsonb('specs').$type<{
      voltage?: string
      current?: string
      interface?: string | Array<string>
      gpio_pins?: number
      protocol?: string
      [key: string]: any
    }>(),

    datasheet_url: text('datasheet_url'),
    image_url: text('image_url'),

    // Array of supplier links
    supplier_links: jsonb('supplier_links').$type<
      Array<{
        supplier: string
        sku: string
        url: string
        price?: number
        in_stock?: boolean
      }>
    >(),

    source: text('source').notNull(), // 'adafruit', 'sparkfun', 'manual', etc.
    tags: text('tags').array(), // ['microcontroller', 'wifi', 'esp32']

    import_date: timestamp('import_date', { withTimezone: true })
      .defaultNow()
      .notNull(),
    last_updated: timestamp('last_updated', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('cots_components_tags_idx').on(table.tags),
    index('cots_components_manufacturer_idx').on(table.manufacturer),
    index('cots_components_source_idx').on(table.source),
  ],
)

export const partCotsMapping = pgTable(
  'part_cots_mapping',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    part_id: uuid('part_id')
      .notNull()
      .references(() => parts.itemId, { onDelete: 'cascade' }),
    cots_component_id: uuid('cots_component_id')
      .notNull()
      .references(() => cotsComponents.id, { onDelete: 'cascade' }),
    is_preferred: boolean('is_preferred').default(false),
    notes: text('notes'),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    created_by: uuid('created_by').references(() => users.id),
  },
  (table) => [
    index('part_cots_mapping_part_idx').on(table.part_id),
    index('part_cots_mapping_cots_idx').on(table.cots_component_id),
  ],
)

export const cotsComponentsRelations = relations(
  cotsComponents,
  ({ many }) => ({
    partMappings: many(partCotsMapping),
  }),
)

export const partCotsMappingRelations = relations(
  partCotsMapping,
  ({ one }) => ({
    part: one(parts, {
      fields: [partCotsMapping.part_id],
      references: [parts.itemId],
    }),
    cotsComponent: one(cotsComponents, {
      fields: [partCotsMapping.cots_component_id],
      references: [cotsComponents.id],
    }),
    creator: one(users, {
      fields: [partCotsMapping.created_by],
      references: [users.id],
    }),
  }),
)
