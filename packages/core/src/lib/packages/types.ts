// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Identifiers for optional, separately-licensed packages.
 *
 * A package is a coherent slice of functionality that ships in the codebase but
 * is only *available* on instances entitled to it. Gating happens at deploy time
 * via the `CASCADIA_PACKAGES` environment variable — there is deliberately no
 * in-app switch, so an instance cannot enable a package it has not bought.
 */
/**
 * A package id.
 *
 * Deliberately `string` rather than a union of the ids core happens to know.
 * Core does not know them — a module registers its own descriptor — and the
 * system was already built to treat an unrecognized id as data rather than as
 * an error: `CASCADIA_PACKAGES` logs and ignores what it cannot resolve, so a
 * newer deployment manifest does not break an older build. `isPackageId()`
 * answers the question at runtime, against what this build actually ships.
 */
export type PackageId = string

export interface PackageDescriptor {
  id: PackageId
  /** Display name shown in the admin UI. */
  name: string
  /** One-line description of what the package adds. */
  description: string
  /** Features contributed by this package, for the admin listing. */
  features: Array<string>
}

/**
 * Shape returned by `GET /api/v1/packages` and consumed by the client.
 *
 * `id` widens to `string` deliberately: this is a wire DTO, and a client build
 * may be older than the server it talks to, so it must not claim the id is one
 * of the ids *it* happens to know about.
 */
export interface PackageStatus extends Omit<PackageDescriptor, 'id'> {
  id: string
  enabled: boolean
}
