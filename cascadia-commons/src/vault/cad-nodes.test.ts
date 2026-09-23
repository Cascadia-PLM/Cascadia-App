// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  matchNode,
  matchNodeInPath,
  normalizeCadName,
  toMatchCandidate,
} from './cad-nodes'
import type { MatchCandidate } from './cad-nodes'

/**
 * What a name in a CAD file is allowed to mean.
 *
 * The matcher decides which PLM part a node of an assembly model *is*, from
 * nothing but the string the CAD wrote. Getting it wrong is not visible in the
 * result — a wrongly matched node looks exactly like a correctly matched one,
 * and quietly sends people to the wrong part's detail page — so the rules it
 * follows are pinned here rather than left to reading.
 */

function candidate(itemNumber: string, name: string | null): MatchCandidate {
  return toMatchCandidate({
    id: `item-${itemNumber}`,
    masterId: `master-${itemNumber}`,
    itemNumber,
    name,
    itemType: 'Part',
    revision: 'A',
    state: 'Released',
  })
}

describe('normalizeCadName', () => {
  it('strips the file extension every CAD tool appends', () => {
    for (const raw of [
      'TDJ-25-1042.SLDPRT',
      'TDJ-25-1042.sldprt',
      'TDJ-25-1042.step',
      'TDJ-25-1042.FCStd',
      'TDJ-25-1042.CATPart',
    ]) {
      expect(normalizeCadName(raw)).toBe('tdj-25-1042')
    }
  })

  it('folds the separators CAD names disagree about', () => {
    expect(normalizeCadName('Base Bracket')).toBe('base-bracket')
    expect(normalizeCadName('base_bracket')).toBe('base-bracket')
    expect(normalizeCadName('  Base   Bracket  ')).toBe('base-bracket')
    expect(normalizeCadName('base--bracket')).toBe('base-bracket')
  })

  it('leaves a trailing number alone', () => {
    // The temptation is to read `-1` as an occurrence suffix and strip it.
    // Part numbers end in digits too, and folding `TDJ-25-1` into `TDJ-25`
    // would silently merge two different parts.
    expect(normalizeCadName('TDJ-25-1')).toBe('tdj-25-1')
    expect(normalizeCadName('bracket_2')).toBe('bracket-2')
  })

  it('reduces a name with nothing in it to the empty string', () => {
    expect(normalizeCadName('   ')).toBe('')
    expect(normalizeCadName('.sldprt')).toBe('')
  })
})

describe('matchNode', () => {
  const bom = [
    candidate('TDJ-25-1042', 'Base Bracket'),
    candidate('TDJ-25-1108', 'Shoulder Link'),
    candidate('TDJ-25-104', 'Shim'),
    candidate('HW-M4-12', 'M4x12 Cap Screw'),
  ]

  it('matches an item number, however the CAD spelled it', () => {
    for (const nodeName of [
      'TDJ-25-1042',
      'tdj-25-1042',
      'TDJ-25-1042.SLDPRT',
      'TDJ_25_1042',
    ]) {
      expect(matchNode(nodeName, bom)?.itemNumber).toBe('TDJ-25-1042')
    }
  })

  it('falls back to the part name when the number does not appear', () => {
    expect(matchNode('Shoulder Link.SLDPRT', bom)?.itemNumber).toBe(
      'TDJ-25-1108',
    )
  })

  it('finds an item number embedded in a longer CAD name', () => {
    expect(matchNode('TDJ-25-1108-rev-b', bom)?.itemNumber).toBe('TDJ-25-1108')
    expect(matchNode('assy-TDJ-25-1042', bom)?.itemNumber).toBe('TDJ-25-1042')
  })

  it('does not let a shorter part number match inside a longer one', () => {
    // `TDJ-25-104` is a real part in this BOM, and a substring of
    // `TDJ-25-1042`. A containment test without token boundaries matches it,
    // and every bracket in the assembly resolves to the shim.
    expect(matchNode('TDJ-25-1042', bom)?.itemNumber).toBe('TDJ-25-1042')
    expect(matchNode('TDJ-25-104', bom)?.itemNumber).toBe('TDJ-25-104')
  })

  it('prefers an exact number over a name that also matches', () => {
    const ambiguous = [
      candidate('PN-1', 'Cover Plate'),
      candidate('Cover Plate', 'Something Else'),
    ]
    // The second candidate's *number* is the string being matched, so the
    // number tier wins over the first candidate's name.
    expect(matchNode('Cover Plate', ambiguous)?.itemNumber).toBe('Cover Plate')
  })

  it('refuses to guess when two parts match equally well', () => {
    const duplicated = [
      candidate('PN-1', 'Bracket'),
      candidate('PN-2', 'Bracket'),
    ]
    expect(matchNode('Bracket', duplicated)).toBeNull()
  })

  it('does not fall through to a weaker tier after an ambiguous one', () => {
    // Two exact-number matches is a broken BOM, not an invitation to go
    // matching on names instead: the weaker tier's answer would be presented
    // with the same confidence as an exact one.
    const duplicated = [
      candidate('SHIM', 'Alpha'),
      candidate('SHIM', 'Beta'),
      candidate('OTHER', 'shim'),
    ]
    expect(matchNode('SHIM', duplicated)).toBeNull()
  })

  it('returns null rather than matching an empty name', () => {
    expect(matchNode('', bom)).toBeNull()
    expect(matchNode('   ', bom)).toBeNull()
    // A part with no name must not become the match for every unnamed node.
    expect(matchNode('.sldprt', [candidate('PN-1', null)])).toBeNull()
  })

  it('returns null when the BOM is empty', () => {
    expect(matchNode('TDJ-25-1042', [])).toBeNull()
  })

  it('matches every occurrence of a repeated part to that same part', () => {
    // Twelve cap screws are twelve nodes and one BOM line. Each has to
    // resolve, and all to the same part.
    const occurrences = ['HW-M4-12', 'HW-M4-12', 'HW-M4-12']
    const matched = occurrences.map((name) => matchNode(name, bom)?.masterId)
    expect(matched).toEqual([
      'master-HW-M4-12',
      'master-HW-M4-12',
      'master-HW-M4-12',
    ])
  })
})

describe('normalizeCadName, on the character a filename cannot hold', () => {
  /**
   * A fraction in a fastener description is where this bites. SolidWorks
   * cannot put `/` in a filename, so it writes `1_2` for the part the BOM
   * calls `1/2` — and on the robot arm's top-level model that alone left 40
   * of 225 parts unmatched, every one of them hardware.
   */
  it('reads a substituted slash and a real one as the same name', () => {
    expect(
      normalizeCadName(
        'HSHCS ASME B18.3 - 10-24 UNC x 1_2 Steel Grade 2 Plain',
      ),
    ).toBe(
      normalizeCadName(
        'HSHCS ASME B18.3 - 10-24 UNC x 1/2 Steel Grade 2 Plain',
      ),
    )
  })

  it('matches such a part against its BOM entry', () => {
    const bom = [
      candidate('HSHCS ASME B18.3 - 10-24 UNC x 1/2 Steel Grade 2 Plain', null),
    ]
    const hit = matchNode(
      'HSHCS ASME B18.3 - 10-24 UNC x 1_2 Steel Grade 2 Plain',
      bom,
    )
    expect(hit?.itemNumber).toBe(
      'HSHCS ASME B18.3 - 10-24 UNC x 1/2 Steel Grade 2 Plain',
    )
  })

  it('still keeps a fraction distinct from a different fraction', () => {
    const bom = [
      candidate('HSHCS - 10-24 x 1/2 Plain', null),
      candidate('HSHCS - 10-24 x 1/4 Plain', null),
    ]
    expect(matchNode('HSHCS - 10-24 x 1_2 Plain', bom)?.itemNumber).toBe(
      'HSHCS - 10-24 x 1/2 Plain',
    )
    expect(matchNode('HSHCS - 10-24 x 1_4 Plain', bom)?.itemNumber).toBe(
      'HSHCS - 10-24 x 1/4 Plain',
    )
  })
})

describe('matchNodeInPath', () => {
  /**
   * Which string identifies a part depends on the exporter. SolidWorks names
   * the leaf after the part; FreeCAD names the *solid* — `Tube`, `Plate`,
   * `Lid` — and leaves the part number one level up the instance path. Both
   * datasets have to resolve, so the leaf is tried first and the enclosing
   * path after it.
   */
  const bom = [
    candidate('PUC-1411', 'Handle Loop, DOM Tube, Bent'),
    candidate('PUC-1410', 'Handle Weldment'),
    candidate('TDJ-25-1042', 'Base Bracket'),
  ]

  it('prefers the leaf name when the leaf is the part', () => {
    expect(
      matchNodeInPath(
        ['PUC-1410 Handle Weldment', 'TDJ-25-1042'],
        'TDJ-25-1042',
        bom,
      )?.itemNumber,
    ).toBe('TDJ-25-1042')
  })

  it('reads the part number off the enclosing path when the leaf is a solid', () => {
    expect(
      matchNodeInPath(
        [
          'PUC-1410 Handle Weldment',
          'PUC-1411 Handle Loop, DOM Tube, Bent',
          'Tube',
        ],
        'Tube',
        bom,
      )?.itemNumber,
    ).toBe('PUC-1411')
  })

  /**
   * The one that matters. An outer segment is an ancestor assembly, so taking
   * the outermost match would file a part's geometry under its container —
   * a confidently wrong answer, where nearest-first gives the right one.
   */
  it('takes the nearest enclosing match, not the outermost', () => {
    expect(
      matchNodeInPath(
        [
          'PUC-1410 Handle Weldment',
          'PUC-1411 Handle Loop, DOM Tube, Bent',
          'Tube',
        ],
        'Tube',
        bom,
      )?.itemNumber,
    ).toBe('PUC-1411')
  })

  it('returns null when neither the leaf nor any segment names a part', () => {
    expect(
      matchNodeInPath(['Configuration 1-1'], 'Configuration 1-1', bom),
    ).toBeNull()
    expect(matchNodeInPath([], 'R_0805_2012Metric', bom)).toBeNull()
  })

  it('does not resolve a node just because its container is in the BOM', () => {
    // `Lid` is a solid of no BOM part, inside an assembly that is one. The
    // assembly itself is never a candidate for its own contents, so a path
    // naming only it must not lend its identity to the solid.
    const onlyAssembly = [candidate('PUC-1410', 'Handle Weldment')]
    expect(
      matchNodeInPath(
        ['PUC-1499 Some Other Weldment', 'Lid'],
        'Lid',
        onlyAssembly,
      ),
    ).toBeNull()
  })
})
