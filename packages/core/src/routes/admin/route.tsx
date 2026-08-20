// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute } from '@tanstack/react-router'
import { requireSystemManage } from '@/lib/auth/system-access'

/**
 * Layout route for the admin console.
 *
 * It exists only for the guard: every page under `/admin` reads or writes
 * instance configuration, and every API route behind them already enforces
 * `system:manage`. Gating here means a user without that grant is redirected
 * to the dashboard rather than shown a console whose every panel 403s.
 *
 * No `component`, so the router renders the child route directly.
 */
export const Route = createFileRoute('/admin')({
  beforeLoad: ({ context: { queryClient } }) =>
    requireSystemManage(queryClient),
})
