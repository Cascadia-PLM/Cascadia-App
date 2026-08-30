// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Find documentation claims that were true when written and are not any more.
 *
 *   npm run docs:check-claims
 *
 * A doc that says "there are no committed migrations yet" is not wrong the day
 * it is written — it is wrong the day migrations land, and nothing about
 * shipping them touches the sentence. That is the whole failure mode: the claim
 * and the thing it describes live in different files, so the change that
 * falsifies it never opens the document. Twelve pages had rotted this way by
 * the time anyone swept them.
 *
 * This is a phrase grep, and it is honest about that. It cannot catch a novel
 * phrasing of the same claim, and it never will — the value is that the small
 * set of shapes that have *actually* rotted here get checked at every release
 * instead of at the next audit. Extending PATTERNS when a release turns up a
 * new shape is the intended way to use it.
 *
 * Deliberately not a CI gate. Phrase-grepping produces judgement calls
 * ("is this a claim or a historical record?"), and a gate that needs a human
 * verdict is a gate people learn to route around. It is a RELEASING.md step
 * instead, in the same spirit as the rest of that file: every step exists
 * because skipping it produced a specific, named failure. This one's is that
 * twelve-file rot.
 *
 * Only Markdown is scanned, and only tracked files. Prose in code comments rots
 * too, but it is read beside the code that contradicts it; a stale claim in the
 * docs is read by someone with nothing else to go on.
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const REPO = process.cwd()

/**
 * The version this tree currently claims, from the root manifest.
 *
 * The forward-version shape below is "a version ahead of this one". Deriving
 * the comparison point here is what keeps that shape from rotting itself: a
 * hard-coded `v0.6` would have been exactly the mistake it exists to catch.
 */
const CURRENT = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
  .version.split('.')
  .map(Number)

/** True when `line` names a release that sorts after the root manifest's. */
const namesFutureVersion = (line) => {
  for (const m of line.matchAll(/\bv(\d+)\.(\d+)(?:\.(\d+))?\b/g)) {
    const found = [m[1], m[2], m[3]].map((part) => Number(part ?? 0))
    for (let i = 0; i < 3; i++) {
      const a = found[i] ?? 0
      const b = CURRENT[i] ?? 0
      if (a === b) continue
      if (a > b) return true
      break
    }
  }
  return false
}

/**
 * Phrases that have gone stale here before.
 *
 * Each is a shape, not a specific sentence: `no committed migrations` catches
 * the plural and singular, `as of v0.N` catches every future release's version
 * stamp. Keep them narrow enough that a hit is worth reading — a pattern that
 * matches ordinary prose trains people to skim the output.
 */
const PATTERNS = [
  {
    pattern: /pre-1\.0/i,
    why: 'a claim about a version horizon; check it still describes where the product is',
  },
  {
    pattern: /no committed migrations?/i,
    why: 'migrations have shipped since v0.5.0 — this was true only before that',
  },
  {
    pattern: /as of v0\.\d/i,
    why: 'a version stamp; check the statement is still true at the current version',
  },
  {
    pattern: /spike stage/i,
    why: 'spikes graduate; check whether the thing described has shipped',
  },
  {
    // Only a version in a release-event construction — "the v0.5.1 upgrade",
    // "at v0.6.0". Matching a bare version token instead swept up library
    // versions (`Three.js (v0.182)`), licence versions (`AGPL v3.0`) and
    // branch-name examples (`release/v1.0`), which is the skimming the note
    // above warns about.
    pattern:
      /\b(?:the|at|in|since|until|before|after|as of|for)\s+`?v\d+\.\d+(?:\.\d+)?`?/i,
    onlyBeyondCurrent: true,
    why: 'names a release ahead of this tree; check it is still the version this work ships in. The roadmap reassigns these numbers, and nothing reopens the sentence that used one: the remediation notes called this release v0.6.0 while the public roadmap gave v0.6 to the event bus',
  },
]

/**
 * Legitimate mentions, as `[file, pattern source, why]`.
 *
 * Matched on file and pattern rather than line number, so an entry survives the
 * document being edited around it. Every entry needs a written reason — the
 * point of the list is that a reader can tell an accepted hit from an
 * un-triaged one without re-deriving the decision.
 */
const ALLOW = [
  [
    'CHANGELOG.md',
    'pre-1\\.0',
    'historical record: a released changelog entry describes the state at its release',
  ],
  [
    'publish/CHANGELOG.md',
    'pre-1\\.0',
    'historical record, same as the private changelog',
  ],
  [
    'RELEASING.md',
    'pre-1\\.0',
    'live statement of the versioning policy, not a claim about a feature',
  ],
  [
    'docs/deployment/upgrading.md',
    'as of v0\\.\\d',
    'provenance: names the release that introduced migration files, which does not change',
  ],
]

const allowed = (file, pattern) =>
  ALLOW.some(([f, p]) => f === file && p === pattern.source)

const tracked = execFileSync('git', ['ls-files', '*.md'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  cwd: REPO,
})
  .split('\n')
  .filter(Boolean)
  .map((p) => p.replace(/\\/g, '/'))

const hits = []

for (const file of tracked) {
  const lines = readFileSync(join(REPO, file), 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const { pattern, why, onlyBeyondCurrent } of PATTERNS) {
      if (!pattern.test(line)) continue
      if (onlyBeyondCurrent && !namesFutureVersion(line)) continue
      if (allowed(file, pattern)) continue
      hits.push({ file, line: i + 1, text: line.trim(), why })
    }
  })
}

console.log(
  `Scanned ${tracked.length} tracked Markdown files in ${REPO} for ${PATTERNS.length} claim shapes`,
)

if (hits.length === 0) {
  console.log('\n✅ No stale-claim phrases outside the allow list.')
  process.exit(0)
}

const byFile = new Map()
for (const h of hits) {
  const list = byFile.get(h.file)
  if (list) list.push(h)
  else byFile.set(h.file, [h])
}

console.error(
  `\n✗ ${hits.length} claim(s) to check in ${byFile.size} file(s):\n`,
)
for (const [file, found] of byFile) {
  console.error(`   ${file}`)
  for (const h of found) {
    console.error(`      :${h.line}  ${h.text.slice(0, 100)}`)
    console.error(`             ${h.why}`)
  }
}
console.error(
  '\nEach hit is a question, not a verdict: is this sentence still true?\n' +
    '\nThree ways out:\n' +
    '  Fix     rewrite the claim to describe what is true now — the usual answer\n' +
    '  ALLOW   add [file, pattern, why] to the list in this script, with a real\n' +
    '          reason. Historical records (changelog entries) and provenance\n' +
    '          stamps belong here; "I looked and it seemed fine" does not\n' +
    '  Delete  the claim was scaffolding and has served its purpose\n' +
    '\nIf a release turns up a stale claim this script did not catch, add its\n' +
    'shape to PATTERNS. Under-matching is the known limit, not a bug.\n',
)
process.exit(1)
