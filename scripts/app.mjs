// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The app this repository builds — one, `cascadia`.
 *
 * Its composition root and build config live in `cascadia-app/`. The *name*
 * namespaces the build output (`dist/cascadia/`, `.output/cascadia/`); the
 * *directory* is where the sources are. Every root script that needs either
 * reads it here rather than spelling it out.
 */

/** The app's name, as it appears in build output paths. */
export const APP = 'cascadia'

/** The workspace directory holding the composition roots and build config. */
export const APP_DIR = 'cascadia-app'

/**
 * The tsconfig to run the app's code under, for tsx.
 *
 * tsx resolves `paths` from the tsconfig nearest the working directory — the
 * root one, when a script runs from the repo root — and the root tsconfig maps
 * `@/` across the application packages only. Module code
 * (`cascadia-design-engine`) imports its own files through `@/`, which only the
 * app's tsconfig maps. Anything that loads the composition roots — the dev
 * server, the jobs worker, the schema re-export, the OpenAPI snapshot —
 * therefore runs under `tsx --tsconfig` this file. Vite and esbuild already
 * read the same one (scripts/build-app.mjs). See scripts/app-tsx.mjs.
 */
export const APP_TSCONFIG = `${APP_DIR}/tsconfig.json`
