// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { APP_VERSION } from '@cascadia/commons/lib/version'
import {
  BUILD_DIRTY,
  BUILD_LABEL,
  BUILD_SHA,
  BUILD_TAG,
} from '@/lib/build-info'

/**
 * Which build is deployed, at the foot of the sidebar.
 *
 * The admin System card already shows `APP_VERSION`, but that is the upstream
 * release number and it does not move when this fork rebuilds — so it cannot
 * answer "did my deploy actually land?". The tag and commit can, and putting
 * them on every page means answering it does not need admin rights.
 *
 * Collapsed, there is 64px to work with, so only the commit is shown: it is
 * the half that changes between builds. Both states carry the full detail in
 * the tooltip, and the text is `select-all` so it can be clicked once and
 * pasted into a bug report.
 */
export function BuildStamp({ isOpen }: { isOpen: boolean }) {
  const title = [
    `Cascadia ${APP_VERSION}`,
    `build ${BUILD_TAG}`,
    BUILD_SHA && `commit ${BUILD_SHA}`,
    BUILD_DIRTY && 'built from a tree with uncommitted changes',
  ]
    .filter(Boolean)
    .join(' — ')

  return (
    <div
      className={`shrink-0 border-t border-gray-300 dark:border-gray-700 ${
        isOpen ? 'px-4 py-2' : 'px-1 py-2'
      }`}
    >
      <p
        className={`select-all truncate font-mono text-[11px] leading-none text-gray-500 dark:text-gray-500 ${
          isOpen ? '' : 'text-center'
        }`}
        title={title}
        data-testid="build-stamp"
      >
        {isOpen ? BUILD_LABEL : BUILD_SHA || BUILD_TAG}
      </p>
    </div>
  )
}
