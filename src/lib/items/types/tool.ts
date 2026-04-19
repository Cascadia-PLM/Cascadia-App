import { z } from 'zod'
import { baseItemSchema } from './base'
import type { BaseItem, RelationshipConfig, StateConfig } from './base'

// ============================================================================
// Tool-specific interface
// ============================================================================

export interface Tool extends BaseItem {
  itemType: 'Tool'
  toolType: 'manufacturing' | 'quality' | 'utility'
  toolSubtype: string
  manufacturer?: string
  model?: string
  capabilities?: Record<string, unknown>
  toolStatus?: 'available' | 'in_use' | 'maintenance' | 'retired'
  location?: string
  notes?: string
}

// ============================================================================
// Known tool subtypes with metadata
// ============================================================================

export const TOOL_SUBTYPES = {
  // Manufacturing — Additive
  fdm_printer: {
    label: 'FDM 3D Printer',
    toolType: 'manufacturing' as const,
    icon: 'Printer',
  },
  sla_printer: {
    label: 'SLA 3D Printer',
    toolType: 'manufacturing' as const,
    icon: 'Printer',
  },
  // Manufacturing — Subtractive (CNC)
  cnc_mill: {
    label: 'CNC Mill',
    toolType: 'manufacturing' as const,
    icon: 'Cog',
  },
  cnc_lathe: {
    label: 'CNC Lathe',
    toolType: 'manufacturing' as const,
    icon: 'Cog',
  },
  cnc_router: {
    label: 'CNC Router',
    toolType: 'manufacturing' as const,
    icon: 'Cog',
  },
  cnc_plasma: {
    label: 'CNC Plasma Cutter',
    toolType: 'manufacturing' as const,
    icon: 'Zap',
  },
  cnc_waterjet: {
    label: 'CNC Waterjet',
    toolType: 'manufacturing' as const,
    icon: 'Zap',
  },
  cnc_edm: {
    label: 'CNC EDM (Wire/Sinker)',
    toolType: 'manufacturing' as const,
    icon: 'Zap',
  },
  laser_cutter: {
    label: 'Laser Cutter',
    toolType: 'manufacturing' as const,
    icon: 'Zap',
  },
  // Manufacturing — Subtractive (Manual)
  manual_mill: {
    label: 'Manual Mill',
    toolType: 'manufacturing' as const,
    icon: 'Cog',
  },
  manual_lathe: {
    label: 'Manual Lathe',
    toolType: 'manufacturing' as const,
    icon: 'Cog',
  },
  drill_press: {
    label: 'Drill Press',
    toolType: 'manufacturing' as const,
    icon: 'ArrowDown',
  },
  // Manufacturing — Saws
  miter_saw: {
    label: 'Miter Saw',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  band_saw: {
    label: 'Band Saw',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  table_saw: {
    label: 'Table Saw',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  scroll_saw: {
    label: 'Scroll Saw',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  cold_saw: {
    label: 'Cold Saw',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  // Manufacturing — Forming & Pressing
  arbor_press: {
    label: 'Arbor Press',
    toolType: 'manufacturing' as const,
    icon: 'ArrowDown',
  },
  hydraulic_press: {
    label: 'Hydraulic Press',
    toolType: 'manufacturing' as const,
    icon: 'ArrowDown',
  },
  press_brake: {
    label: 'Press Brake',
    toolType: 'manufacturing' as const,
    icon: 'ArrowDown',
  },
  box_brake: {
    label: 'Box & Pan Brake',
    toolType: 'manufacturing' as const,
    icon: 'ArrowDown',
  },
  finger_brake: {
    label: 'Finger Brake',
    toolType: 'manufacturing' as const,
    icon: 'ArrowDown',
  },
  slip_roll: {
    label: 'Slip Roll',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  english_wheel: {
    label: 'English Wheel',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  punch_press: {
    label: 'Punch Press / Turret Punch',
    toolType: 'manufacturing' as const,
    icon: 'ArrowDown',
  },
  tube_bender: {
    label: 'Tube Bender',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  // Manufacturing — Grinding & Finishing
  angle_grinder: {
    label: 'Angle Grinder',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  bench_grinder: {
    label: 'Bench Grinder',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  surface_grinder: {
    label: 'Surface Grinder',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  belt_sander: {
    label: 'Belt Sander',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  disc_sander: {
    label: 'Disc Sander',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  tumbler: {
    label: 'Tumbler / Vibratory Finisher',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  sandblaster: {
    label: 'Sandblaster',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  // Manufacturing — Welding & Joining
  mig_welder: {
    label: 'MIG Welder',
    toolType: 'manufacturing' as const,
    icon: 'Zap',
  },
  tig_welder: {
    label: 'TIG Welder',
    toolType: 'manufacturing' as const,
    icon: 'Zap',
  },
  stick_welder: {
    label: 'Stick Welder (SMAW)',
    toolType: 'manufacturing' as const,
    icon: 'Zap',
  },
  spot_welder: {
    label: 'Spot Welder',
    toolType: 'manufacturing' as const,
    icon: 'Zap',
  },
  soldering_station: {
    label: 'Soldering Station',
    toolType: 'manufacturing' as const,
    icon: 'Zap',
  },
  reflow_oven: {
    label: 'Reflow Oven',
    toolType: 'manufacturing' as const,
    icon: 'Zap',
  },
  // Manufacturing — Casting & Molding
  injection_molder: {
    label: 'Injection Molder',
    toolType: 'manufacturing' as const,
    icon: 'Box',
  },
  vacuum_former: {
    label: 'Vacuum Former',
    toolType: 'manufacturing' as const,
    icon: 'Box',
  },
  kiln: {
    label: 'Kiln / Furnace',
    toolType: 'manufacturing' as const,
    icon: 'Box',
  },
  // Manufacturing — Other
  heat_gun: {
    label: 'Heat Gun',
    toolType: 'manufacturing' as const,
    icon: 'Zap',
  },
  deburring_tool: {
    label: 'Deburring Tool',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  tap_die_set: {
    label: 'Tap & Die Set',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  rivet_gun: {
    label: 'Rivet Gun',
    toolType: 'manufacturing' as const,
    icon: 'CircleDot',
  },
  // Quality
  cmm: { label: 'CMM', toolType: 'quality' as const, icon: 'Ruler' },
  calipers: { label: 'Calipers', toolType: 'quality' as const, icon: 'Ruler' },
  micrometer: {
    label: 'Micrometer',
    toolType: 'quality' as const,
    icon: 'Ruler',
  },
  height_gauge: {
    label: 'Height Gauge',
    toolType: 'quality' as const,
    icon: 'Ruler',
  },
  surface_plate: {
    label: 'Surface Plate',
    toolType: 'quality' as const,
    icon: 'Ruler',
  },
  '3d_scanner': {
    label: '3D Scanner',
    toolType: 'quality' as const,
    icon: 'Scan',
  },
  camera: { label: 'Camera', toolType: 'quality' as const, icon: 'Camera' },
  // Utility
  robotic_arm: {
    label: 'Robotic Arm',
    toolType: 'utility' as const,
    icon: 'Bot',
  },
  pick_and_place: {
    label: 'Pick and Place',
    toolType: 'utility' as const,
    icon: 'Move',
  },
} as const

export type KnownToolSubtype = keyof typeof TOOL_SUBTYPES

// ============================================================================
// Capability schemas per subtype
// ============================================================================

export const fdmPrinterCapabilitiesSchema = z.object({
  buildVolume: z.tuple([z.number(), z.number(), z.number()]), // [x, y, z] mm
  nozzleDiameter: z.number().positive().default(0.4), // mm
  layerHeightRange: z.tuple([z.number(), z.number()]), // [min, max] mm
  heatedBed: z.boolean(),
  maxBedTemp: z.number().positive().optional(), // °C
  maxHotendTemp: z.number().positive().optional(), // °C
  enclosedChamber: z.boolean().optional(),
  compatibleMaterials: z.array(z.string()), // ["PLA", "PETG", "ABS", ...]
  multiMaterial: z
    .object({
      type: z.string(),
      materialSlots: z.number().int().positive(),
    })
    .optional(),
})

export const slaPrinterCapabilitiesSchema = z.object({
  buildVolume: z.tuple([z.number(), z.number(), z.number()]),
  xyResolution: z.number().positive(), // µm (pixel size)
  layerHeightRange: z.tuple([z.number(), z.number()]), // mm
  resinTypes: z.array(z.string()), // ["standard", "tough", "flexible", "castable"]
})

export const cncMillCapabilitiesSchema = z.object({
  workVolume: z.tuple([z.number(), z.number(), z.number()]), // mm
  spindleSpeedRange: z.tuple([z.number(), z.number()]), // RPM
  toolChangerSlots: z.number().int().positive().optional(),
  axes: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  compatibleMaterials: z.array(z.string()),
})

export const laserCutterCapabilitiesSchema = z.object({
  bedSize: z.tuple([z.number(), z.number()]), // [x, y] mm
  laserType: z.enum(['co2', 'fiber', 'diode']),
  maxPower: z.number().positive(), // watts
  cuttableMaterials: z.array(
    z.object({
      material: z.string(),
      maxThickness: z.number().positive(), // mm
    }),
  ),
})

export const miterSawCapabilitiesSchema = z.object({
  bladeSize: z.number().positive(), // mm
  maxCrosscutWidth: z.number().positive(), // mm at 90°
  maxCrosscutAt45: z.number().positive().optional(), // mm at 45° miter
  maxCutDepth: z.number().positive(), // mm at 90°
  slidingCompound: z.boolean(),
  dualBevel: z.boolean(),
})

export const drillPressCapabilitiesSchema = z.object({
  maxDrillDiameter: z.number().positive(), // mm
  spindleSpeedRange: z.tuple([z.number(), z.number()]), // RPM
  throatDepth: z.number().positive(), // mm
  maxStrokeDepth: z.number().positive(), // mm
  tableSize: z.tuple([z.number(), z.number()]), // mm
})

export const cncLatheCapabilitiesSchema = z.object({
  maxSwingDiameter: z.number().positive(), // mm — max workpiece diameter
  maxTurningLength: z.number().positive(), // mm
  spindleSpeedRange: z.tuple([z.number(), z.number()]), // RPM
  spindleBore: z.number().positive().optional(), // mm — bar stock capacity
  toolChangerSlots: z.number().int().positive().optional(),
  liveTooling: z.boolean().optional(),
  subSpindle: z.boolean().optional(),
  compatibleMaterials: z.array(z.string()),
})

export const manualMillCapabilitiesSchema = z.object({
  tableSize: z.tuple([z.number(), z.number()]), // [x, y] mm
  maxSpindleToTable: z.number().positive(), // mm — Z travel
  spindleSpeedRange: z.tuple([z.number(), z.number()]), // RPM
  spindleTaper: z.string().optional(), // "R8", "NT30", "CAT40"
  powerFeed: z.boolean().optional(),
  dro: z.boolean().optional(), // digital readout
  compatibleMaterials: z.array(z.string()),
})

export const manualLatheCapabilitiesSchema = z.object({
  maxSwingDiameter: z.number().positive(), // mm
  distanceBetweenCenters: z.number().positive(), // mm
  spindleSpeedRange: z.tuple([z.number(), z.number()]), // RPM
  spindleBore: z.number().positive().optional(), // mm
  threading: z.boolean().optional(),
  dro: z.boolean().optional(),
  compatibleMaterials: z.array(z.string()),
})

export const pressBrakeCapabilitiesSchema = z.object({
  maxForce: z.number().positive(), // tonnes
  bendLength: z.number().positive(), // mm
  maxSheetThickness: z.number().positive(), // mm (for mild steel)
  backGaugeRange: z.tuple([z.number(), z.number()]).optional(), // mm
  cnc: z.boolean().optional(),
  compatibleMaterials: z.array(z.string()),
})

export const surfaceGrinderCapabilitiesSchema = z.object({
  tableSize: z.tuple([z.number(), z.number()]), // [x, y] mm
  maxGrindingHeight: z.number().positive(), // mm
  magneticChuck: z.boolean().optional(),
  wheelDiameter: z.number().positive().optional(), // mm
})

/** Map from known subtype to its capability schema */
export const CAPABILITY_SCHEMAS: Record<string, z.ZodSchema> = {
  fdm_printer: fdmPrinterCapabilitiesSchema,
  sla_printer: slaPrinterCapabilitiesSchema,
  cnc_mill: cncMillCapabilitiesSchema,
  cnc_lathe: cncLatheCapabilitiesSchema,
  laser_cutter: laserCutterCapabilitiesSchema,
  manual_mill: manualMillCapabilitiesSchema,
  manual_lathe: manualLatheCapabilitiesSchema,
  press_brake: pressBrakeCapabilitiesSchema,
  surface_grinder: surfaceGrinderCapabilitiesSchema,
  miter_saw: miterSawCapabilitiesSchema,
  drill_press: drillPressCapabilitiesSchema,
}

// ============================================================================
// Tool Zod schema with conditional capabilities validation
// ============================================================================

export const toolSchema = baseItemSchema
  .extend({
    itemType: z.literal('Tool'),
    toolType: z.enum(['manufacturing', 'quality', 'utility']),
    toolSubtype: z.string().min(1).max(50),
    manufacturer: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
    toolStatus: z
      .enum(['available', 'in_use', 'maintenance', 'retired'])
      .optional(),
    location: z.string().max(500).optional(),
    notes: z.string().max(5000).optional(),
  })
  .superRefine((data, ctx) => {
    // Validate capabilities against known subtype schemas
    if (data.capabilities && data.toolSubtype) {
      const schema = CAPABILITY_SCHEMAS[data.toolSubtype]
      if (schema) {
        const result = schema.safeParse(data.capabilities)
        if (!result.success) {
          for (const issue of result.error.issues) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['capabilities', ...issue.path],
              message: issue.message,
            })
          }
        }
      }
      // Unknown subtypes: freeform capabilities are accepted as-is
    }
  })

// ============================================================================
// Tool states (free lifecycle)
// ============================================================================

export const toolStates: Array<StateConfig> = [
  { id: 'Draft', name: 'Draft', color: 'gray' },
  { id: 'Active', name: 'Active', color: 'green' },
  { id: 'Maintenance', name: 'Maintenance', color: 'yellow' },
  { id: 'Retired', name: 'Retired', color: 'red' },
]

// ============================================================================
// Tool relationships (none — tools are standalone)
// ============================================================================

export const toolRelationships: Array<RelationshipConfig> = []

// ============================================================================
// Export type
// ============================================================================

// ============================================================================
// Subtype grouping (for UI display)
// ============================================================================

const SUBTYPE_GROUPS: Record<string, string> = {
  // Additive
  fdm_printer: 'Additive',
  sla_printer: 'Additive',
  // CNC
  cnc_mill: 'CNC',
  cnc_lathe: 'CNC',
  cnc_router: 'CNC',
  cnc_plasma: 'CNC',
  cnc_waterjet: 'CNC',
  cnc_edm: 'CNC',
  laser_cutter: 'CNC',
  // Manual Machining
  manual_mill: 'Manual Machining',
  manual_lathe: 'Manual Machining',
  drill_press: 'Manual Machining',
  // Saws
  miter_saw: 'Saws',
  band_saw: 'Saws',
  table_saw: 'Saws',
  scroll_saw: 'Saws',
  cold_saw: 'Saws',
  // Forming & Pressing
  arbor_press: 'Forming & Pressing',
  hydraulic_press: 'Forming & Pressing',
  press_brake: 'Forming & Pressing',
  box_brake: 'Forming & Pressing',
  finger_brake: 'Forming & Pressing',
  slip_roll: 'Forming & Pressing',
  english_wheel: 'Forming & Pressing',
  punch_press: 'Forming & Pressing',
  tube_bender: 'Forming & Pressing',
  // Grinding & Finishing
  angle_grinder: 'Grinding & Finishing',
  bench_grinder: 'Grinding & Finishing',
  surface_grinder: 'Grinding & Finishing',
  belt_sander: 'Grinding & Finishing',
  disc_sander: 'Grinding & Finishing',
  tumbler: 'Grinding & Finishing',
  sandblaster: 'Grinding & Finishing',
  // Welding & Joining
  mig_welder: 'Welding & Joining',
  tig_welder: 'Welding & Joining',
  stick_welder: 'Welding & Joining',
  spot_welder: 'Welding & Joining',
  soldering_station: 'Welding & Joining',
  reflow_oven: 'Welding & Joining',
  // Casting & Molding
  injection_molder: 'Casting & Molding',
  vacuum_former: 'Casting & Molding',
  kiln: 'Casting & Molding',
  // Other Manufacturing
  heat_gun: 'Other',
  deburring_tool: 'Other',
  tap_die_set: 'Other',
  rivet_gun: 'Other',
  // Quality
  cmm: 'Measurement',
  calipers: 'Measurement',
  micrometer: 'Measurement',
  height_gauge: 'Measurement',
  surface_plate: 'Measurement',
  '3d_scanner': 'Scanning',
  camera: 'Scanning',
  // Utility
  robotic_arm: 'Automation',
  pick_and_place: 'Automation',
}

/** Get the display group for a tool subtype (for grouped dropdown menus) */
export function getSubtypeGroup(subtype: string): string {
  return SUBTYPE_GROUPS[subtype] ?? ''
}

export type ToolInput = z.infer<typeof toolSchema>
