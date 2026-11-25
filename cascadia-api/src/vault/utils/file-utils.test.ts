// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { NATIVE_CAD_EXTENSIONS } from '@cascadia/commons/vault/native-cad-formats'
import {
  canonicalizeItemFileName,
  detectFileCategory,
  isFileTypeAllowed,
  nativeCadNamingMode,
} from './file-utils'

const PDF = 'application/pdf'

describe('detectFileCategory', () => {
  describe('unambiguous formats are decided by extension', () => {
    it.each([
      ['bracket.sldprt', 'cad_model'],
      ['bracket.step', 'cad_model'],
      ['arm.sldasm', 'cad_model'],
      ['arm.catproduct', 'cad_model'],
      ['ASSY-100.slddrw', 'drawing'],
      ['ASSY-100.dwg', 'drawing'],
      ['ASSY-100.catdrawing', 'drawing'],
    ])('%s -> %s', (filename, expected) => {
      expect(detectFileCategory(filename, 'application/octet-stream')).toBe(
        expected,
      )
    })
  })

  describe('a PDF is a container, not a content type', () => {
    it('does not assume an unhinted PDF is a drawing', () => {
      expect(detectFileCategory('TDJ-25-Rev-A.pdf', PDF)).toBe('reference')
    })

    it.each([
      // Certificates, reports, and anything else unlabeled stay neutral
      ['Cert_of_Conformance.pdf', 'reference'],
      ['Material_Test_Report.pdf', 'reference'],
      ['RoHS Declaration.pdf', 'reference'],
      // ...but an explicit hint still classifies
      ['ASSY-100-Drawing.pdf', 'drawing'],
      ['100-101_dwg.pdf', 'drawing'],
      ['Stress Analysis.pdf', 'analysis'],
      ['housing_fea_results.pdf', 'analysis'],
      ['MOTOR-SPEC.pdf', 'specification'],
      ['motor_specification_rev_b.pdf', 'specification'],
      ['TMC2209_datasheet.pdf', 'specification'],
      ['System Requirements.pdf', 'specification'],
    ])('%s -> %s', (filename, expected) => {
      expect(detectFileCategory(filename, PDF)).toBe(expected)
    })
  })

  describe('filename hints match whole words', () => {
    it.each([
      // "inspection" contains "spec"
      ['Inspection_Report.pdf', 'reference'],
      // "feature" and "feasibility" contain "fea"
      ['Feature_List.pdf', 'reference'],
      ['Feasibility_Study.pdf', 'reference'],
    ])('%s -> %s', (filename, expected) => {
      expect(detectFileCategory(filename, PDF)).toBe(expected)
    })
  })

  it('classifies by extension even when the browser sends a generic MIME type', () => {
    expect(
      detectFileCategory('MOTOR-SPEC.pdf', 'application/octet-stream'),
    ).toBe('specification')
  })
})

describe('isFileTypeAllowed', () => {
  it('allows Windows application build artifacts', () => {
    expect(
      isFileTypeAllowed('cascadia-installer.exe', 'application/octet-stream'),
    ).toBe(true)
  })
})

describe('nativeCadNamingMode', () => {
  afterEach(() => {
    delete process.env.VAULT_NATIVE_CAD_NAMING
  })

  it('defaults to preserve', () => {
    delete process.env.VAULT_NATIVE_CAD_NAMING
    expect(nativeCadNamingMode()).toBe('preserve')
  })

  it('enables item-number naming when configured', () => {
    process.env.VAULT_NATIVE_CAD_NAMING = 'itemNumber'
    expect(nativeCadNamingMode()).toBe('itemNumber')
  })

  it('ignores unknown values', () => {
    process.env.VAULT_NATIVE_CAD_NAMING = 'unknown'
    expect(nativeCadNamingMode()).toBe('preserve')
  })
})

describe('canonicalizeItemFileName', () => {
  it('names a native CAD file after the item number, with its own extension', () => {
    expect(canonicalizeItemFileName('10298', 'Drawing2.dwg')).toBe('10298.dwg')
    expect(canonicalizeItemFileName('10298', 'plate.DXF')).toBe('10298.dxf')
    expect(canonicalizeItemFileName('10298', 'bracket.SLDPRT')).toBe(
      '10298.sldprt',
    )
  })

  // Every case here was mangled once: the item number was run through the
  // storage sanitizer and then parsed for an extension of its own.
  it.each([
    ['100.200.300', 'part.sldprt', '100.200.300.sldprt'],
    ['100.200.301', 'part.sldprt', '100.200.301.sldprt'],
    ['ASM-1.0', 'top.SLDASM', 'ASM-1.0.sldasm'],
    ['DWG-001/A', 'sheet.dwg', 'DWG-001_A.dwg'],
    ['DWG-001\\A', 'sheet.dwg', 'DWG-001_A.dwg'],
    ['A:B*C?D"E<F>G|H', 'part.ipt', 'A_B_C_D_E_F_G_H.ipt'],
    ['PN\u00017', 'part.prt', 'PN_7.prt'],
    ['PN 100 (alt) #2', 'part.par', 'PN 100 (alt) #2.par'],
    ['  PN-7. ', 'part.sldprt', 'PN-7.sldprt'],
    ['PN-7...', 'part.sldprt', 'PN-7.sldprt'],
    ['../etc/passwd', 'part.sldprt', '.._etc_passwd.sldprt'],
    ['10298.sldprt', 'part.sldprt', '10298.sldprt.sldprt'],
  ])('keeps item number %j whole: %s -> %s', (itemNumber, file, expected) => {
    expect(canonicalizeItemFileName(itemNumber, file)).toBe(expected)
  })

  it('keeps distinct item numbers distinct', () => {
    const numbers = ['100.200.300', '100.200.301', '100.200', '100_200']
    const names = numbers.map((n) => canonicalizeItemFileName(n, 'p.sldprt'))
    expect(new Set(names).size).toBe(numbers.length)
  })

  it('never produces a path', () => {
    for (const itemNumber of ['a/b', 'a\\b', '../x', '/abs', 'C:\\x']) {
      const name = canonicalizeItemFileName(itemNumber, 'p.sldprt')
      expect(name).not.toMatch(/[/\\:]/)
    }
  })

  it.each([
    ['CON', 'CON_.sldprt'],
    ['nul', 'nul_.sldprt'],
    ['COM1', 'COM1_.sldprt'],
    ['lpt9', 'lpt9_.sldprt'],
    ['AUX.2', 'AUX_.2.sldprt'],
    ['CONSOLE', 'CONSOLE.sldprt'],
    ['COM10', 'COM10.sldprt'],
    ['PRN-1', 'PRN-1.sldprt'],
  ])(
    'steers clear of the Windows device name in %j',
    (itemNumber, expected) => {
      expect(canonicalizeItemFileName(itemNumber, 'part.sldprt')).toBe(expected)
    },
  )

  it('does nothing when no usable item number is left', () => {
    expect(canonicalizeItemFileName('', 'Drawing2.dwg')).toBe('Drawing2.dwg')
    expect(canonicalizeItemFileName(null, 'Drawing2.dwg')).toBe('Drawing2.dwg')
    expect(canonicalizeItemFileName(' . ', 'Drawing2.dwg')).toBe('Drawing2.dwg')
  })

  it.each(NATIVE_CAD_EXTENSIONS.map((ext) => [ext]))(
    'renames native authoring format %s',
    (ext) => {
      expect(canonicalizeItemFileName('10298', `local${ext}`)).toBe(
        `10298${ext}`,
      )
    },
  )

  it.each([
    // Neutral exchange formats
    'export.step',
    'export.stp',
    'export.iges',
    'export.igs',
    'export.x_t',
    'export.x_b',
    'export.sat',
    'export.jt',
    // Mesh and visualization formats
    'mesh.stl',
    'mesh.obj',
    'mesh.glb',
    'mesh.gltf',
    'mesh.3mf',
    'mesh.ply',
    'mesh.fbx',
    // Documents, images, archives
    'A3_L.pdf',
    'preview.png',
    'spec.docx',
    'bundle.zip',
    'no-extension',
  ])('leaves %s with its submitted name', (fileName) => {
    expect(canonicalizeItemFileName('10298', fileName)).toBe(fileName)
  })
})
