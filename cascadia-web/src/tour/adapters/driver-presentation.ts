// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import { tourSteps } from '../tour-steps'
import type { TourPresentationFactory } from '../ports'

export const createDriverPresentation: TourPresentationFactory = (events) => {
  const instance = driver({
    showProgress: true,
    showButtons: ['next', 'previous', 'close'],
    steps: tourSteps,
    popoverClass: 'cascadia-tour-popover',
    overlayColor: 'rgba(0, 0, 0, 0.75)',
    stagePadding: 8,
    stageRadius: 8,
    animate: true,
    allowClose: true,
    doneBtnText: 'Get Started',
    nextBtnText: 'Next',
    prevBtnText: 'Previous',
    // Programmatic destroy bypasses Driver's user-dismissal hook.
    onDestroyStarted: events.onAcknowledge,
  })
  return { show: () => instance.drive(), destroy: () => instance.destroy() }
}
