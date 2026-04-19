/**
 * Subtype-aware capabilities editor for Tool items.
 *
 * Renders typed form fields for known subtypes and falls back
 * to a JSON textarea for unknown subtypes.
 */

import {
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui'

// ============================================================================
// Props & helpers
// ============================================================================

interface CapabilitiesEditorProps {
  subtype: string
  capabilities: Record<string, unknown>
  onChange: (caps: Record<string, unknown>) => void
}

function useCapHelpers(
  capabilities: Record<string, unknown>,
  onChange: (c: Record<string, unknown>) => void,
) {
  const set = (key: string, value: unknown) =>
    onChange({ ...capabilities, [key]: value })

  const num = (key: string, fallback = 0) => {
    const v = capabilities[key]
    return typeof v === 'number' ? v : fallback
  }

  const str = (key: string, fallback = '') => {
    const v = capabilities[key]
    return typeof v === 'string' ? v : fallback
  }

  const bool = (key: string) => capabilities[key] === true

  const arr = (key: string): Array<string> => {
    const v = capabilities[key]
    return Array.isArray(v) ? (v as Array<string>) : []
  }

  const tuple2 = (key: string): [number, number] => {
    const v = capabilities[key]
    return Array.isArray(v) && v.length >= 2 ? (v as [number, number]) : [0, 0]
  }

  const tuple3 = (key: string): [number, number, number] => {
    const v = capabilities[key]
    return Array.isArray(v) && v.length >= 3
      ? (v as [number, number, number])
      : [0, 0, 0]
  }

  const setTuple2 = (key: string, index: 0 | 1, value: number) => {
    const t = tuple2(key)
    t[index] = value
    set(key, [...t])
  }

  const setTuple3 = (key: string, index: 0 | 1 | 2, value: number) => {
    const t = tuple3(key)
    t[index] = value
    set(key, [...t])
  }

  const csvField = (key: string, label: string, placeholder: string) => (
    <FormField label={label}>
      <Input
        value={arr(key).join(', ')}
        onChange={(e) =>
          set(
            key,
            e.target.value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
        placeholder={placeholder}
      />
    </FormField>
  )

  const numField = (
    key: string,
    label: string,
    opts?: { step?: string; fallback?: number },
  ) => (
    <FormField label={label}>
      <Input
        type="number"
        step={opts?.step}
        value={num(key, opts?.fallback)}
        onChange={(e) => set(key, Number(e.target.value))}
      />
    </FormField>
  )

  const checkField = (key: string, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={bool(key)}
        onChange={(e) => set(key, e.target.checked)}
      />
      {label}
    </label>
  )

  return {
    set,
    num,
    str,
    bool,
    arr,
    tuple2,
    tuple3,
    setTuple2,
    setTuple3,
    csvField,
    numField,
    checkField,
  }
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-zinc-400">{title}</p>
      {children}
    </div>
  )
}

// ============================================================================
// Subtype-specific editors
// ============================================================================

function FdmPrinterEditor(props: CapabilitiesEditorProps) {
  const h = useCapHelpers(props.capabilities, props.onChange)
  return (
    <Section title="FDM Printer Capabilities">
      <div className="grid grid-cols-3 gap-2">
        <FormField label="Build X (mm)">
          <Input
            type="number"
            value={h.tuple3('buildVolume')[0]}
            onChange={(e) =>
              h.setTuple3('buildVolume', 0, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Build Y (mm)">
          <Input
            type="number"
            value={h.tuple3('buildVolume')[1]}
            onChange={(e) =>
              h.setTuple3('buildVolume', 1, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Build Z (mm)">
          <Input
            type="number"
            value={h.tuple3('buildVolume')[2]}
            onChange={(e) =>
              h.setTuple3('buildVolume', 2, Number(e.target.value))
            }
          />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {h.numField('nozzleDiameter', 'Nozzle Diameter (mm)', {
          step: '0.1',
          fallback: 0.4,
        })}
        {h.csvField(
          'compatibleMaterials',
          'Materials (comma-separated)',
          'PLA, PETG, ABS',
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Min Layer Height (mm)">
          <Input
            type="number"
            step="0.01"
            value={h.tuple2('layerHeightRange')[0]}
            onChange={(e) =>
              h.setTuple2('layerHeightRange', 0, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Max Layer Height (mm)">
          <Input
            type="number"
            step="0.01"
            value={h.tuple2('layerHeightRange')[1]}
            onChange={(e) =>
              h.setTuple2('layerHeightRange', 1, Number(e.target.value))
            }
          />
        </FormField>
      </div>
      <div className="flex items-center gap-4">
        {h.checkField('heatedBed', 'Heated Bed')}
        {h.checkField('enclosedChamber', 'Enclosed Chamber')}
      </div>
    </Section>
  )
}

function SlaPrinterEditor(props: CapabilitiesEditorProps) {
  const h = useCapHelpers(props.capabilities, props.onChange)
  return (
    <Section title="SLA Printer Capabilities">
      <div className="grid grid-cols-3 gap-2">
        <FormField label="Build X (mm)">
          <Input
            type="number"
            value={h.tuple3('buildVolume')[0]}
            onChange={(e) =>
              h.setTuple3('buildVolume', 0, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Build Y (mm)">
          <Input
            type="number"
            value={h.tuple3('buildVolume')[1]}
            onChange={(e) =>
              h.setTuple3('buildVolume', 1, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Build Z (mm)">
          <Input
            type="number"
            value={h.tuple3('buildVolume')[2]}
            onChange={(e) =>
              h.setTuple3('buildVolume', 2, Number(e.target.value))
            }
          />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {h.numField('xyResolution', 'XY Resolution (µm)')}
        {h.csvField(
          'resinTypes',
          'Resin Types (comma-separated)',
          'standard, tough, flexible',
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Min Layer Height (mm)">
          <Input
            type="number"
            step="0.01"
            value={h.tuple2('layerHeightRange')[0]}
            onChange={(e) =>
              h.setTuple2('layerHeightRange', 0, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Max Layer Height (mm)">
          <Input
            type="number"
            step="0.01"
            value={h.tuple2('layerHeightRange')[1]}
            onChange={(e) =>
              h.setTuple2('layerHeightRange', 1, Number(e.target.value))
            }
          />
        </FormField>
      </div>
    </Section>
  )
}

function CncMillEditor(props: CapabilitiesEditorProps) {
  const h = useCapHelpers(props.capabilities, props.onChange)
  return (
    <Section title="CNC Mill Capabilities">
      <div className="grid grid-cols-3 gap-2">
        <FormField label="Work X (mm)">
          <Input
            type="number"
            value={h.tuple3('workVolume')[0]}
            onChange={(e) =>
              h.setTuple3('workVolume', 0, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Work Y (mm)">
          <Input
            type="number"
            value={h.tuple3('workVolume')[1]}
            onChange={(e) =>
              h.setTuple3('workVolume', 1, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Work Z (mm)">
          <Input
            type="number"
            value={h.tuple3('workVolume')[2]}
            onChange={(e) =>
              h.setTuple3('workVolume', 2, Number(e.target.value))
            }
          />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Axes">
          <Select
            value={String(h.num('axes', 3))}
            onValueChange={(v) => h.set('axes', Number(v))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="3">3-axis</SelectItem>
              <SelectItem value="4">4-axis</SelectItem>
              <SelectItem value="5">5-axis</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        {h.csvField(
          'compatibleMaterials',
          'Materials (comma-separated)',
          'aluminum, steel, brass',
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Min Spindle Speed (RPM)">
          <Input
            type="number"
            value={h.tuple2('spindleSpeedRange')[0]}
            onChange={(e) =>
              h.setTuple2('spindleSpeedRange', 0, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Max Spindle Speed (RPM)">
          <Input
            type="number"
            value={h.tuple2('spindleSpeedRange')[1]}
            onChange={(e) =>
              h.setTuple2('spindleSpeedRange', 1, Number(e.target.value))
            }
          />
        </FormField>
      </div>
      {h.numField('toolChangerSlots', 'Tool Changer Slots')}
    </Section>
  )
}

function CncLatheEditor(props: CapabilitiesEditorProps) {
  const h = useCapHelpers(props.capabilities, props.onChange)
  return (
    <Section title="CNC Lathe Capabilities">
      <div className="grid grid-cols-2 gap-2">
        {h.numField('maxSwingDiameter', 'Max Swing Diameter (mm)')}
        {h.numField('maxTurningLength', 'Max Turning Length (mm)')}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Min Spindle Speed (RPM)">
          <Input
            type="number"
            value={h.tuple2('spindleSpeedRange')[0]}
            onChange={(e) =>
              h.setTuple2('spindleSpeedRange', 0, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Max Spindle Speed (RPM)">
          <Input
            type="number"
            value={h.tuple2('spindleSpeedRange')[1]}
            onChange={(e) =>
              h.setTuple2('spindleSpeedRange', 1, Number(e.target.value))
            }
          />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {h.numField('spindleBore', 'Spindle Bore (mm)')}
        {h.numField('toolChangerSlots', 'Tool Changer Slots')}
      </div>
      {h.csvField(
        'compatibleMaterials',
        'Materials (comma-separated)',
        'steel, aluminum, brass',
      )}
      <div className="flex items-center gap-4">
        {h.checkField('liveTooling', 'Live Tooling')}
        {h.checkField('subSpindle', 'Sub-Spindle')}
      </div>
    </Section>
  )
}

function LaserCutterEditor(props: CapabilitiesEditorProps) {
  const h = useCapHelpers(props.capabilities, props.onChange)
  return (
    <Section title="Laser Cutter Capabilities">
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Bed X (mm)">
          <Input
            type="number"
            value={h.tuple2('bedSize')[0]}
            onChange={(e) => h.setTuple2('bedSize', 0, Number(e.target.value))}
          />
        </FormField>
        <FormField label="Bed Y (mm)">
          <Input
            type="number"
            value={h.tuple2('bedSize')[1]}
            onChange={(e) => h.setTuple2('bedSize', 1, Number(e.target.value))}
          />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Laser Type">
          <Select
            value={h.str('laserType', 'co2')}
            onValueChange={(v) => h.set('laserType', v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="co2">CO2</SelectItem>
              <SelectItem value="fiber">Fiber</SelectItem>
              <SelectItem value="diode">Diode</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        {h.numField('maxPower', 'Max Power (W)')}
      </div>
    </Section>
  )
}

function ManualMillEditor(props: CapabilitiesEditorProps) {
  const h = useCapHelpers(props.capabilities, props.onChange)
  return (
    <Section title="Manual Mill Capabilities">
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Table X (mm)">
          <Input
            type="number"
            value={h.tuple2('tableSize')[0]}
            onChange={(e) =>
              h.setTuple2('tableSize', 0, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Table Y (mm)">
          <Input
            type="number"
            value={h.tuple2('tableSize')[1]}
            onChange={(e) =>
              h.setTuple2('tableSize', 1, Number(e.target.value))
            }
          />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {h.numField('maxSpindleToTable', 'Max Spindle-to-Table (mm)')}
        <FormField label="Spindle Taper">
          <Input
            value={h.str('spindleTaper')}
            onChange={(e) => h.set('spindleTaper', e.target.value)}
            placeholder="R8, NT30, CAT40"
          />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Min Spindle Speed (RPM)">
          <Input
            type="number"
            value={h.tuple2('spindleSpeedRange')[0]}
            onChange={(e) =>
              h.setTuple2('spindleSpeedRange', 0, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Max Spindle Speed (RPM)">
          <Input
            type="number"
            value={h.tuple2('spindleSpeedRange')[1]}
            onChange={(e) =>
              h.setTuple2('spindleSpeedRange', 1, Number(e.target.value))
            }
          />
        </FormField>
      </div>
      {h.csvField(
        'compatibleMaterials',
        'Materials (comma-separated)',
        'aluminum, steel, brass',
      )}
      <div className="flex items-center gap-4">
        {h.checkField('powerFeed', 'Power Feed')}
        {h.checkField('dro', 'Digital Readout (DRO)')}
      </div>
    </Section>
  )
}

function ManualLatheEditor(props: CapabilitiesEditorProps) {
  const h = useCapHelpers(props.capabilities, props.onChange)
  return (
    <Section title="Manual Lathe Capabilities">
      <div className="grid grid-cols-2 gap-2">
        {h.numField('maxSwingDiameter', 'Max Swing Diameter (mm)')}
        {h.numField('distanceBetweenCenters', 'Distance Between Centers (mm)')}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Min Spindle Speed (RPM)">
          <Input
            type="number"
            value={h.tuple2('spindleSpeedRange')[0]}
            onChange={(e) =>
              h.setTuple2('spindleSpeedRange', 0, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Max Spindle Speed (RPM)">
          <Input
            type="number"
            value={h.tuple2('spindleSpeedRange')[1]}
            onChange={(e) =>
              h.setTuple2('spindleSpeedRange', 1, Number(e.target.value))
            }
          />
        </FormField>
      </div>
      {h.numField('spindleBore', 'Spindle Bore (mm)')}
      {h.csvField(
        'compatibleMaterials',
        'Materials (comma-separated)',
        'steel, aluminum, brass',
      )}
      <div className="flex items-center gap-4">
        {h.checkField('threading', 'Threading Capable')}
        {h.checkField('dro', 'Digital Readout (DRO)')}
      </div>
    </Section>
  )
}

function MiterSawEditor(props: CapabilitiesEditorProps) {
  const h = useCapHelpers(props.capabilities, props.onChange)
  return (
    <Section title="Miter Saw Capabilities">
      <div className="grid grid-cols-2 gap-2">
        {h.numField('bladeSize', 'Blade Size (mm)')}
        {h.numField('maxCrosscutWidth', 'Max Crosscut at 90° (mm)')}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {h.numField('maxCrosscutAt45', 'Max Crosscut at 45° (mm)')}
        {h.numField('maxCutDepth', 'Max Cut Depth (mm)')}
      </div>
      <div className="flex items-center gap-4">
        {h.checkField('slidingCompound', 'Sliding Compound')}
        {h.checkField('dualBevel', 'Dual Bevel')}
      </div>
    </Section>
  )
}

function DrillPressEditor(props: CapabilitiesEditorProps) {
  const h = useCapHelpers(props.capabilities, props.onChange)
  return (
    <Section title="Drill Press Capabilities">
      <div className="grid grid-cols-2 gap-2">
        {h.numField('maxDrillDiameter', 'Max Drill Diameter (mm)')}
        {h.numField('throatDepth', 'Throat Depth (mm)')}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {h.numField('maxStrokeDepth', 'Max Stroke Depth (mm)')}
        <FormField label="Table Size (mm)">
          <div className="flex gap-1">
            <Input
              type="number"
              value={h.tuple2('tableSize')[0]}
              onChange={(e) =>
                h.setTuple2('tableSize', 0, Number(e.target.value))
              }
              placeholder="X"
            />
            <Input
              type="number"
              value={h.tuple2('tableSize')[1]}
              onChange={(e) =>
                h.setTuple2('tableSize', 1, Number(e.target.value))
              }
              placeholder="Y"
            />
          </div>
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Min Spindle Speed (RPM)">
          <Input
            type="number"
            value={h.tuple2('spindleSpeedRange')[0]}
            onChange={(e) =>
              h.setTuple2('spindleSpeedRange', 0, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Max Spindle Speed (RPM)">
          <Input
            type="number"
            value={h.tuple2('spindleSpeedRange')[1]}
            onChange={(e) =>
              h.setTuple2('spindleSpeedRange', 1, Number(e.target.value))
            }
          />
        </FormField>
      </div>
    </Section>
  )
}

function PressBrakeEditor(props: CapabilitiesEditorProps) {
  const h = useCapHelpers(props.capabilities, props.onChange)
  return (
    <Section title="Press Brake Capabilities">
      <div className="grid grid-cols-2 gap-2">
        {h.numField('maxForce', 'Max Force (tonnes)')}
        {h.numField('bendLength', 'Bend Length (mm)')}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {h.numField('maxSheetThickness', 'Max Sheet Thickness (mm)')}
        {h.checkField('cnc', 'CNC Controlled')}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Min Back Gauge (mm)">
          <Input
            type="number"
            value={h.tuple2('backGaugeRange')[0]}
            onChange={(e) =>
              h.setTuple2('backGaugeRange', 0, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Max Back Gauge (mm)">
          <Input
            type="number"
            value={h.tuple2('backGaugeRange')[1]}
            onChange={(e) =>
              h.setTuple2('backGaugeRange', 1, Number(e.target.value))
            }
          />
        </FormField>
      </div>
      {h.csvField(
        'compatibleMaterials',
        'Materials (comma-separated)',
        'mild steel, stainless, aluminum',
      )}
    </Section>
  )
}

function SurfaceGrinderEditor(props: CapabilitiesEditorProps) {
  const h = useCapHelpers(props.capabilities, props.onChange)
  return (
    <Section title="Surface Grinder Capabilities">
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Table X (mm)">
          <Input
            type="number"
            value={h.tuple2('tableSize')[0]}
            onChange={(e) =>
              h.setTuple2('tableSize', 0, Number(e.target.value))
            }
          />
        </FormField>
        <FormField label="Table Y (mm)">
          <Input
            type="number"
            value={h.tuple2('tableSize')[1]}
            onChange={(e) =>
              h.setTuple2('tableSize', 1, Number(e.target.value))
            }
          />
        </FormField>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {h.numField('maxGrindingHeight', 'Max Grinding Height (mm)')}
        {h.numField('wheelDiameter', 'Wheel Diameter (mm)')}
      </div>
      {h.checkField('magneticChuck', 'Magnetic Chuck')}
    </Section>
  )
}

// ============================================================================
// Main component
// ============================================================================

const EDITORS: Record<
  string,
  (props: CapabilitiesEditorProps) => React.ReactNode
> = {
  fdm_printer: FdmPrinterEditor,
  sla_printer: SlaPrinterEditor,
  cnc_mill: CncMillEditor,
  cnc_lathe: CncLatheEditor,
  laser_cutter: LaserCutterEditor,
  manual_mill: ManualMillEditor,
  manual_lathe: ManualLatheEditor,
  miter_saw: MiterSawEditor,
  drill_press: DrillPressEditor,
  press_brake: PressBrakeEditor,
  surface_grinder: SurfaceGrinderEditor,
}

export function CapabilitiesEditor({
  subtype,
  capabilities,
  onChange,
}: CapabilitiesEditorProps) {
  const Editor = EDITORS[subtype]

  if (Editor) {
    return (
      <Editor
        subtype={subtype}
        capabilities={capabilities}
        onChange={onChange}
      />
    )
  }

  if (!subtype) {
    return (
      <p className="text-sm text-slate-500">
        Select a tool subtype to configure capabilities.
      </p>
    )
  }

  // Generic JSON fallback for subtypes without a dedicated editor
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-zinc-400">Capabilities (JSON)</p>
      <Textarea
        rows={5}
        value={JSON.stringify(capabilities, null, 2)}
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value))
          } catch {
            /* ignore while typing */
          }
        }}
        className="font-mono text-xs"
        placeholder='{"key": "value"}'
      />
    </div>
  )
}
