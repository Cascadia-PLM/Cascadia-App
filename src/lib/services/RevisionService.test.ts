import { RevisionService } from './RevisionService'
import type { RevisionScheme } from '../types/lifecycle'

describe('RevisionService', () => {
  // ============================================
  // Alpha Scheme (default)
  // ============================================

  describe('getNextRevision - alpha scheme', () => {
    it('returns A for empty revision', () => {
      expect(RevisionService.getNextRevision('')).toBe('A')
    })

    it('returns A for DRAFT revision', () => {
      expect(RevisionService.getNextRevision('DRAFT')).toBe('A')
    })

    it('returns A for dash revision', () => {
      expect(RevisionService.getNextRevision('-')).toBe('A')
    })

    it('returns A for dash-prefixed placeholder', () => {
      expect(RevisionService.getNextRevision('-abc12345')).toBe('A')
    })

    it('increments A to B', () => {
      expect(RevisionService.getNextRevision('A')).toBe('B')
    })

    it('increments Y to Z', () => {
      expect(RevisionService.getNextRevision('Y')).toBe('Z')
    })

    it('increments Z to AA', () => {
      expect(RevisionService.getNextRevision('Z')).toBe('AA')
    })

    it('increments AA to AB', () => {
      expect(RevisionService.getNextRevision('AA')).toBe('AB')
    })

    it('increments AZ to BA', () => {
      expect(RevisionService.getNextRevision('AZ')).toBe('BA')
    })

    it('increments ZZ to AAA', () => {
      expect(RevisionService.getNextRevision('ZZ')).toBe('AAA')
    })

    it('handles lowercase input', () => {
      expect(RevisionService.getNextRevision('a')).toBe('B')
    })

    it('defaults to alpha when no scheme provided', () => {
      expect(RevisionService.getNextRevision('A')).toBe('B')
      expect(RevisionService.getNextRevision('A', undefined)).toBe('B')
    })

    it('works with explicit alpha scheme', () => {
      const scheme: RevisionScheme = { type: 'alpha' }
      expect(RevisionService.getNextRevision('A', scheme)).toBe('B')
      expect(RevisionService.getNextRevision('Z', scheme)).toBe('AA')
    })
  })

  // ============================================
  // Numeric Scheme
  // ============================================

  describe('getNextRevision - numeric scheme', () => {
    const scheme: RevisionScheme = { type: 'numeric' }

    it('returns 1 for empty revision', () => {
      expect(RevisionService.getNextRevision('', scheme)).toBe('1')
    })

    it('returns 1 for DRAFT revision', () => {
      expect(RevisionService.getNextRevision('DRAFT', scheme)).toBe('1')
    })

    it('returns 1 for dash revision', () => {
      expect(RevisionService.getNextRevision('-', scheme)).toBe('1')
    })

    it('increments 1 to 2', () => {
      expect(RevisionService.getNextRevision('1', scheme)).toBe('2')
    })

    it('increments 99 to 100', () => {
      expect(RevisionService.getNextRevision('99', scheme)).toBe('100')
    })

    it('returns 1 for non-numeric input', () => {
      expect(RevisionService.getNextRevision('abc', scheme)).toBe('1')
    })
  })

  // ============================================
  // Prefixed-Numeric Scheme
  // ============================================

  describe('getNextRevision - prefixed-numeric scheme', () => {
    const scheme: RevisionScheme = { type: 'prefixed-numeric', prefix: 'X' }

    it('returns X1 for empty revision', () => {
      expect(RevisionService.getNextRevision('', scheme)).toBe('X1')
    })

    it('returns X1 for DRAFT revision', () => {
      expect(RevisionService.getNextRevision('DRAFT', scheme)).toBe('X1')
    })

    it('returns X1 for dash revision', () => {
      expect(RevisionService.getNextRevision('-', scheme)).toBe('X1')
    })

    it('increments X1 to X2', () => {
      expect(RevisionService.getNextRevision('X1', scheme)).toBe('X2')
    })

    it('increments X9 to X10', () => {
      expect(RevisionService.getNextRevision('X9', scheme)).toBe('X10')
    })

    it('handles multi-character prefix', () => {
      const protoScheme: RevisionScheme = {
        type: 'prefixed-numeric',
        prefix: 'PROTO-',
      }
      expect(RevisionService.getNextRevision('', protoScheme)).toBe('PROTO-1')
      expect(RevisionService.getNextRevision('PROTO-3', protoScheme)).toBe(
        'PROTO-4',
      )
    })

    it('returns prefix+1 for non-prefixed input', () => {
      expect(RevisionService.getNextRevision('abc', scheme)).toBe('X1')
    })
  })

  // ============================================
  // None Scheme
  // ============================================

  describe('getNextRevision - none scheme', () => {
    const scheme: RevisionScheme = { type: 'none' }

    it('returns empty string for empty revision', () => {
      expect(RevisionService.getNextRevision('', scheme)).toBe('')
    })

    it('returns current revision unchanged', () => {
      expect(RevisionService.getNextRevision('A', scheme)).toBe('A')
      expect(RevisionService.getNextRevision('5', scheme)).toBe('5')
      expect(RevisionService.getNextRevision('X2', scheme)).toBe('X2')
    })
  })

  // ============================================
  // getInitialRevision
  // ============================================

  describe('getInitialRevision', () => {
    it('returns A for alpha scheme (default)', () => {
      expect(RevisionService.getInitialRevision()).toBe('A')
      expect(RevisionService.getInitialRevision(undefined)).toBe('A')
      expect(RevisionService.getInitialRevision({ type: 'alpha' })).toBe('A')
    })

    it('returns 1 for numeric scheme', () => {
      expect(RevisionService.getInitialRevision({ type: 'numeric' })).toBe('1')
    })

    it('returns prefix+1 for prefixed-numeric scheme', () => {
      expect(
        RevisionService.getInitialRevision({
          type: 'prefixed-numeric',
          prefix: 'X',
        }),
      ).toBe('X1')
      expect(
        RevisionService.getInitialRevision({
          type: 'prefixed-numeric',
          prefix: 'PROTO-',
        }),
      ).toBe('PROTO-1')
    })

    it('returns empty string for none scheme', () => {
      expect(RevisionService.getInitialRevision({ type: 'none' })).toBe('')
    })
  })

  // ============================================
  // getResetRevision
  // ============================================

  describe('getResetRevision', () => {
    it('returns dash placeholder', () => {
      expect(RevisionService.getResetRevision()).toBe('-')
    })
  })
})
