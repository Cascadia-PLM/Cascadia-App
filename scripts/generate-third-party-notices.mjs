// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Produce the attribution that MIT, ISC, BSD and Apache-2.0 ask for in exchange
 * for the right to redistribute them.
 *
 *   node scripts/generate-third-party-notices.mjs            # to stdout
 *   node scripts/generate-third-party-notices.mjs --out FILE
 *
 * Nearly every dependency in the tree is permissive, and permissive is not the
 * same as free of conditions: MIT, ISC and BSD each require that the copyright
 * notice and permission text travel with the copies you hand out, and
 * Apache-2.0 section 4(d) additionally requires carrying forward any NOTICE
 * file the project ships. That is one condition, and until this existed we were
 * not meeting it for ~760 packages.
 *
 * "The licence text is in node_modules inside the image" is not the same thing.
 * It is an argument for the server image, where the tree really is present, and
 * no argument at all for the SPA bundle, which Vite strips of comments so that
 * no licence text survives in what the browser is served. So this writes one
 * file per artifact instead, listing every package we convey, and the build
 * puts it where each artifact can reach it.
 *
 * **Reads the installed tree, not just the lockfile.** Attribution is the
 * *text* — the copyright lines naming the actual authors — and only the
 * installed package carries it. The lockfile decides the set (via
 * `third-party-closure.mjs`, shared with the licence gate so the two cannot
 * disagree about what we ship); `node_modules` supplies the words. Run it after
 * `npm ci`, which is what the Docker builds and CI already do.
 *
 * Deduplicated by name and version: the tree holds `safe-buffer@5.1.2` at five
 * different paths, and one credit per distinct package is what the licences
 * ask for. Two *different* versions stay two entries — they are different code
 * with, potentially, different copyright years.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { distributedPackages } from './third-party-closure.mjs'

/**
 * Filenames a package might use for its licence, matched case-insensitively.
 *
 * Deliberately a prefix match rather than an exact list: `LICENSE-MIT`,
 * `LICENSE.APACHE2` and `COPYING.LESSER` are all real, and a package that
 * splits its terms across two files needs both conveyed, not whichever one an
 * exact list happened to name.
 */
const LICENCE_PREFIXES = ['license', 'licence', 'copying', 'unlicense']

/** Apache-2.0 section 4(d): a NOTICE file must be carried forward verbatim. */
const NOTICE_PREFIXES = ['notice']

/** A NUL byte marks a file as binary rather than text. */
const NUL = String.fromCharCode(0)

function licenceFiles(dir, prefixes) {
  if (!existsSync(dir)) return []
  const found = []
  for (const name of readdirSync(dir)) {
    const lower = name.toLowerCase()
    if (!prefixes.some((p) => lower.startsWith(p))) continue
    try {
      const text = readFileSync(join(dir, name), 'utf8')
      // Some packages ship a `license` binary or an image under that name;
      // pasting one into the notice file would corrupt it.
      if (text.includes(NUL)) continue
      found.push({ name, text: text.replace(/\r\n/g, '\n').trimEnd() })
    } catch {
      // A directory (some packages ship a `licenses/` folder), a broken
      // symlink, or an unreadable file. Not fatal: the package still gets an
      // entry, recording that no text was distributed with it.
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

function manifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
}

/** Where a reader can get this package's source, best effort. */
function sourceUrl(pkg) {
  const repo = pkg.repository
  const raw = typeof repo === 'string' ? repo : (repo?.url ?? null)
  if (!raw) return pkg.homepage ?? null
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
}

/**
 * Fall back to the parent project for a per-platform binary sub-package.
 *
 * `lightningcss-linux-x64-gnu` is built from `lightningcss`, and most such
 * packages ship a bare manifest with no `repository` at all. That is merely
 * untidy for a permissive package, but for the MPL-2.0 ones it is the source
 * we owe a recipient — 11 of the 12 MPL entries had no URL before this, and
 * "source URL not declared" is a poor answer to an obligation.
 *
 * Strips one trailing `-segment` at a time and takes the first ancestor that
 * is itself in the closure, so the answer is always a package we actually
 * ship rather than a guessed name.
 */
function inheritedSourceUrl(name, urlByName) {
  let candidate = name
  while (candidate.includes('-')) {
    candidate = candidate.slice(0, candidate.lastIndexOf('-'))
    const url = urlByName.get(candidate)
    if (url) return url
  }
  return null
}

function rule(char = '-', width = 78) {
  return char.repeat(width)
}

/**
 * Render the notice file.
 *
 * `packages` defaults to the distributed closure; passing it explicitly is what
 * lets a caller render notices for a subset without re-deriving the rule for
 * what counts as distributed.
 */
export function render({
  packages = distributedPackages(),
  edition = null,
} = {}) {
  const seen = new Set()
  const entries = []
  const noText = []
  const tally = {}
  const urlByName = new Map()

  for (const p of packages) {
    const key = `${p.name}@${p.version ?? '?'}`
    if (seen.has(key)) continue
    seen.add(key)

    const meta = manifest(p.path)
    const declared = p.license ?? meta.license ?? 'UNKNOWN'
    const texts = licenceFiles(p.path, LICENCE_PREFIXES)
    const notices = licenceFiles(p.path, NOTICE_PREFIXES)
    const url = sourceUrl(meta)
    if (url) urlByName.set(p.name, url)

    tally[declared] = (tally[declared] ?? 0) + 1
    if (texts.length === 0) noText.push({ key, declared })

    entries.push({ key, name: p.name, declared, url, texts, notices })
  }

  // Second pass: a per-platform sub-package inherits its parent's source URL.
  // Needs every package's own URL collected first, which is why it is not
  // folded into the loop above.
  for (const e of entries) {
    e.url ??= inheritedSourceUrl(e.name, urlByName)
  }

  const weak = entries.filter((e) => /MPL|LGPL/i.test(e.declared))

  // A notice file listing 800 packages and quoting none of them is the
  // dangerous failure: it looks like attribution, ships like attribution, and
  // credits nobody. It is what you get by running this against an absent or
  // half-installed tree, since every lookup then misses and every miss is
  // individually survivable.
  //
  // So assert on content, the way `assertStyled` in build-app.mjs does for a
  // stylesheet that builds but contains no utilities. 85% of packages carry
  // licence text on a healthy tree; the rest are per-platform binaries that
  // genuinely ship none. Half is far below anything a real install produces
  // and far above the zero an empty one does.
  const withText = entries.length - noText.length
  if (entries.length > 0 && withText / entries.length < 0.5) {
    throw new Error(
      `Only ${withText} of ${entries.length} packages yielded licence text. ` +
        'node_modules looks absent or incomplete — run `npm ci` first. ' +
        'Shipping a notice file that credits nobody would be worse than ' +
        'shipping none.',
    )
  }

  const out = []
  const push = (...lines) => out.push(...lines)

  push(
    rule('='),
    'THIRD-PARTY SOFTWARE NOTICES',
    rule('='),
    '',
    edition ? `Edition: ${edition}` : null,
    `This product includes ${entries.length} third-party software packages.`,
    '',
    'Each package below is listed with its version, its declared licence, and',
    'the licence text as that package distributes it. Those texts are the',
    'copyright holders own, and they are reproduced here to satisfy the',
    'attribution condition that MIT, ISC, BSD and Apache-2.0 place on',
    'redistribution. Apache-2.0 NOTICE files are reproduced verbatim and',
    'labelled as such.',
    '',
    'Nothing in this file changes the licence of any package it lists, and',
    'nothing in it grants rights in Cascadia itself.',
    '',
    'Generated by scripts/generate-third-party-notices.mjs from the installed',
    'dependency tree. Do not edit by hand.',
    '',
  )

  push(rule(), 'SUMMARY BY LICENCE', rule(), '')
  for (const [lic, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    push(`  ${String(n).padStart(4)}  ${lic}`)
  }
  push('')

  if (weak.length > 0) {
    push(
      rule(),
      'COMPONENTS UNDER MPL-2.0 OR LGPL - SOURCE AVAILABILITY',
      rule(),
      '',
      'These components are copyleft at the file or library level. They are',
      'included unmodified, and their licences entitle you to their source.',
      'Source for each is available at the URL below; where a package ships',
      'prebuilt binaries, that URL is the project the binaries are built from.',
      '',
      'You may also obtain the corresponding source for any component in this',
      'section, on a medium customarily used for software interchange, by',
      'written request to info@cascadiaplm.com.',
      '',
    )
    for (const w of weak) {
      push(`  ${w.key}  (${w.declared})`)
      push(`      ${w.url ?? 'source URL not declared by the package'}`)
    }
    push('')
  }

  if (noText.length > 0) {
    push(
      rule(),
      'PACKAGES DISTRIBUTING NO LICENCE FILE',
      rule(),
      '',
      'These packages declare a licence in their metadata but ship no licence',
      'file of their own. The declared identifier governs; the canonical text',
      'for each is published by SPDX at https://spdx.org/licenses/.',
      '',
    )
    for (const n of noText) push(`  ${n.key}  - declared ${n.declared}`)
    push('')
  }

  push(rule('='), 'PACKAGES', rule('='), '')

  for (const e of entries) {
    push(rule(), e.key, `Licence: ${e.declared}`)
    if (e.url) push(`Source:  ${e.url}`)
    push(rule(), '')
    for (const t of e.texts) {
      if (e.texts.length > 1) push(`--- ${t.name} ---`, '')
      push(t.text, '')
    }
    for (const n of e.notices) {
      push(
        `--- NOTICE (${n.name}), reproduced per Apache-2.0 section 4(d) ---`,
        '',
      )
      push(n.text, '')
    }
    if (e.texts.length === 0 && e.notices.length === 0) {
      push(
        `No licence file is distributed with this package. Declared licence: ${e.declared}.`,
        '',
      )
    }
  }

  return out.filter((l) => l !== null).join('\n')
}

// -- CLI ---------------------------------------------------------------------

if (process.argv[1]?.endsWith('generate-third-party-notices.mjs')) {
  const outIndex = process.argv.indexOf('--out')
  let text
  try {
    text = render()
  } catch (error) {
    // An incomplete tree is the expected way to get here, and a stack trace
    // buries the one sentence that says what to do about it.
    console.error(`\n✗ ${error.message}\n`)
    process.exit(1)
  }
  const target = outIndex === -1 ? null : process.argv[outIndex + 1]
  if (target) {
    writeFileSync(target, `${text}\n`, 'utf8')
    console.log(
      `Wrote ${target} (${Math.round(Buffer.byteLength(text) / 1024)} KB)`,
    )
  } else {
    process.stdout.write(`${text}\n`)
  }
}
