/**
 * DFM (Design for Manufacturing) Rule Sets
 *
 * Static reference data used by the manufacturing section builder.
 * Stored as code constants — these are engineering rules, not user data.
 */

export const DFM_RULES: Record<string, Array<string>> = {
  fdm_printer: [
    'Minimum wall thickness: 3x nozzle diameter (1.2mm at 0.4mm nozzle)',
    'Minimum feature size: 2x nozzle diameter',
    'Avoid overhangs greater than 45 degrees without support surfaces',
    'Horizontal holes: use teardrop/keyhole profile for better bridging',
    'Clearance: 0.2mm press-fit, 0.3mm sliding fit',
    'Bridges: max ~50mm unsupported span',
    'Strongest in X/Y plane, weakest in Z (layer adhesion) — orient for load path',
    'Add fillets (min 1mm) to internal corners to reduce stress concentration',
  ],

  sla_printer: [
    'Minimum wall thickness: 0.5mm',
    'Minimum feature size: 0.2mm (limited by pixel size)',
    'Drain holes required for hollow parts (min 3mm diameter, two per cavity)',
    'Support marks appear on surfaces — orient cosmetic faces away from supports',
    'Cure uniformity: keep wall thickness consistent to avoid warping',
  ],

  cnc_mill: [
    'Inside corner radius must be >= half the smallest tool diameter',
    'Maximum pocket depth-to-width ratio: 4:1',
    'Avoid undercuts unless 4th/5th axis is available',
    'Consider workholding — include clamping surfaces or fixture points',
    'Minimum wall thickness: 1mm for metals, 1.5mm for plastics',
    'Standard drill sizes are preferred over arbitrary hole diameters',
  ],

  laser_cutter: [
    'Design as 2D profile — uniform thickness (material sheet)',
    'Minimum feature size: material thickness',
    'Kerf compensation: ~0.1–0.2mm (material and laser dependent)',
    'Tab/slot joints: slot width = material thickness + 0.1mm for clearance',
    'Living hinges possible in thin plywood/acrylic with parallel kerf cuts',
    'Avoid very narrow islands (<2mm) between cuts — may warp or break',
  ],

  miter_saw: [
    'All cuts must be straight (no curves)',
    'Maximum cut width limited by blade and crosscut capacity',
    'Miter angles typically limited to 0-45 degrees',
    'Material must be clamped securely — avoid very short pieces (<50mm)',
  ],

  drill_press: [
    'Use standard drill bit sizes where possible',
    'Maximum hole depth limited by stroke depth',
    'Center-punch before drilling for accuracy',
    'Through-holes need sacrificial backing material',
  ],

  band_saw: [
    'Can cut curves but minimum radius depends on blade width',
    'Cuts are rougher than other methods — plan for finishing',
    'Maximum cut thickness depends on throat depth and blade',
  ],

  cnc_lathe: [
    'Design for rotational symmetry — all features must be achievable by turning',
    'Minimum internal bore diameter limited by boring bar rigidity (~3:1 L/D ratio)',
    'Avoid sharp internal corners — use minimum 0.4mm radius for tool nose',
    'Part-off groove width must accommodate tool insert width + clearance',
    'Live tooling cross-holes should use standard drill sizes',
    'Consider workholding: chuck jaw marks, tailstock support for long parts (L/D > 3)',
    'Thread relief grooves required for external/internal threads',
  ],

  cnc_router: [
    'Design as 2.5D where possible — full 3D requires longer cycle times',
    'Minimum feature size limited by bit diameter (typically 3mm+)',
    'Use tabs/bridges to hold parts in sheet during cutting',
    'Climb vs conventional milling matters — specify for finish quality',
    'Spoilboard surfacing required for consistent depth cuts',
  ],

  cnc_plasma: [
    'Minimum feature size: ~1.5x material thickness',
    'Kerf width is wider than laser (~1.5–3mm depending on amperage)',
    'Heat-affected zone is significant — add machining allowance for critical dimensions',
    'Beveled edges are normal — plan for post-grinding if square edges needed',
    'Pierce points leave marks — start cuts from edges or scrap areas where possible',
  ],

  cnc_waterjet: [
    'Can cut virtually any material including hardened steel, glass, and composites',
    'Kerf width ~0.5–1.5mm depending on nozzle',
    'Taper increases with thickness — abrasive waterjet typically ±0.1mm per 25mm thickness',
    'No heat-affected zone — suitable for heat-sensitive materials',
    'Minimum feature size: ~1mm for thin materials, increases with thickness',
    'Pierce points: start from edge or use lead-in paths for cosmetic surfaces',
  ],

  manual_mill: [
    'All CNC mill DFM rules apply, plus manual-specific constraints',
    'Complex 3D contours are impractical — design for 2.5D operations',
    'Tolerances: ±0.05mm achievable with DRO, ±0.1mm without',
    'Repeated identical features should use fixtures or stops for consistency',
    'Long tool reaches reduce rigidity — keep pocket depths reasonable',
    'Consider operator access — features should be reachable without extreme setups',
  ],

  manual_lathe: [
    'All CNC lathe DFM rules apply, plus manual-specific constraints',
    'Tolerances: ±0.025mm achievable with DRO, ±0.05mm without',
    'Complex profiles require form tools or careful hand-feeding',
    'Internal features limited by boring bar reach and rigidity',
    'Taper turning limited by compound rest travel (~75mm typical)',
    'Knurling requires sufficient diameter (min ~10mm) and rigid setup',
  ],

  table_saw: [
    'All cuts must be straight (rip or crosscut)',
    'Maximum cut depth limited by blade height above table',
    'Dado cuts require stacked dado set or wobble blade',
    'Never cut pieces shorter than ~300mm without a crosscut sled',
    'Avoid binding — ensure proper fence alignment and riving knife',
  ],

  scroll_saw: [
    'Can cut very tight curves (down to ~1.5mm radius)',
    'Maximum material thickness limited (~50mm typical for wood)',
    'Internal cutouts possible via blade threading through drilled hole',
    'Cuts are slower but more precise than band saw for thin materials',
  ],

  cold_saw: [
    'Clean, burr-free cuts in metal — superior to abrasive cutoff',
    'Best for straight crosscuts on bar stock, tubing, and structural shapes',
    'Blade diameter and arbor limit max cut capacity',
    'Coolant is essential — dry cutting damages blade and work',
  ],

  arbor_press: [
    'Force is limited (~1–5 tonnes typical) — suitable for light press-fits, staking, riveting',
    'No precision depth control — use shims or stops for consistent press depth',
    'Work must be supported to avoid bending — flat parallel surfaces needed',
    'Not suitable for heavy interference fits — use hydraulic press instead',
  ],

  hydraulic_press: [
    'Can apply very high force (10–100+ tonnes) — suitable for heavy press-fits and forming',
    'Use press blocks and parallels to ensure even force distribution',
    'Stroke rate is slow — not suitable for production stamping',
    'Include chamfers or lead-ins on press-fit features for easier assembly',
  ],

  press_brake: [
    'Minimum flange length: typically 6x material thickness + bend radius',
    'Inside bend radius: minimum 1x material thickness for mild steel',
    'Bend deduction/K-factor must be calculated for accurate flat pattern',
    'Spring-back compensation varies by material — 1-5 degrees typical',
    'Avoid bends close to holes — minimum 2x material thickness from hole edge to bend line',
    'Maximum bend length limited by press brake bed length',
    'Hemmed edges require two operations (acute bend then flatten)',
  ],

  box_brake: [
    'Designed for box/pan shapes — can form opposite sides without interfering',
    'Finger width limits minimum bend clearance for adjacent flanges',
    'Maximum material thickness typically thinner than press brake (1-2mm sheet)',
    'Limited to simple straight bends — no complex forming profiles',
  ],

  slip_roll: [
    'Forms cylindrical and conical shapes from sheet metal',
    'Minimum roll diameter ~2x roller diameter',
    'Cannot roll the last ~50mm near the edge (flat spot)',
    'Pre-bend edges before rolling for tight cylinders',
    'Material must be consistent thickness for uniform curves',
  ],

  surface_grinder: [
    'Achieves very tight flatness and surface finish (Ra 0.1–0.8µm)',
    'Part must be ferromagnetic for magnetic chuck, or use fixturing for non-magnetic',
    'Maximum material removal per pass: ~0.025mm for finishing',
    'Part height must clear the wheel guard',
    'Coolant is essential to prevent heat damage and maintain accuracy',
  ],

  mig_welder: [
    'Joint access: gun nozzle needs clear line of sight to weld joint',
    'Minimum material thickness ~0.8mm (thin sheet warps easily)',
    'Design joints for flat or horizontal position where possible',
    'Include weld prep (bevel/chamfer) for material >6mm thick',
    'Allow for weld distortion — add machining allowance on critical surfaces',
  ],

  tig_welder: [
    'Best for thin materials, precision work, and dissimilar metals',
    'Requires two-hand operation — joint must be accessible from one side',
    'Minimum material thickness ~0.5mm (with skilled operator)',
    'Back-purge required for stainless steel and titanium',
    'Slower than MIG — use for critical structural or cosmetic welds only',
  ],

  soldering_station: [
    'PCB pad and trace dimensions must match component footprints',
    'Through-hole components: hole diameter = lead diameter + 0.2-0.3mm',
    'SMD components: follow IPC-7351 land pattern recommendations',
    'Thermal relief on ground planes for easier hand soldering',
    'Maintain minimum 0.2mm spacing between pads for hand soldering',
  ],

  reflow_oven: [
    'All components must be rated for reflow temperature profile (typically 245-260°C peak)',
    'Use IPC-7351 land patterns for all SMD components',
    'Large thermal mass components may need adjusted placement for even heating',
    'Double-sided reflow: heavy components on second side risk falling during reflow',
    'Solder paste stencil aperture design affects solder volume and joint quality',
  ],

  vacuum_former: [
    'Draft angles: minimum 3-5 degrees for easy part removal',
    'Avoid deep draws — max depth-to-width ratio ~1:1',
    'Sharp corners thin the sheet — use generous radii (min 2x sheet thickness)',
    'Vent holes needed at deepest points of mold for air evacuation',
    'Undercuts are not possible without split molds',
    'Wall thickness decreases with draw depth — plan for thinnest point',
  ],
}

/**
 * Get DFM rules for a manufacturing process.
 * Returns empty array for unknown processes.
 */
export function getDfmRules(process: string): Array<string> {
  return DFM_RULES[process] ?? []
}
