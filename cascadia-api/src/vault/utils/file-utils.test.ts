// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { detectFileCategory, isFileTypeAllowed } from './file-utils'

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
