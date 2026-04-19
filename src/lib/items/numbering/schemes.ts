import type { FamilyNumberingConfig, NumberingScheme } from './types'

/**
 * Default numbering schemes for each item type.
 *
 * These can be customized by modifying this file. Examples of alternative
 * configurations are shown in comments below.
 */
export const numberingSchemes: Record<string, NumberingScheme> = {
  // Simple: PN-000001
  Part: {
    segments: [
      { type: 'literal', value: 'PN' },
      { type: 'sequence', scope: 'global', padding: 6 },
    ],
    allowManualEntry: true,
  },

  // Design-scoped: WA-1001, MOTOR-0234
  // Part: {
  //   segments: [
  //     { type: 'design-code' },
  //     { type: 'sequence', scope: 'design', padding: 4, startAt: 1001 },
  //   ],
  // },

  // Category-based: ASM-000001, FAB-000001, PUR-000001
  // Part: {
  //   segments: [
  //     { type: 'lookup', field: 'partType', map: { 'Manufacture': 'MFG', 'Purchase': 'PUR' }, default: 'PRT' },
  //     { type: 'sequence', scope: 'prefix', padding: 6 },
  //   ],
  // },

  // Significant: M-AL-000001 (Part type code + Material code)
  // Part: {
  //   segments: [
  //     { type: 'lookup', field: 'partType', map: { 'Manufacture': 'M', 'Purchase': 'P' } },
  //     { type: 'lookup', field: 'material', map: {
  //       'Aluminum 6061': 'AL',
  //       'Steel': 'ST',
  //       'Plastic': 'PL',
  //       'Assembly': 'AS',
  //     }, default: 'XX' },
  //     { type: 'sequence', scope: 'prefix', padding: 6 },
  //   ],
  // },

  // Year-prefixed: 2024-000001 (resets yearly)
  // Part: {
  //   segments: [
  //     { type: 'date', format: 'YYYY' },
  //     { type: 'sequence', scope: 'yearly', padding: 6 },
  //   ],
  // },

  Document: {
    segments: [
      { type: 'literal', value: 'DOC' },
      { type: 'sequence', scope: 'global', padding: 6 },
    ],
    allowManualEntry: true,
  },

  ChangeOrder: {
    segments: [
      { type: 'literal', value: 'ECO' },
      { type: 'sequence', scope: 'global', padding: 6 },
    ],
    allowManualEntry: false, // ECOs always auto-numbered
  },

  Requirement: {
    segments: [
      { type: 'literal', value: 'REQ' },
      { type: 'sequence', scope: 'global', padding: 6 },
    ],
    allowManualEntry: true,
  },

  Task: {
    segments: [
      { type: 'literal', value: 'TSK' },
      { type: 'sequence', scope: 'global', padding: 6 },
    ],
    allowManualEntry: true,
  },

  TestPlan: {
    segments: [
      { type: 'literal', value: 'TP' },
      { type: 'sequence', scope: 'global', padding: 6 },
    ],
    allowManualEntry: true,
  },

  TestCase: {
    segments: [
      { type: 'literal', value: 'TC' },
      { type: 'sequence', scope: 'global', padding: 6 },
    ],
    allowManualEntry: true,
  },

  Issue: {
    segments: [
      { type: 'literal', value: 'ISS' },
      { type: 'sequence', scope: 'global', padding: 6 },
    ],
    allowManualEntry: true,
  },

  WorkInstruction: {
    segments: [
      { type: 'literal', value: 'WI' },
      { type: 'sequence', scope: 'global', padding: 6 },
    ],
    allowManualEntry: true,
  },

  Tool: {
    segments: [
      { type: 'literal', value: 'TOOL' },
      { type: 'sequence', scope: 'global', padding: 6 },
    ],
    allowManualEntry: true,
  },
}

/**
 * Family variant configuration per item type.
 * Enables creation of variants like PN-000001-001, PN-000001-002.
 */
export const familyNumberingConfig: Record<string, FamilyNumberingConfig> = {
  Part: {
    enabled: true,
    separator: '-',
    padding: 3,
  },
  Document: {
    enabled: false,
  },
  ChangeOrder: {
    enabled: false,
  },
  Requirement: {
    enabled: false,
  },
  Task: {
    enabled: false,
  },
  TestPlan: {
    enabled: false,
  },
  TestCase: {
    enabled: false,
  },
  Issue: {
    enabled: false,
  },
  WorkInstruction: {
    enabled: false,
  },
  Tool: {
    enabled: false,
  },
}
