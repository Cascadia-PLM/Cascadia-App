/**
 * Component Catalog Categories
 *
 * Hierarchical category tree for organizing catalog entries.
 * Slugs are used as stable identifiers for bulk import.
 *
 * Only categories that the bundled test-data seed actually populates are
 * declared here. CatalogSeedService prunes any empty leaves after import,
 * so adding aspirational subcategories here without entries will just
 * silently drop them on seed.
 */

export interface CategoryDef {
  name: string
  slug: string
  children?: Array<CategoryDef>
}

export const CATEGORIES: Array<CategoryDef> = [
  {
    name: 'Fasteners',
    slug: 'fasteners',
    children: [{ name: 'Nuts', slug: 'nuts' }],
  },
  {
    name: 'Bearings',
    slug: 'bearings',
    children: [
      { name: 'Ball Bearings', slug: 'ball-bearings' },
      { name: 'Thrust Bearings', slug: 'thrust-bearings' },
    ],
  },
  {
    name: 'Linear Motion',
    slug: 'linear-motion',
    children: [
      { name: 'Linear Rails', slug: 'linear-rails' },
      { name: 'Linear Rods', slug: 'linear-rods' },
      { name: 'Lead Screws', slug: 'lead-screws' },
      { name: 'Linear Bearings', slug: 'linear-bearings' },
    ],
  },
  { name: 'Motors', slug: 'motors' },
  { name: 'Motor Drivers', slug: 'motor-drivers' },
  { name: 'Microcontrollers', slug: 'microcontrollers' },
  { name: 'Sensors', slug: 'sensors' },
  { name: 'Power', slug: 'power' },
  { name: 'Connectors', slug: 'connectors' },
  { name: 'Wire & Cable', slug: 'wire-cable' },
  { name: 'Displays', slug: 'displays' },
  { name: 'Relays & Switching', slug: 'relays-switching' },
  { name: 'Passive Components', slug: 'passive-components' },
  { name: 'Discrete Semiconductors', slug: 'discrete-semiconductors' },
  { name: 'LEDs', slug: 'leds' },
  { name: 'Protection Components', slug: 'protection-components' },
  { name: 'DIN Rail', slug: 'din-rail' },
  {
    name: 'Gears & Transmission',
    slug: 'gears-transmission',
    children: [{ name: 'Shaft Couplings', slug: 'shaft-couplings' }],
  },
  { name: 'T-Slot Extrusion', slug: 't-slot-extrusion' },
  { name: 'T-Slot Hardware', slug: 't-slot-hardware' },
  { name: 'Aluminum Profiles', slug: 'aluminum-profiles' },
  { name: 'Steel Profiles', slug: 'steel-profiles' },
  { name: 'Sheet Stock', slug: 'sheet-stock' },
  { name: 'Plastic Sheet', slug: 'plastic-sheet' },
  { name: 'Threaded Rod', slug: 'threaded-rod' },
  { name: 'Tubing', slug: 'tubing' },
  { name: 'Adhesives & Sealants', slug: 'adhesives' },
  { name: 'Plywood & MDF', slug: 'plywood-mdf' },
  { name: 'Enclosures', slug: 'enclosures' },
  { name: 'Misc Hardware', slug: 'misc-hardware' },
]
