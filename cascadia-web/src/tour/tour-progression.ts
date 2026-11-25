// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { defineProgression } from './progression/index'
import type {
  AnyProgressionPhase,
  TransitionEvidence,
} from './progression/index'

const tourGraph = {
  idle: { schedule: 'scheduled', start: 'starting', dispose: 'disposed' },
  scheduled: { start: 'starting', cancel: 'settling', dispose: 'disposed' },
  starting: { activate: 'active', cancel: 'settling', dispose: 'disposed' },
  active: { acknowledge: 'settling', cancel: 'settling', dispose: 'disposed' },
  settling: { finish: 'idle', dispose: 'disposed' },
  disposed: {},
} as const

export const tourProgression = defineProgression(tourGraph)
export type TourPhase = AnyProgressionPhase<typeof tourGraph>
export type TourAcknowledgement = TransitionEvidence<
  typeof tourGraph,
  'active',
  'acknowledge'
>
