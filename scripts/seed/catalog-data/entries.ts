/**
 * Component Catalog Entries
 *
 * The standard catalog seed is sourced from the curated JSON files in
 * `test-data/` — the bulk-import format documented in the admin UI.
 * Static imports let esbuild inline the JSON into the server bundle, so
 * the deployed seed endpoint doesn't read the filesystem.
 */


import adhesives from '../../../test-data/adhesives.json'
import aluminumProfiles from '../../../test-data/aluminum-profiles.json'
import bearings from '../../../test-data/bearings.json'
import connectors from '../../../test-data/connectors.json'
import dinRail from '../../../test-data/din-rail.json'
import discreteSemiconductors from '../../../test-data/discrete-semiconductors.json'
import displays from '../../../test-data/displays.json'
import enclosures from '../../../test-data/enclosures.json'
import fasteners from '../../../test-data/fasteners.json'
import gearsTransmission from '../../../test-data/gears-transmission.json'
import leds from '../../../test-data/leds.json'
import linearMotion from '../../../test-data/linear-motion.json'
import microcontrollers from '../../../test-data/microcontrollers.json'
import miscHardware from '../../../test-data/misc-hardware.json'
import motorDrivers from '../../../test-data/motor-drivers.json'
import motors from '../../../test-data/motors.json'
import passiveComponents from '../../../test-data/passive-components.json'
import plasticSheet from '../../../test-data/plastic-sheet.json'
import plywoodMdf from '../../../test-data/plywood-mdf.json'
import power from '../../../test-data/power.json'
import protectionComponents from '../../../test-data/protection-components.json'
import relaysSwitching from '../../../test-data/relays-switching.json'
import roundBar from '../../../test-data/round-bar.json'
import sensors from '../../../test-data/sensors.json'
import sheetStock from '../../../test-data/sheet-stock.json'
import steelProfiles from '../../../test-data/steel-profiles.json'
import tSlotExtrusion from '../../../test-data/t-slot-extrusion.json'
import tSlotHardware from '../../../test-data/t-slot-hardware.json'
import threadedRod from '../../../test-data/threaded-rod.json'
import tubing from '../../../test-data/tubing.json'
import wireCable from '../../../test-data/wire-cable.json'
import type { CatalogEntryDef } from '../types'

export const ENTRIES: Array<CatalogEntryDef> = [
  ...adhesives,
  ...aluminumProfiles,
  ...bearings,
  ...connectors,
  ...dinRail,
  ...discreteSemiconductors,
  ...displays,
  ...enclosures,
  ...fasteners,
  ...gearsTransmission,
  ...leds,
  ...linearMotion,
  ...microcontrollers,
  ...miscHardware,
  ...motorDrivers,
  ...motors,
  ...passiveComponents,
  ...plasticSheet,
  ...plywoodMdf,
  ...power,
  ...protectionComponents,
  ...relaysSwitching,
  ...roundBar,
  ...sensors,
  ...sheetStock,
  ...steelProfiles,
  ...tSlotExtrusion,
  ...tSlotHardware,
  ...threadedRod,
  ...tubing,
  ...wireCable,
] as Array<CatalogEntryDef>
