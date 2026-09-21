// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { lifecycleDefinitionRoutes } from './lifecycle-definitions'

/**
 * `/api/v1/workflows*`: the path the lifecycle-definition routes shipped
 * under, kept as a deprecated alias of `/api/v1/lifecycles*` because v1 is
 * additive-only (remediation plan CM-24). Same handlers, same response keys.
 */
export default lifecycleDefinitionRoutes({ tag: 'Workflows', deprecated: true })
