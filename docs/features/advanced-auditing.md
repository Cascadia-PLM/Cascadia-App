# Advanced Auditing

**Not included in this edition.** Advanced Auditing is an optional package,
licensed separately from the AGPL edition published in this repository.

It is documented here because the mechanism it plugs into — the optional-package
registry and the `CASCADIA_PACKAGES` environment variable — _is_ part of this
edition, and several pages link to this one. Code you find here that guards on
`requirePackage('advanced-auditing')` is doing exactly what it looks like:
refusing to run a feature this build does not contain.

## What it adds

- **Digital signatures on workflow approvals.** Every approval vote is signed,
  by CAC/PIV smart card over mutual TLS or by password fallback.
- **Certificate enrollment** for signing credentials.
- **A hash-chained, append-only audit trail**, so a tampered record breaks the
  chain rather than disappearing quietly.
- **Signed release PDFs** — a printed approval block plus an embedded PKCS#7
  detached signature.

Together these target the electronic-records and electronic-signature
expectations of regulated manufacturing.

## What is in this edition

The parts that are not the feature itself:

- The package registry — `PackageRegistry.isEnabled()`, `requirePackage()`, and
  the `PackageNotLicensedError` a missing entitlement raises. See
  [adding-packages.md](../development/adding-packages.md).
- The `auditing` database schema, in
  [`packages/core/src/lib/db/schema/auditing.ts`](../../packages/core/src/lib/db/schema/auditing.ts).
- The workflow approval registry the package hooks into —
  `beforeVote`/`afterVote`/`buildExtras` — described in
  [workflow-engine.md](./workflow-engine.md).

An instance without the package runs approvals normally; it simply collects no
signatures.

## Getting it

Advanced Auditing is offered under a separate written agreement by Cascadia PLM
LLC. See the [project README](../../README.md) for contact details.
