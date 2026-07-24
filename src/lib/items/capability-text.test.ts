import { describe, expect, it } from 'vitest'
import {
  displayCapabilityValue,
  formatCapabilityText,
  humanizeCapabilityKey,
  parseCapabilityText,
} from './capability-text'

describe('parseCapabilityText', () => {
  it('returns an empty record for blank input', () => {
    expect(parseCapabilityText('')).toEqual({})
    expect(parseCapabilityText('   \n  \n')).toEqual({})
  })

  it('reads one capability per line without quotes or braces', () => {
    expect(parseCapabilityText('Max power: 60\nLaser type: fiber')).toEqual({
      'Max power': 60,
      'Laser type': 'fiber',
    })
  })

  it('accepts = as a separator', () => {
    expect(parseCapabilityText('maxPower = 60')).toEqual({ maxPower: 60 })
  })

  it('splits comma-separated values into a list', () => {
    expect(parseCapabilityText('Materials: PLA, PETG, ABS')).toEqual({
      Materials: ['PLA', 'PETG', 'ABS'],
    })
  })

  it('reads dimension shorthand as a numeric tuple', () => {
    expect(parseCapabilityText('Build volume: 250 x 210 x 220')).toEqual({
      'Build volume': [250, 210, 220],
    })
  })

  it('coerces yes/no and numbers', () => {
    expect(
      parseCapabilityText('Heated bed: yes\nEnclosed: no\nNozzle: 0.4'),
    ).toEqual({ 'Heated bed': true, Enclosed: false, Nozzle: 0.4 })
  })

  it('treats a line with no separator as yes-flags', () => {
    expect(parseCapabilityText('Enclosed, Filtered exhaust')).toEqual({
      Enclosed: true,
      'Filtered exhaust': true,
    })
  })

  it('tolerates bullets and trailing punctuation', () => {
    expect(parseCapabilityText('- Max power: 60,\n* Heated bed: yes;')).toEqual(
      {
        'Max power': 60,
        'Heated bed': true,
      },
    )
  })

  it('keeps commas that sit inside quotes or brackets', () => {
    expect(parseCapabilityText('Note: "cuts steel, brass"')).toEqual({
      Note: 'cuts steel, brass',
    })
    expect(
      parseCapabilityText('Cuttable: [{"material":"acrylic","max":6}]'),
    ).toEqual({ Cuttable: [{ material: 'acrylic', max: 6 }] })
  })

  it('accepts a pasted JSON object verbatim', () => {
    expect(parseCapabilityText('{"maxPower": 60, "cnc": true}')).toEqual({
      maxPower: 60,
      cnc: true,
    })
  })

  it('never throws on half-typed input', () => {
    expect(() => parseCapabilityText('{"maxPower":')).not.toThrow()
    expect(() => parseCapabilityText('Materials: [PLA,')).not.toThrow()
    expect(parseCapabilityText('Materials:')).toEqual({ Materials: '' })
  })
})

describe('capability text round-trip', () => {
  // The editor formats a stored record into text and re-parses what the user
  // leaves behind, so format -> parse must be lossless for stored shapes.
  const cases: Array<[string, Record<string, unknown>]> = [
    ['empty', {}],
    ['numbers', { maxPower: 60, nozzleDiameter: 0.4 }],
    ['booleans', { heatedBed: true, enclosedChamber: false }],
    ['tuples', { buildVolume: [250, 210, 220], layerHeightRange: [0.05, 0.3] }],
    ['string lists', { compatibleMaterials: ['PLA', 'PETG', 'ABS'] }],
    ['plain strings', { spindleTaper: 'R8', laserType: 'co2' }],
    ['numeric-looking strings', { firmware: '42', serial: 'yes' }],
    ['strings with commas', { note: 'cuts steel, brass' }],
    ['strings with separators', { docs: 'https://example.com/a=1' }],
    ['nested objects', { multiMaterial: { type: 'MMU', materialSlots: 5 } }],
    [
      'nested arrays',
      { cuttableMaterials: [{ material: 'acrylic', maxThickness: 6 }] },
    ],
    ['empty values', { location: '' }],
  ]

  it.each(cases)('preserves %s', (_label, capabilities) => {
    expect(parseCapabilityText(formatCapabilityText(capabilities))).toEqual(
      capabilities,
    )
  })

  it('renders an empty record as empty text, not "{}"', () => {
    expect(formatCapabilityText({})).toBe('')
  })

  it('is stable across repeated format/parse cycles', () => {
    const first = formatCapabilityText({
      buildVolume: [250, 210, 220],
      compatibleMaterials: ['PLA', 'PETG'],
      heatedBed: true,
    })
    expect(formatCapabilityText(parseCapabilityText(first))).toBe(first)
  })
})

describe('display helpers', () => {
  it('humanizes camelCase and snake_case keys', () => {
    expect(humanizeCapabilityKey('buildVolume')).toBe('Build Volume')
    expect(humanizeCapabilityKey('max_power')).toBe('Max Power')
    expect(humanizeCapabilityKey('Heated bed')).toBe('Heated Bed')
  })

  it('formats values for reading', () => {
    expect(displayCapabilityValue(true)).toBe('Yes')
    expect(displayCapabilityValue([250, 210, 220])).toBe('250 × 210 × 220')
    expect(displayCapabilityValue(['PLA', 'PETG'])).toBe('PLA, PETG')
    expect(displayCapabilityValue('')).toBe('—')
  })
})
