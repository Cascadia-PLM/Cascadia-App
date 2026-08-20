// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute } from '@tanstack/react-router'
import { requireSystemAccess } from '@/lib/auth/system-access'

/**
 * Layout route for user administration — the System section's Users pages.
 *
 * `users:read` is deliberately *not* the gate: approver and assignee pickers
 * all over the app read the same endpoint, so that grant stays broad. What
 * separates browsing the directory from administering it is the System grant.
 */
export const Route = createFileRoute('/users')({
  beforeLoad: ({ context: { queryClient } }) =>
    requireSystemAccess(queryClient),
})
