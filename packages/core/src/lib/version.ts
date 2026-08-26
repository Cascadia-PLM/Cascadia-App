// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import pkg from '../../package.json'

/**
 * The product version, single-sourced from @cascadia/core's package.json —
 * `npm version <v> --workspaces` keeps every workspace package in step, so
 * this is the same number the release tag carries.
 *
 * Distinct from the API contract version: the OpenAPI document's
 * `info.version` stays 1.0.0 for as long as the frozen v1 contract does
 * (see docs/api/README.md).
 */
export const APP_VERSION: string = pkg.version
