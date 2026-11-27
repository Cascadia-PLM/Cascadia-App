// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { physical, rootRoute } from '@tanstack/virtual-file-routes'
// Relative, not the package alias: Vite loads this file before any path
// resolution plugin exists, so it must resolve as a plain filesystem import.
import { createAppViteConfig } from '../cascadia-web/vite.config.base'

const appDir = dirname(fileURLToPath(import.meta.url))

export default createAppViteConfig({
  appDir,
  appName: 'cascadia',
  // Searched after the web package when resolving `@/`. Commons is in the list
  // because module code addresses it the way the module tsconfigs declare —
  // `@/vault/preview` and the like — where web's own files name it. The api
  // is deliberately absent: the client cannot reach it from any package.
  moduleRoots: [
    resolve(appDir, '../cascadia-commons/src'),
    resolve(appDir, '../cascadia-design-engine/src'),
  ],
  virtualRouteConfig: rootRoute('__root.tsx', [
    // The web package's routes, then the modules'. Both are relative to the
    // routes directory, which is `cascadia-web/src/routes`. A missing
    // directory is a hard error rather than a skip.
    physical('', '.'),
    physical('', '../../../cascadia-design-engine/src/routes'),
  ]),
})
