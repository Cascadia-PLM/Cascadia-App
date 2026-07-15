import { describe, expect, it } from 'vitest'
import { decodeEntities, decodeEntitiesMaybe } from './tool-utils'

describe('decodeEntities', () => {
  it('decodes the ampersand entity models emit in names', () => {
    expect(decodeEntities('Frame &amp; Chassis Assembly')).toBe(
      'Frame & Chassis Assembly',
    )
  })

  it('decodes the common named entities', () => {
    expect(decodeEntities('A &lt; B &gt; C')).toBe('A < B > C')
    expect(decodeEntities('6&quot; wheel')).toBe('6" wheel')
    expect(decodeEntities('O&apos;Ring')).toBe("O'Ring")
    expect(decodeEntities('non&nbsp;breaking')).toBe('non breaking')
  })

  it('decodes numeric (decimal and hex) entities', () => {
    expect(decodeEntities('O&#39;Ring')).toBe("O'Ring")
    expect(decodeEntities('Frame &#x26; Chassis')).toBe('Frame & Chassis')
  })

  // Ampersand is decoded last: an escaped entity resolves one level, not two.
  it('does not over-decode a double-escaped entity', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;')
  })

  it('leaves plain text untouched', () => {
    expect(decodeEntities('Drive Wheel & Tire, 10 inch')).toBe(
      'Drive Wheel & Tire, 10 inch',
    )
    expect(decodeEntities('Handlebar Post')).toBe('Handlebar Post')
  })

  it('preserves undefined for optional fields', () => {
    expect(decodeEntitiesMaybe(undefined)).toBeUndefined()
    expect(decodeEntitiesMaybe('a &amp; b')).toBe('a & b')
  })
})
