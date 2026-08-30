// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Assert the invariant the dual licence rests on: **no third-party dependency
 * obliges us to publish source we sell.**
 *
 *   npm run license:thirdparty
 *
 * Cascadia is dual licensed: the same dependency closure ships under AGPL-3.0
 * and under a commercial licence. Those two editions pull in opposite
 * directions, and a single dependency can break either one:
 *
 *   - A **strong-copyleft** dependency (GPL, AGPL, SSPL) is fatal to the
 *     commercial edition. Linking it into the product would oblige us to offer
 *     the proprietary modules' source to every customer, which is precisely the
 *     thing being sold. It also breaks the *dual* grant: we can relicense our
 *     own copyright at will, never a third party's.
 *   - A **GPL-2.0-only** dependency is fatal to the AGPL edition too, in the
 *     other direction — GPLv2-only and AGPLv3 cannot be combined at all.
 *
 * So the gate is deliberately edition-blind: anything that fails for either
 * edition fails here. That is not over-caution, it is the shape of the tree —
 * every third-party dependency is declared in the root manifest rather than in
 * the workspace that uses it, so one closure serves whatever is built from it.
 *
 * **Unknown is a failure, not a pass.** A package with no `license` field
 * grants nothing — the default is exclusive copyright, so redistributing it is
 * unlicensed copying regardless of how permissive the author meant to be. Two
 * such packages are in the tree today; both are recorded in ACKNOWLEDGED with
 * the evidence that settled them. A *new* one stops CI.
 *
 * Dual-licensed dependencies ("MIT OR GPL-3.0-or-later") are resolved by
 * election: we take the permissive disjunct and print which, because an
 * election is a decision someone made and unrecorded decisions get re-litigated
 * or, worse, silently reversed by a version bump.
 *
 * Scope: the npm closure only. The Python worker images carry an LGPL surface
 * (pythonocc-core, OpenCASCADE, psycopg, casadi) that conda resolves at build
 * time and no lockfile records, so this gate cannot enforce it.
 */

import { devOnlyCount, distributedPackages } from './third-party-closure.mjs'

/**
 * Licence policy.
 *
 * `agpl` — may we ship it inside the AGPL-3.0 edition (inbound compatibility)?
 * `prop` — may we ship it inside the commercial edition without any obligation
 *          to disclose *our* source?
 *
 * A licence absent from this table is unknown, and unknown fails. Adding a row
 * is the deliberate act of deciding what a licence means for both editions.
 */
const POLICY = {
  // ── permissive: attribution only, safe in both editions ──────────────────
  '0BSD': { tier: 'permissive', agpl: true, prop: true },
  'Apache-2.0': { tier: 'permissive', agpl: true, prop: true },
  'BSD-2-Clause': { tier: 'permissive', agpl: true, prop: true },
  'BSD-3-Clause': { tier: 'permissive', agpl: true, prop: true },
  'BlueOak-1.0.0': { tier: 'permissive', agpl: true, prop: true },
  'CC0-1.0': { tier: 'public-domain', agpl: true, prop: true },
  ISC: { tier: 'permissive', agpl: true, prop: true },
  MIT: { tier: 'permissive', agpl: true, prop: true },
  'MIT-0': { tier: 'permissive', agpl: true, prop: true },
  // Legacy npm spelling of the MIT/X11 licence, from before SPDX ids.
  'MIT/X11': { tier: 'permissive', agpl: true, prop: true },
  'Python-2.0': { tier: 'permissive', agpl: true, prop: true },
  Unlicense: { tier: 'public-domain', agpl: true, prop: true },
  Zlib: { tier: 'permissive', agpl: true, prop: true },

  // Attribution-only, but a *content* licence rather than a software one: it
  // has no patent or warranty language and its attribution clause is stricter
  // than MIT's. Fine for the browser-support data it covers; a red flag if it
  // ever shows up on actual code.
  'CC-BY-4.0': { tier: 'attribution-data', agpl: true, prop: true },

  // ── weak copyleft: shippable in both, but with live obligations ──────────
  // File-level. Distributing it unmodified inside an image obliges us to say
  // where the source is; it never reaches our own files. §3.3 explicitly
  // permits combination into a (A)GPL work, so the AGPL edition is fine too.
  'MPL-2.0': { tier: 'weak-copyleft', agpl: true, prop: true },
  // Library-level. Safe for the commercial edition only while the library stays
  // replaceable by the user (unmodified, dynamically loaded) and we convey its
  // licence and source offer. LGPL-3.0 is GPL-3.0 plus permissions, so it flows
  // into the AGPL edition without friction.
  'LGPL-2.1-only': { tier: 'weak-copyleft', agpl: true, prop: true },
  'LGPL-2.1-or-later': { tier: 'weak-copyleft', agpl: true, prop: true },
  'LGPL-3.0-only': { tier: 'weak-copyleft', agpl: true, prop: true },
  'LGPL-3.0-or-later': { tier: 'weak-copyleft', agpl: true, prop: true },

  // ── strong copyleft: named so the failure message can explain itself ─────
  // GPL-2.0-only is the one that fails *both* editions: it is incompatible with
  // AGPL-3.0 in either direction, so it cannot even be taken as the copyleft
  // half of a dual-licensed dependency.
  'GPL-2.0-only': { tier: 'strong-copyleft', agpl: false, prop: false },
  'GPL-2.0': { tier: 'strong-copyleft', agpl: false, prop: false },
  'GPL-2.0-or-later': { tier: 'strong-copyleft', agpl: true, prop: false },
  'GPL-3.0-only': { tier: 'strong-copyleft', agpl: true, prop: false },
  'GPL-3.0': { tier: 'strong-copyleft', agpl: true, prop: false },
  'GPL-3.0-or-later': { tier: 'strong-copyleft', agpl: true, prop: false },
  'AGPL-3.0-only': { tier: 'network-copyleft', agpl: true, prop: false },
  'AGPL-3.0': { tier: 'network-copyleft', agpl: true, prop: false },
  'AGPL-3.0-or-later': { tier: 'network-copyleft', agpl: true, prop: false },
  'SSPL-1.0': { tier: 'network-copyleft', agpl: false, prop: false },
  'EUPL-1.2': { tier: 'strong-copyleft', agpl: false, prop: false },
  'OSL-3.0': { tier: 'strong-copyleft', agpl: false, prop: false },
  'CPAL-1.0': { tier: 'strong-copyleft', agpl: false, prop: false },
}

/**
 * Packages that carry no usable `license` field, with the evidence that
 * settled them.
 *
 * Entries are keyed `name@version`, so a version bump re-opens the question
 * rather than inheriting a finding made about different code. Stale entries are
 * reported: a list nobody prunes is a list nobody trusts.
 */
const ACKNOWLEDGED = {
  'buffers@0.1.1': {
    elect: 'MIT',
    why:
      'substack/node-buffers. No `license` field in the published metadata. ' +
      'Reached only via exceljs -> unzipper -> binary. Redistributed with no ' +
      'express grant; treated as MIT on the author’s uniform practice, ' +
      'which is inference, not a licence. Tracked for removal with exceljs.',
  },
  'webgl-constants@1.1.1': {
    elect: 'MIT',
    why:
      'No `license` field in the registry metadata and no repository URL to ' +
      'check. Reached only via @react-three/drei -> detect-gpu. Same standing ' +
      'as buffers: redistributed on inference rather than on a grant.',
  },
}

/** Elections we make on dual-licensed dependencies, and why. */
const ELECTIONS = {
  'node-forge': {
    take: 'BSD-3-Clause',
    over: 'GPL-2.0',
    why:
      'The GPL-2.0 half would fail both editions at once — it is ' +
      'incompatible with AGPL-3.0 as well as with commercial distribution.',
  },
  jszip: {
    take: 'MIT',
    over: 'GPL-3.0-or-later',
    why: 'The GPL-3.0 half would oblige us to disclose the commercial modules.',
  },
}

/** Split an SPDX-ish expression into its top-level operator and operands. */
function parseExpression(raw) {
  const expr = raw
    .trim()
    .replace(/^\((.*)\)$/s, '$1')
    .trim()
  if (/\sOR\s/i.test(expr)) {
    return { op: 'OR', parts: expr.split(/\s+OR\s+/i).map((s) => s.trim()) }
  }
  if (/\sAND\s/i.test(expr)) {
    return { op: 'AND', parts: expr.split(/\s+AND\s+/i).map((s) => s.trim()) }
  }
  return { op: 'ONE', parts: [expr] }
}

/** Strip an SPDX `WITH <exception>` suffix, keeping the base licence id. */
function baseId(id) {
  return id.replace(/\s+WITH\s+.*$/i, '').trim()
}

/**
 * Resolve a licence expression to a verdict.
 *
 * OR elects the first operand that clears both editions, which is what makes a
 * dual-licensed dependency safe. AND must clear every operand, since the work
 * is only conveyable if all of its terms are satisfied at once.
 */
function evaluate(raw) {
  const { op, parts } = parseExpression(raw)
  const looked = parts.map((p) => ({ id: p, rule: POLICY[baseId(p)] }))

  if (looked.some((l) => !l.rule)) {
    const unknown = looked.filter((l) => !l.rule).map((l) => l.id)
    return { ok: false, kind: 'unknown', unknown }
  }

  if (op === 'OR') {
    const elected = looked.find((l) => l.rule.agpl && l.rule.prop)
    if (elected)
      return { ok: true, kind: 'elected', elected: elected.id, looked }
    return { ok: false, kind: 'no-safe-disjunct', looked }
  }

  const blocked = looked.filter((l) => !l.rule.agpl || !l.rule.prop)
  if (blocked.length > 0) return { ok: false, kind: 'blocked', blocked }
  return { ok: true, kind: 'clear', looked }
}

// ─────────────────────────────────────────────────────────────────────────────

const failures = []
const acknowledged = []
const weak = []
const elections = []
const seenAck = new Set()
const tiers = {}

// The same closure `generate-third-party-notices.mjs` credits, from the same
// module. Two walks of the lockfile would eventually disagree, and the gap
// between "cleared to ship" and "credited" is precisely the set of packages we
// distribute with neither permission nor attribution.
const distributed = distributedPackages()
const prodCount = distributed.length
const devCount = devOnlyCount()

for (const { name, version, license } of distributed) {
  const id = `${name}@${version ?? '?'}`
  const raw = license

  if (!raw) {
    const ack = ACKNOWLEDGED[id]
    if (ack) {
      seenAck.add(id)
      acknowledged.push({ id, ...ack })
      continue
    }
    failures.push({
      id,
      why: 'no `license` field: redistribution is unlicensed by default',
    })
    continue
  }

  const verdict = evaluate(raw)
  if (!verdict.ok) {
    if (verdict.kind === 'unknown') {
      failures.push({
        id,
        why: `unrecognized licence ${verdict.unknown.join(', ')} — add it to POLICY`,
      })
    } else if (verdict.kind === 'no-safe-disjunct') {
      failures.push({
        id,
        why: `every option in "${raw}" fails at least one edition`,
      })
    } else {
      const names = verdict.blocked.map((b) => b.id).join(', ')
      const which = verdict.blocked
        .map((b) =>
          b.rule.prop ? 'the AGPL edition' : 'the commercial edition',
        )
        .join(' and ')
      failures.push({ id, why: `${names} cannot ship in ${which}` })
    }
    continue
  }

  if (verdict.kind === 'elected') {
    const note = ELECTIONS[name]
    elections.push({ id, raw, elected: verdict.elected, note })
    tiers['dual-licensed (elected)'] =
      (tiers['dual-licensed (elected)'] ?? 0) + 1
    continue
  }

  for (const l of verdict.looked) {
    tiers[l.rule.tier] = (tiers[l.rule.tier] ?? 0) + 1
    if (l.rule.tier === 'weak-copyleft') weak.push({ id, licence: l.id })
  }
}

const stale = Object.keys(ACKNOWLEDGED).filter((id) => !seenAck.has(id))

// ── report ──────────────────────────────────────────────────────────────────

console.log(
  `\nScanned ${prodCount} distributed package(s); ${devCount} dev-only package(s) not judged.\n`,
)
for (const [tier, n] of Object.entries(tiers).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(n).padStart(4)}  ${tier}`)
}

if (elections.length > 0) {
  console.log('\nDual-licensed dependencies, elected permissive:')
  for (const e of elections) {
    console.log(`   ${e.id}: "${e.raw}" -> ${e.elected}`)
    if (e.note) console.log(`      ${e.note.why}`)
  }
}

if (weak.length > 0) {
  console.log(
    '\nWeak copyleft — shippable in both editions, but each carries a notice',
  )
  console.log('and source-availability obligation on redistribution:')
  for (const w of weak) console.log(`   ${w.id}  (${w.licence})`)
}

if (acknowledged.length > 0) {
  console.log('\nNo licence grant, accepted with recorded reasoning:')
  for (const a of acknowledged) console.log(`   ${a.id} — ${a.why}`)
}

if (stale.length > 0) {
  console.error(
    `\n✗ ${stale.length} ACKNOWLEDGED entr${stale.length === 1 ? 'y is' : 'ies are'} no longer in the tree:\n`,
  )
  for (const id of stale) console.error(`   ${id}`)
  console.error(
    '\nRemove them. An exception list that outlives its exceptions grants ' +
      'cover to packages nobody has looked at.\n',
  )
  process.exit(1)
}

if (failures.length > 0) {
  console.error(
    `\n✗ ${failures.length} dependenc(y/ies) fail the licence policy:\n`,
  )
  for (const f of failures) console.error(`   ${f.id}\n      ${f.why}`)
  console.error(
    '\nCascadia ships this closure under two licences at once. Replace the ' +
      'dependency, or — if the finding is wrong — record the decision in ' +
      'POLICY or ACKNOWLEDGED so the next person inherits the reasoning.\n',
  )
  process.exit(1)
}

console.log(
  '\n✅ Every distributed dependency is compatible with both the AGPL and the commercial edition.\n',
)
process.exit(0)
