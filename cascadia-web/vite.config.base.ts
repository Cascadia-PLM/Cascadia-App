// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { fileURLToPath } from 'node:url'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import type { Plugin } from 'vite'
import type { VirtualRootRoute } from '@tanstack/virtual-file-routes'

const WEB_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(WEB_DIR, '../..')
const PACKAGES_DIR = resolve(REPO_ROOT, 'packages')

/**
 * The application packages the client may import, by name.
 *
 * `@cascadia/web` is this package. `@cascadia/commons` is what the client may
 * share with the server. `@cascadia/api` is deliberately **absent**: the
 * client build has no way to resolve it, so a component that reaches for a
 * service or the schema fails at build time rather than shipping `postgres`
 * to the browser. (The app tsconfigs draw the same line for `tsc`.)
 */
const APP_PACKAGES = new Map([
  ['@cascadia/web', resolve(WEB_DIR, 'src')],
  ['@cascadia/commons', resolve(PACKAGES_DIR, 'cascadia-commons/src')],
])
const APP_PACKAGE_DIRS = new Set([
  'cascadia-web',
  'cascadia-commons',
  'cascadia-api',
])

// Discovered, not named: writing a module package's id here would put
// proprietary knowledge in a core file — `boundary:check` says so, and it is
// right, because this file is published to a tree where those packages do not
// exist. Presence on disk is the test instead, the same principle as
// `scripts/workers.mjs` choosing its CAD services by `existsSync`: a directory
// that is not there contributes nothing, with no flag to get wrong.
const MODULE_PACKAGES = existsSync(PACKAGES_DIR)
  ? readdirSync(PACKAGES_DIR).filter(
      (name) =>
        !APP_PACKAGE_DIRS.has(name) &&
        existsSync(resolve(PACKAGES_DIR, name, 'src')),
    )
  : []
const MODULE_SRC = new Map(
  MODULE_PACKAGES.map((p) => [
    `@cascadia/${p}`,
    resolve(PACKAGES_DIR, p, 'src'),
  ]),
)

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.css', '.json']

/** An absolute path with forward slashes, for APIs that expect a glob. */
const posixPath = (...segments: Array<string>) =>
  resolve(...segments).replace(/\\/g, '/')

/**
 * Resolve `@/`, `@cascadia/web/`, `@cascadia/commons/` and each
 * `@cascadia/<module>/` against the package roots this edition includes.
 *
 * Written out rather than delegating to `vite-tsconfig-paths` because that
 * plugin scopes each mapping to its tsconfig's `include`, and web's tsconfig
 * deliberately excludes `src/routes/**` — those files are typed through an
 * app's generated route tree. Bundler resolution and typecheck scope are
 * different questions, and tying them together silently drops the alias inside
 * every route file.
 *
 * `@/` tries each root in order, exactly as the `paths` arrays in the app
 * tsconfigs do: web first, then the module package if this edition has one.
 *
 * `@cascadia/api/` is refused outright rather than left unresolved: an
 * unresolved bare specifier is a generic Vite error three screens long, and
 * the fix — move the type to commons — is not something it can suggest.
 */
function cascadiaAliases(roots: Array<string>): Plugin {
  const firstExisting = (root: string, rest: string) => {
    const base = resolve(root, rest)
    const candidates = [
      base,
      ...EXTENSIONS.map((ext) => base + ext),
      ...['.ts', '.tsx'].map((ext) => resolve(base, `index${ext}`)),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate) && statSync(candidate).isFile())
        return candidate
    }
    return null
  }

  return {
    name: 'cascadia-aliases',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@cascadia/api' || source.startsWith('@cascadia/api/')) {
        this.error(
          `${importer ?? 'a client file'} imports ${source}. The client ` +
            'bundle cannot reach @cascadia/api: a type the client needs ' +
            'belongs in @cascadia/commons, and behaviour belongs behind an ' +
            'endpoint.',
        )
      }

      let rest: string | null = null
      let search = roots
      if (source.startsWith('@/')) {
        rest = source.slice(2)
      } else {
        for (const [name, dir] of [...APP_PACKAGES, ...MODULE_SRC]) {
          const prefix = `${name}/`
          if (source.startsWith(prefix)) {
            rest = source.slice(prefix.length)
            search = [dir]
            break
          }
        }
      }
      if (rest === null) return null

      for (const root of search) {
        const hit = firstExisting(root, rest)
        if (hit) return hit
      }
      return null
    },
  }
}

export interface AppViteOptions {
  /** Absolute path to the app directory (its `index.html` lives here). */
  appDir: string
  /**
   * Extra package source roots this edition includes, searched after web when
   * resolving `@/`. Empty for the community edition — which is what makes its
   * bundle unable to reach module code even by accident.
   */
  moduleRoots?: Array<string>
  /**
   * How this edition's route tree is assembled.
   *
   * The one thing that genuinely differs between editions on the client: which
   * directories are scanned for route files. See "Client route composition" in
   * `docs/architecture/loadable-modules-architecture.md`.
   */
  virtualRouteConfig: VirtualRootRoute
}

/**
 * The shared Vite configuration, parameterized by edition.
 *
 * Everything here is identical across editions; an app supplies only its own
 * directory and its route composition. Paths that reach outside the app — the
 * pdf.js assets below — are resolved from the repo root rather than the Vite
 * root, because the Vite root is now the app rather than the repository.
 */
export function createAppViteConfig({
  appDir,
  virtualRouteConfig,
  moduleRoots = [],
}: AppViteOptions) {
  return defineConfig({
    root: appDir,
    envDir: REPO_ROOT,
    plugins: [
      cascadiaAliases([resolve(WEB_DIR, 'src'), ...moduleRoots]),
      tailwindcss(),
      // The routes *directory* is the web package's — every edition shares
      // its pages and its `__root.tsx`. The generated *tree* is the app's,
      // because which extra directories get scanned is the edition's business.
      TanStackRouterVite({
        routesDirectory: resolve(WEB_DIR, 'src/routes'),
        generatedRouteTree: resolve(appDir, 'src/routeTree.gen.ts'),
        virtualRouteConfig,
      }),
      viteReact(),
      // pdf.js loads character maps and the Base-14 font data at runtime rather
      // than bundling them. Served from our own origin, not a CDN, so the PDF
      // viewer works in air-gapped deployments. Paths must stay in step with
      // PDFJS_OPTIONS in packages/cascadia-web/src/components/vault/PdfViewer.tsx.
      viteStaticCopy({
        // stripBase flattens the node_modules/... prefix off the matched paths;
        // without it the files land under dist/pdfjs/cmaps/node_modules/...
        //
        // `src` is a glob, and globs are forward-slash only — a Windows path
        // from `resolve()` silently matches nothing. These used to be relative
        // to the Vite root; the root is now the app, so they are absolute and
        // must be normalized.
        targets: [
          {
            src: posixPath(REPO_ROOT, 'node_modules/pdfjs-dist/cmaps/*'),
            dest: 'pdfjs/cmaps',
            rename: { stripBase: true },
          },
          {
            src: posixPath(
              REPO_ROOT,
              'node_modules/pdfjs-dist/standard_fonts/*',
            ),
            dest: 'pdfjs/standard_fonts',
            rename: { stripBase: true },
          },
        ],
      }),
    ],
    publicDir: resolve(REPO_ROOT, 'public'),
    build: { outDir: resolve(REPO_ROOT, 'dist', appDir.split(/[\\/]/).pop()!) },
    server: {
      port: 3000,
      // Fail if 3000 is taken instead of silently taking the next free port —
      // which is 3001, the API's. A second Vite there binds [::1]:3001, and on
      // Windows that specific-address bind beats the API's [::] wildcard, so it
      // then proxies /api to itself. The loop dies as an ENOBUFS AggregateError
      // from the proxy, which reads nothing like "your other dev server is
      // still running". Better to refuse to start.
      strictPort: true,
      proxy: {
        // Proxy API requests to the Hono server in dev mode.
        // Keep the original Host header (localhost:3000) so Hono's CSRF
        // origin check sees the same origin the browser sent. (changeOrigin
        // stays false, so naming the target by IP below does not affect it.)
        //
        // 127.0.0.1, not localhost: on Windows `localhost` resolves ::1 first,
        // so any stray IPv6 listener on 3001 intercepts the proxy target ahead
        // of the real API.
        // `API_PORT` so the pair can move together — see CLIENT_PORT in
        // scripts/dev.mjs. Hardcoding both is what limited the machine to one
        // running checkout.
        '/api': {
          target: `http://127.0.0.1:${process.env.API_PORT ?? '3001'}`,
        },
      },
    },
  })
}
