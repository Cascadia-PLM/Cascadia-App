/**
 * Component Catalog Categories
 *
 * Hierarchical category tree for organizing catalog entries.
 * Slugs are used as stable identifiers for bulk import.
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
    children: [
      { name: 'Bolts', slug: 'bolts' },
      { name: 'Nuts', slug: 'nuts' },
      { name: 'Washers', slug: 'washers' },
      { name: 'Screws', slug: 'screws' },
      { name: 'Standoffs & Spacers', slug: 'standoffs-spacers' },
      { name: 'Threaded Inserts', slug: 'threaded-inserts' },
    ],
  },
  {
    name: 'Bearings',
    slug: 'bearings',
    children: [
      { name: 'Ball Bearings', slug: 'ball-bearings' },
      { name: 'Bushings', slug: 'bushings' },
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
  {
    name: 'Motors',
    slug: 'motors',
    children: [
      { name: 'Stepper Motors', slug: 'stepper-motors' },
      { name: 'DC Motors', slug: 'dc-motors' },
      { name: 'Servo Motors', slug: 'servo-motors' },
      { name: 'Linear Actuators', slug: 'linear-actuators' },
    ],
  },
  {
    name: 'Motor Drivers',
    slug: 'motor-drivers',
  },
  {
    name: 'Microcontrollers',
    slug: 'microcontrollers',
  },
  {
    name: 'Sensors',
    slug: 'sensors',
    children: [
      { name: 'Limit Switches', slug: 'limit-switches' },
      { name: 'Encoders', slug: 'encoders' },
      { name: 'Temperature Sensors', slug: 'temperature-sensors' },
      { name: 'Distance Sensors', slug: 'distance-sensors' },
    ],
  },
  {
    name: 'Power',
    slug: 'power',
    children: [
      { name: 'Voltage Regulators', slug: 'voltage-regulators' },
      { name: 'Battery Holders', slug: 'battery-holders' },
      { name: 'Power Modules', slug: 'power-modules' },
    ],
  },
  {
    name: 'Connectors',
    slug: 'connectors',
    children: [
      { name: 'JST Connectors', slug: 'jst-connectors' },
      { name: 'Screw Terminals', slug: 'screw-terminals' },
      { name: 'Barrel Jacks', slug: 'barrel-jacks' },
      { name: 'USB Connectors', slug: 'usb-connectors' },
    ],
  },
  {
    name: 'Wire & Cable',
    slug: 'wire-cable',
  },
  {
    name: 'Displays',
    slug: 'displays',
  },
  {
    name: 'Relays & Switching',
    slug: 'relays-switching',
  },
  {
    name: 'Gears & Transmission',
    slug: 'gears-transmission',
    children: [
      { name: 'GT2 Pulleys & Belts', slug: 'gt2-pulleys-belts' },
      { name: 'Spur Gears', slug: 'spur-gears' },
      { name: 'Shaft Couplings', slug: 'shaft-couplings' },
    ],
  },
  {
    name: 'T-Slot Extrusion',
    slug: 't-slot-extrusion',
  },
  {
    name: 'T-Slot Hardware',
    slug: 't-slot-hardware',
  },
  {
    name: 'Aluminum Profiles',
    slug: 'aluminum-profiles',
  },
  {
    name: 'Steel Profiles',
    slug: 'steel-profiles',
  },
  {
    name: 'Sheet Stock',
    slug: 'sheet-stock',
  },
  {
    name: 'Plastic Sheet',
    slug: 'plastic-sheet',
  },
  {
    name: 'Round Bar & Rod',
    slug: 'round-bar-rod',
  },
  {
    name: 'Threaded Rod',
    slug: 'threaded-rod',
  },
  {
    name: 'Tubing',
    slug: 'tubing',
  },
  {
    name: 'Adhesives & Sealants',
    slug: 'adhesives-sealants',
  },
  {
    name: 'Enclosures',
    slug: 'enclosures',
  },
  {
    name: 'Misc Hardware',
    slug: 'misc-hardware',
    children: [
      { name: 'Springs', slug: 'springs' },
      { name: 'Magnets', slug: 'magnets' },
      { name: 'Rubber Feet & Bumpers', slug: 'rubber-feet-bumpers' },
    ],
  },
]
