/**
 * Raw Stock Materials Catalog Entries
 *
 * T-slot extrusion, sheet stock, rod stock, etc.
 * These are raw_stock entries with stockSizes arrays.
 */

import type { CatalogEntryDef } from '../types'

export const RAW_STOCK: Array<CatalogEntryDef> = [
  // ---- T-Slot Extrusion ----
  {
    name: '2020 Aluminum T-Slot Extrusion',
    description:
      '2020 T-slot aluminum extrusion profile, 20x20mm cross-section, 6063-T5 aluminum, 5mm center slot, compatible with M5 T-nuts and drop-in nuts',
    categorySlug: 't-slot-extrusion',
    entryType: 'raw_stock',
    dimensions: { width: 20, height: 20 },
    mountingFeatures: [
      { type: 't_slot', specs: { slotWidth: 6, slotDepth: 6, boltSize: 5 } },
    ],
    specs: {
      profile: '2020',
      material: '6063-T5 Aluminum',
      crossSection: '20x20mm',
      slotCount: '1 per face (4 total)',
      centerBore: '5mm',
    },
    stockSizes: [
      { label: '100mm', dimensions: { length: 100 }, approximatePrice: 2.5 },
      { label: '200mm', dimensions: { length: 200 }, approximatePrice: 3.5 },
      { label: '250mm', dimensions: { length: 250 }, approximatePrice: 4.0 },
      { label: '300mm', dimensions: { length: 300 }, approximatePrice: 4.5 },
      { label: '400mm', dimensions: { length: 400 }, approximatePrice: 5.5 },
      { label: '500mm', dimensions: { length: 500 }, approximatePrice: 6.5 },
      { label: '600mm', dimensions: { length: 600 }, approximatePrice: 8.0 },
      { label: '800mm', dimensions: { length: 800 }, approximatePrice: 10.0 },
      { label: '1000mm', dimensions: { length: 1000 }, approximatePrice: 12.0 },
      { label: '1200mm', dimensions: { length: 1200 }, approximatePrice: 15.0 },
      { label: '1500mm', dimensions: { length: 1500 }, approximatePrice: 18.0 },
    ],
    suppliers: [
      { name: 'Amazon', approximatePrice: 6.5 },
      { name: 'Misumi', approximatePrice: 5.0 },
    ],
    designNotes:
      'Most common profile for 3D printer frames, CNC enclosures, and small machine frames. Use with M5 T-nuts and M5x8 button head screws. Cut with miter saw or hacksaw. Pair with 2020 L-brackets for 90-degree joints.',
    tags: [
      '2020',
      't-slot',
      'aluminum',
      'extrusion',
      'v-slot',
      'frame',
      '20x20',
    ],
  },
  {
    name: '2040 Aluminum T-Slot Extrusion',
    description:
      '2040 T-slot aluminum extrusion profile, 20x40mm cross-section, 6063-T5 aluminum, double-width for increased rigidity',
    categorySlug: 't-slot-extrusion',
    entryType: 'raw_stock',
    dimensions: { width: 20, height: 40 },
    mountingFeatures: [
      { type: 't_slot', specs: { slotWidth: 6, slotDepth: 6, boltSize: 5 } },
    ],
    specs: {
      profile: '2040',
      material: '6063-T5 Aluminum',
      crossSection: '20x40mm',
    },
    stockSizes: [
      { label: '200mm', dimensions: { length: 200 }, approximatePrice: 5.0 },
      { label: '300mm', dimensions: { length: 300 }, approximatePrice: 6.5 },
      { label: '400mm', dimensions: { length: 400 }, approximatePrice: 8.0 },
      { label: '500mm', dimensions: { length: 500 }, approximatePrice: 10.0 },
      { label: '600mm', dimensions: { length: 600 }, approximatePrice: 12.0 },
      { label: '800mm', dimensions: { length: 800 }, approximatePrice: 16.0 },
      { label: '1000mm', dimensions: { length: 1000 }, approximatePrice: 20.0 },
    ],
    suppliers: [{ name: 'Amazon', approximatePrice: 10.0 }],
    designNotes:
      'Use for Y-axis or base rails where additional rigidity is needed. Compatible with all 2020 hardware. Stiffer than 2020 in the 40mm direction.',
    tags: ['2040', 't-slot', 'aluminum', 'extrusion', 'frame', '20x40'],
  },
  {
    name: '3030 Aluminum T-Slot Extrusion',
    description:
      '3030 T-slot aluminum extrusion profile, 30x30mm cross-section, 6063-T5 aluminum, M6 slot, higher load capacity than 2020',
    categorySlug: 't-slot-extrusion',
    entryType: 'raw_stock',
    dimensions: { width: 30, height: 30 },
    mountingFeatures: [
      { type: 't_slot', specs: { slotWidth: 8, slotDepth: 8, boltSize: 6 } },
    ],
    specs: {
      profile: '3030',
      material: '6063-T5 Aluminum',
      crossSection: '30x30mm',
    },
    stockSizes: [
      { label: '300mm', dimensions: { length: 300 }, approximatePrice: 7.0 },
      { label: '500mm', dimensions: { length: 500 }, approximatePrice: 10.0 },
      { label: '600mm', dimensions: { length: 600 }, approximatePrice: 12.0 },
      { label: '1000mm', dimensions: { length: 1000 }, approximatePrice: 18.0 },
    ],
    suppliers: [{ name: 'Misumi', approximatePrice: 10.0 }],
    designNotes:
      'Use M6 T-nuts and M6 bolts. For medium-duty frames and workbenches. Not compatible with 2020 hardware.',
    tags: ['3030', 't-slot', 'aluminum', 'extrusion', 'frame', '30x30'],
  },

  // ---- T-Slot Hardware ----
  {
    name: '2020 Corner Bracket, L-Shape',
    description:
      '2020 L-shape corner bracket, die-cast zinc alloy, 20x20mm, for 90-degree joints in 2020 T-slot extrusion frames',
    categorySlug: 't-slot-hardware',
    entryType: 'component',
    dimensions: { width: 20, height: 20, depth: 20 },
    mountingFeatures: [
      {
        type: 't_slot_bracket',
        specs: { profileSize: 20, boltSize: 5, boltCount: 2 },
      },
    ],
    specs: {
      material: 'Zinc Alloy',
      compatibleProfile: '2020',
      jointAngle: '90 degrees',
    },
    suppliers: [{ name: 'Amazon', approximatePrice: 0.8 }],
    designNotes:
      'Use with M5x8 button head screws and M5 T-nuts. Two per joint for rigidity. Available in packs of 10-50.',
    tags: ['2020', 'corner-bracket', 'l-bracket', 't-slot', 'zinc'],
  },
  {
    name: 'M5 Drop-In T-Nut for 2020',
    description:
      'M5 drop-in T-nut for 2020 aluminum extrusion, spring-loaded ball for retention, carbon steel zinc-plated',
    categorySlug: 't-slot-hardware',
    entryType: 'component',
    dimensions: { width: 10, height: 6, depth: 10 },
    mountingFeatures: [{ type: 't_nut', specs: { boltSize: 5, slotWidth: 6 } }],
    specs: {
      thread: 'M5',
      material: 'Carbon Steel, Zinc Plated',
      style: 'Drop-In with Spring Ball',
      compatibleProfile: '2020',
    },
    suppliers: [{ name: 'Amazon', approximatePrice: 0.15 }],
    designNotes:
      'Can be inserted anywhere along the slot without sliding from the end. Spring ball holds position before tightening. Use with M5 screws.',
    tags: ['M5', 't-nut', 'drop-in', '2020', 'spring-ball'],
  },

  // ---- Aluminum Sheet ----
  {
    name: 'Aluminum Sheet 6061-T6, 1.5mm Thick',
    description:
      'Aluminum sheet 6061-T6, 1.5mm (1/16") thickness, good machinability, weldable, corrosion resistant',
    categorySlug: 'sheet-stock',
    entryType: 'raw_stock',
    dimensions: { depth: 1.5 },
    specs: {
      material: '6061-T6 Aluminum',
      thickness: '1.5mm',
      temper: 'T6',
    },
    stockSizes: [
      {
        label: '6"x6"',
        dimensions: { width: 152, height: 152 },
        approximatePrice: 5.0,
      },
      {
        label: '12"x12"',
        dimensions: { width: 305, height: 305 },
        approximatePrice: 10.0,
      },
      {
        label: '12"x24"',
        dimensions: { width: 305, height: 610 },
        approximatePrice: 18.0,
      },
      {
        label: '24"x24"',
        dimensions: { width: 610, height: 610 },
        approximatePrice: 32.0,
      },
    ],
    suppliers: [
      { name: 'Amazon', approximatePrice: 10.0 },
      { name: 'McMaster-Carr', approximatePrice: 12.0 },
    ],
    designNotes:
      'Easy to cut with snips, bandsaw, or waterjet. Can be bent with a brake. Good for panels, brackets, and mounting plates. Drill with standard HSS bits.',
    tags: ['aluminum', 'sheet', '6061', 'T6', '1.5mm', 'panel'],
  },
  {
    name: 'Aluminum Sheet 6061-T6, 3mm Thick',
    description:
      'Aluminum sheet 6061-T6, 3mm (1/8") thickness, structural grade, suitable for CNC machining and laser cutting',
    categorySlug: 'sheet-stock',
    entryType: 'raw_stock',
    dimensions: { depth: 3 },
    specs: {
      material: '6061-T6 Aluminum',
      thickness: '3mm',
      temper: 'T6',
    },
    stockSizes: [
      {
        label: '6"x6"',
        dimensions: { width: 152, height: 152 },
        approximatePrice: 8.0,
      },
      {
        label: '12"x12"',
        dimensions: { width: 305, height: 305 },
        approximatePrice: 15.0,
      },
      {
        label: '12"x24"',
        dimensions: { width: 305, height: 610 },
        approximatePrice: 28.0,
      },
      {
        label: '24"x24"',
        dimensions: { width: 610, height: 610 },
        approximatePrice: 50.0,
      },
    ],
    suppliers: [{ name: 'McMaster-Carr', approximatePrice: 15.0 }],
    designNotes:
      'Structural-grade sheet for gussets, motor mounts, and load-bearing plates. CNC-friendly. Heavier than 1.5mm but significantly stiffer.',
    tags: ['aluminum', 'sheet', '6061', 'T6', '3mm', 'structural'],
  },

  // ---- Acrylic Sheet ----
  {
    name: 'Clear Acrylic Sheet, 3mm Thick',
    description:
      'Clear cast acrylic (PMMA) sheet, 3mm (1/8") thickness, optically clear, laser-cuttable, scratch resistant',
    categorySlug: 'plastic-sheet',
    entryType: 'raw_stock',
    dimensions: { depth: 3 },
    specs: {
      material: 'Cast Acrylic (PMMA)',
      thickness: '3mm',
      color: 'Clear',
      lightTransmission: '92%',
    },
    stockSizes: [
      {
        label: '12"x12"',
        dimensions: { width: 305, height: 305 },
        approximatePrice: 8.0,
      },
      {
        label: '12"x24"',
        dimensions: { width: 305, height: 610 },
        approximatePrice: 14.0,
      },
      {
        label: '24"x24"',
        dimensions: { width: 610, height: 610 },
        approximatePrice: 25.0,
      },
    ],
    suppliers: [{ name: 'Amazon', approximatePrice: 8.0 }],
    designNotes:
      'Laser cuts cleanly with polished edges. Cement-bondable with acrylic solvent (Weld-On 4). Brittle — do not overtighten fasteners. Use rubber grommets for screw holes.',
    tags: ['acrylic', 'PMMA', 'clear', 'laser-cut', 'plastic', '3mm'],
  },
]
