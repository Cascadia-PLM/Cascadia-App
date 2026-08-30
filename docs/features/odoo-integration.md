# Odoo ERP Integration

**Not included in this edition.** The Odoo connector is an optional package,
licensed separately from the AGPL edition published in this repository.

It is documented here because the two mechanisms it plugs into — the
optional-package registry with its `CASCADIA_PACKAGES` environment variable, and
the release-hook registry — _are_ part of this edition, and other pages link
here. Code you find that guards on `requirePackage('odoo-integration')` is doing
exactly what it looks like: refusing to run a feature this build does not
contain.

## What it adds

Pushes released engineering master data into an Odoo 19+ ERP over Odoo's JSON-2
API, one direction only:

- **Parts become Odoo products** on ECO release — number, name, description and
  revision, with make/buy/phantom/software driving the Odoo product type and
  procurement route, and Cascadia's lot/serial tracking policy mirrored onto the
  product.
- **Released BOM structure becomes `mrp.bom`**, quantities and find numbers
  included.
- **Manual and dry-run sync** alongside the automatic release trigger.

The direction is deliberate and permanent: Cascadia owns the identity and
genealogy of material, the ERP owns quantity and value. Stock, pricing, POs and
costing never flow back into Cascadia.

## What is in this edition

The parts that are not the connector itself:

- The package registry — `PackageRegistry.isEnabled()`, `requirePackage()`, and
  the `PackageNotLicensedError` a missing entitlement raises. See
  [adding-packages.md](../development/adding-packages.md).
- **`ReleaseHookRegistry`**, the core seam the connector's release trigger uses
  ([`packages/core/src/lib/services/release-hooks.ts`](../../packages/core/src/lib/services/release-hooks.ts)).
  Hooks run after the merge transaction commits, each in a warn-only try/catch,
  so a failing hook can never roll back or block a release. Core ships zero
  hooks; with none registered a release behaves exactly as it did before the
  seam existed.
- The background job system the sync runs on. See
  [background-jobs.md](../admin/background-jobs.md).

An instance without the package releases ECOs normally; nothing is pushed
anywhere.

## Getting it

The Odoo connector is offered under a separate written agreement by Cascadia PLM
LLC. See the [project README](../../README.md) for contact details.
