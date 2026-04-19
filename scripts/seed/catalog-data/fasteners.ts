/**
 * Fasteners Catalog Entries
 *
 * Socket head cap screws, button head, nuts, washers, etc.
 * All metric, M2-M8 in standard lengths.
 */

import type { CatalogEntryDef } from '../types'

// Helper to generate SHCS entries for a given size
function shcsEntries(
  size: number,
  headDia: number,
  socketSize: number,
  lengths: Array<number>,
): Array<CatalogEntryDef> {
  return lengths.map((len) => ({
    name: `M${size}x${len} Socket Head Cap Screw, Alloy Steel`,
    description: `M${size}x${0.8 * (size <= 3 ? 0.5 : size <= 5 ? 0.8 : 1)} pitch, ${len}mm length, alloy steel black oxide, ${headDia}mm head diameter, ${socketSize}mm hex socket`,
    categorySlug: 'bolts',
    entryType: 'component' as const,
    dimensions: {
      diameter: size,
      height: len,
      weight: Math.round(size * len * 0.06),
    },
    mountingFeatures: [
      {
        type: 'bolt_hole',
        specs: { boltSize: size, headDiameter: headDia, socketSize },
      },
    ],
    specs: {
      thread: `M${size}`,
      length: `${len}mm`,
      material: 'Alloy Steel',
      finish: 'Black Oxide',
      headType: 'Socket Head Cap',
      driveType: 'Hex Socket',
      standard: 'DIN 912 / ISO 4762',
    },
    suppliers: [
      {
        name: 'McMaster-Carr',
        approximatePrice: 0.1 + size * 0.03 + len * 0.005,
      },
      {
        name: 'Amazon',
        approximatePrice: (0.1 + size * 0.03 + len * 0.005) * 0.8,
      },
    ],
    designNotes: `Standard socket head cap screw. Use M${size} hex key (${socketSize}mm). Recommended hole: ${size + 0.2}mm clearance, ${size}mm tap drill for threaded.`,
    tags: [
      'metric',
      `M${size}`,
      'socket-head',
      'cap-screw',
      'shcs',
      'alloy-steel',
      'DIN-912',
    ],
  }))
}

export const FASTENERS: Array<CatalogEntryDef> = [
  // ---- M3 Socket Head Cap Screws ----
  ...shcsEntries(3, 5.5, 2.5, [6, 8, 10, 12, 16, 20, 25, 30]),

  // ---- M4 Socket Head Cap Screws ----
  ...shcsEntries(4, 7, 3, [8, 10, 12, 16, 20, 25, 30, 35, 40]),

  // ---- M5 Socket Head Cap Screws ----
  ...shcsEntries(5, 8.5, 4, [8, 10, 12, 16, 20, 25, 30, 35, 40, 50]),

  // ---- M3 Button Head Screws ----
  ...[6, 8, 10, 12, 16, 20].map((len) => ({
    name: `M3x${len} Button Head Screw, Stainless Steel`,
    description: `M3x0.5 pitch, ${len}mm length, A2 stainless steel, 5.7mm button head, 2mm hex socket, low-profile`,
    categorySlug: 'bolts',
    entryType: 'component' as const,
    dimensions: {
      diameter: 3,
      height: len,
      weight: Math.round(3 * len * 0.04),
    },
    mountingFeatures: [
      {
        type: 'bolt_hole',
        specs: { boltSize: 3, headDiameter: 5.7, socketSize: 2 },
      },
    ],
    specs: {
      thread: 'M3',
      length: `${len}mm`,
      material: 'A2 Stainless Steel',
      headType: 'Button Head',
      driveType: 'Hex Socket',
      standard: 'ISO 7380',
    },
    suppliers: [
      { name: 'McMaster-Carr', approximatePrice: 0.12 + len * 0.005 },
    ],
    designNotes:
      'Low-profile alternative to socket head cap screws. Good for exposed fastener locations.',
    tags: [
      'metric',
      'M3',
      'button-head',
      'stainless',
      'low-profile',
      'ISO-7380',
    ],
  })),

  // ---- Hex Nuts ----
  ...[3, 4, 5, 6, 8].map((size) => ({
    name: `M${size} Hex Nut, Stainless Steel`,
    description: `M${size} hex nut, A2 stainless steel, DIN 934 standard`,
    categorySlug: 'nuts',
    entryType: 'component' as const,
    dimensions: { diameter: size * 2, height: size * 0.8 },
    mountingFeatures: [{ type: 'threaded_hole', specs: { boltSize: size } }],
    specs: {
      thread: `M${size}`,
      material: 'A2 Stainless Steel',
      standard: 'DIN 934',
    },
    suppliers: [
      { name: 'McMaster-Carr', approximatePrice: 0.05 + size * 0.01 },
    ],
    designNotes: `Standard hex nut for M${size} bolts/screws. Use with flat washer for best clamping.`,
    tags: ['metric', `M${size}`, 'hex-nut', 'stainless', 'DIN-934'],
  })),

  // ---- Nyloc Nuts ----
  ...[3, 4, 5].map((size) => ({
    name: `M${size} Nyloc Nut, Stainless Steel`,
    description: `M${size} nylon insert lock nut, A2 stainless steel, vibration resistant, DIN 985`,
    categorySlug: 'nuts',
    entryType: 'component' as const,
    dimensions: { diameter: size * 2, height: size * 1.1 },
    mountingFeatures: [{ type: 'threaded_hole', specs: { boltSize: size } }],
    specs: {
      thread: `M${size}`,
      material: 'A2 Stainless Steel',
      lockingType: 'Nylon Insert',
      standard: 'DIN 985',
    },
    suppliers: [
      { name: 'McMaster-Carr', approximatePrice: 0.08 + size * 0.02 },
    ],
    designNotes: `Self-locking nut for M${size}. Single-use — replace after removal. Not for high-temperature applications (nylon softens above 120C).`,
    tags: ['metric', `M${size}`, 'nyloc', 'lock-nut', 'stainless', 'DIN-985'],
  })),

  // ---- Flat Washers ----
  ...[3, 4, 5, 6, 8].map((size) => ({
    name: `M${size} Flat Washer, Stainless Steel`,
    description: `M${size} flat washer, A2 stainless steel, ${size * 2 + 1}mm OD, DIN 125`,
    categorySlug: 'washers',
    entryType: 'component' as const,
    dimensions: { diameter: size * 2 + 1, height: size < 5 ? 0.5 : 1 },
    mountingFeatures: [
      {
        type: 'washer',
        specs: { boltSize: size, outerDiameter: size * 2 + 1 },
      },
    ],
    specs: {
      innerDiameter: `${size + 0.2}mm`,
      outerDiameter: `${size * 2 + 1}mm`,
      material: 'A2 Stainless Steel',
      standard: 'DIN 125',
    },
    suppliers: [
      { name: 'McMaster-Carr', approximatePrice: 0.03 + size * 0.005 },
    ],
    tags: ['metric', `M${size}`, 'flat-washer', 'stainless', 'DIN-125'],
  })),

  // ---- Heat-Set Inserts ----
  ...[3, 4, 5].map((size) => ({
    name: `M${size} Heat-Set Insert for Plastic`,
    description: `M${size} brass heat-set threaded insert for 3D printed parts, knurled OD for grip, ${size + 1.5}mm OD, ${size * 2}mm length`,
    categorySlug: 'threaded-inserts',
    entryType: 'component' as const,
    dimensions: { diameter: size + 1.5, height: size * 2 },
    mountingFeatures: [
      {
        type: 'threaded_hole',
        specs: { boltSize: size, outerDiameter: size + 1.5 },
      },
    ],
    specs: {
      thread: `M${size}`,
      material: 'Brass',
      installMethod: 'Soldering iron / heat press',
      recommendedHoleDiameter: `${size + 1.2}mm`,
    },
    suppliers: [
      { name: 'Amazon', approximatePrice: 0.08 + size * 0.02 },
      { name: 'McMaster-Carr', approximatePrice: 0.15 + size * 0.03 },
    ],
    designNotes: `Install with soldering iron at 220-260C. Designed for PLA/PETG/ABS. Hole should be ${size + 1.2}mm diameter, ${size * 2 + 1}mm deep. Pair with M${size} socket head cap screws.`,
    tags: ['metric', `M${size}`, 'heat-set', 'insert', 'brass', '3d-printing'],
  })),

  // ---- Hex Standoffs ----
  ...[
    { size: 3, lengths: [6, 10, 15, 20, 25] },
    { size: 2.5, lengths: [5, 8, 10, 12, 15] },
  ].flatMap(({ size, lengths }) =>
    lengths.map((len) => ({
      name: `M${size}x${len}mm Hex Standoff, Male-Female, Brass`,
      description: `M${size} hex standoff, ${len}mm body length, male-female, brass nickel-plated, 5mm hex`,
      categorySlug: 'standoffs-spacers',
      entryType: 'component' as const,
      dimensions: { diameter: 5, height: len },
      mountingFeatures: [
        { type: 'threaded_stud', specs: { boltSize: size, studLength: size } },
        { type: 'threaded_hole', specs: { boltSize: size } },
      ],
      specs: {
        thread: `M${size}`,
        bodyLength: `${len}mm`,
        material: 'Brass, Nickel Plated',
        configuration: 'Male-Female',
        hexSize: '5mm',
      },
      suppliers: [{ name: 'Amazon', approximatePrice: 0.15 + len * 0.01 }],
      designNotes: `For PCB mounting. Male side goes through the PCB hole, female side accepts the screw. Stack multiple for taller spacing.`,
      tags: [
        'metric',
        `M${size}`,
        'standoff',
        'brass',
        'pcb-mounting',
        'male-female',
      ],
    })),
  ),
]
