// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The pure core of product variants: canonical conditions, the text form,
 * matching, and selection validation. Every service and the UI build on
 * these, so they are pinned here without a database.
 */

import { describe, expect, it } from 'vitest'
import {
  conditionMatches,
  formatOptionText,
  normalizeOptionCondition,
  optionConditionKey,
  optionConditionSchema,
  optionModelSchema,
  parseOptionText,
  validateSelectionsAgainst,
} from './variants'
import type { OptionModel } from './variants'

const model: OptionModel = {
  families: [
    {
      code: 'color',
      name: 'Colour',
      required: true,
      values: [
        { code: 'black', label: 'Black' },
        { code: 'white', label: 'White' },
      ],
    },
    {
      code: 'display',
      name: 'Display',
      required: true,
      values: [
        { code: 'yes', label: 'With display' },
        { code: 'no', label: 'Without display' },
      ],
    },
    {
      code: 'buttons',
      name: 'Buttons',
      required: false,
      values: [
        { code: '2', label: '2' },
        { code: '3', label: '3' },
        { code: '8', label: '8' },
      ],
    },
  ],
  constraints: [
    {
      when: { all: [{ family: 'display', values: ['no'] }] },
      require: { all: [{ family: 'buttons', values: ['2', '3'] }] },
      message: 'Without a display only 2 or 3 buttons fit',
    },
  ],
}

describe('normalizeOptionCondition', () => {
  it('sorts families and values, merges repeats, and lower-cases codes', () => {
    const canonical = normalizeOptionCondition({
      all: [
        { family: 'Display', values: ['yes'] },
        { family: 'color', values: ['White', 'black', 'white'] },
        { family: 'display', values: ['no'] },
      ],
    })
    expect(canonical).toEqual({
      all: [
        { family: 'color', values: ['black', 'white'] },
        { family: 'display', values: ['no', 'yes'] },
      ],
    })
  })

  it('gives equal conditions one key and a fixed line the empty key', () => {
    const a = { all: [{ family: 'color', values: ['white', 'black'] }] }
    const b = { all: [{ family: 'color', values: ['black', 'white'] }] }
    expect(optionConditionKey(a)).toBe(optionConditionKey(b))
    expect(optionConditionKey(null)).toBe('')
    expect(optionConditionKey(undefined)).toBe('')
  })
})

describe('optionConditionSchema', () => {
  it('rejects a condition with no families or an empty value list', () => {
    expect(optionConditionSchema.safeParse({ all: [] }).success).toBe(false)
    expect(
      optionConditionSchema.safeParse({
        all: [{ family: 'color', values: [] }],
      }).success,
    ).toBe(false)
  })

  it('rejects codes that are not identifiers', () => {
    expect(
      optionConditionSchema.safeParse({
        all: [{ family: 'colour scheme', values: ['black'] }],
      }).success,
    ).toBe(false)
  })
})

describe('text form', () => {
  it('round-trips through format and parse', () => {
    const condition = {
      all: [
        { family: 'color', values: ['black'] },
        { family: 'display', values: ['no', 'yes'] },
      ],
    }
    const text = formatOptionText(condition)
    expect(text).toBe('color=black; display=no,yes')
    expect(parseOptionText(text)).toEqual(condition)
  })

  it('treats blank text as a fixed line', () => {
    expect(parseOptionText('')).toBeNull()
    expect(parseOptionText('   ')).toBeNull()
    expect(formatOptionText(null)).toBe('')
  })

  it('rejects a clause without a value', () => {
    expect(() => parseOptionText('color=')).toThrow()
    expect(() => parseOptionText('color')).toThrow()
  })
})

describe('conditionMatches', () => {
  const black = { all: [{ family: 'color', values: ['black'] }] }
  const blackWithDisplay = {
    all: [
      { family: 'color', values: ['black'] },
      { family: 'display', values: ['yes'] },
    ],
  }
  const fewButtons = { all: [{ family: 'buttons', values: ['2', '3'] }] }

  it('always admits a fixed line', () => {
    expect(conditionMatches(null, {})).toBe(true)
  })

  it('matches one family', () => {
    expect(conditionMatches(black, { color: 'black' })).toBe(true)
    expect(conditionMatches(black, { color: 'white' })).toBe(false)
  })

  it('ANDs across families', () => {
    expect(
      conditionMatches(blackWithDisplay, { color: 'black', display: 'yes' }),
    ).toBe(true)
    expect(
      conditionMatches(blackWithDisplay, { color: 'black', display: 'no' }),
    ).toBe(false)
  })

  it('ORs within a family', () => {
    expect(conditionMatches(fewButtons, { buttons: '2' })).toBe(true)
    expect(conditionMatches(fewButtons, { buttons: '3' })).toBe(true)
    expect(conditionMatches(fewButtons, { buttons: '8' })).toBe(false)
  })

  it('fails when a named family is not selected', () => {
    expect(conditionMatches(black, {})).toBe(false)
    expect(conditionMatches(blackWithDisplay, { color: 'black' })).toBe(false)
  })
})

describe('validateSelectionsAgainst', () => {
  it('accepts a complete, consistent configuration', () => {
    expect(
      validateSelectionsAgainst(model, {
        color: 'black',
        display: 'yes',
        buttons: '8',
      }),
    ).toEqual([])
  })

  it('reports a missing required family and tolerates a missing optional one', () => {
    const issues = validateSelectionsAgainst(model, { color: 'black' })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.family).toBe('display')
  })

  it('reports an undeclared family and an out-of-domain value', () => {
    const issues = validateSelectionsAgainst(model, {
      color: 'red',
      display: 'yes',
      size: 'large',
    })
    expect(issues.map((i) => i.family).sort()).toEqual(['color', 'size'])
  })

  it('enforces a constraint with its message', () => {
    const issues = validateSelectionsAgainst(model, {
      color: 'black',
      display: 'no',
      buttons: '8',
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toBe('Without a display only 2 or 3 buttons fit')
    expect(
      validateSelectionsAgainst(model, {
        color: 'black',
        display: 'no',
        buttons: '2',
      }),
    ).toEqual([])
  })
})

describe('optionModelSchema', () => {
  it('rejects duplicate family and value codes', () => {
    const dupFamily = optionModelSchema.safeParse({
      families: [
        { code: 'color', name: 'A', values: [{ code: 'x', label: 'x' }] },
        { code: 'color', name: 'B', values: [{ code: 'y', label: 'y' }] },
      ],
    })
    expect(dupFamily.success).toBe(false)
    const dupValue = optionModelSchema.safeParse({
      families: [
        {
          code: 'color',
          name: 'A',
          values: [
            { code: 'x', label: 'x' },
            { code: 'x', label: 'again' },
          ],
        },
      ],
    })
    expect(dupValue.success).toBe(false)
  })

  it('rejects a constraint naming an undeclared family', () => {
    const result = optionModelSchema.safeParse({
      families: model.families,
      constraints: [
        {
          when: { all: [{ family: 'display', values: ['no'] }] },
          require: { all: [{ family: 'handle', values: ['none'] }] },
          message: '',
        },
      ],
    })
    expect(result.success).toBe(false)
  })
})
