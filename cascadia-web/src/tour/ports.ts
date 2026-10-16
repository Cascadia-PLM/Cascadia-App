// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { TourAcknowledgement } from './tour-progression'

export interface TourPresentation {
  show: () => void
  destroy: () => void
}

export type TourPresentationFactory = (events: {
  onAcknowledge: () => void
}) => TourPresentation

export interface TourCompletionStore {
  isCompleted: () => boolean
  record: (acknowledgement: TourAcknowledgement) => void
  clear: () => void
  isAutomaticStartSuppressed: () => boolean
}

export interface TourSnapshot {
  hasCompletedTour: boolean
  isTourActive: boolean
}

export interface TourPorts {
  presentation: TourPresentationFactory
  completion: TourCompletionStore
  onChange: (snapshot: TourSnapshot) => void
  onError: (error: unknown) => void
}
