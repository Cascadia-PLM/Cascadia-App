// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { physical, rootRoute } from '@tanstack/virtual-file-routes'
// Relative, not the package alias: Vite loads this file before any path
// resolution plugin exists, so it must resolve as a plain filesystem import.
import { createAppViteConfig } from '../../packages/core/vite.config.base'

const appDir = dirname(fileURLToPath(import.meta.url))

export default createAppViteConfig({
  appDir,
  // Core's routes and nothing else. The enterprise sibling adds one more line.
  virtualRouteConfig: rootRoute('__root.tsx', [physical('', '.')]),
})
