// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute } from '@tanstack/react-router'
import { requireSystemAccess } from '@/lib/auth/system-access'

/**
 * Layout route for lifecycle and workflow administration.
 *
 * Same reasoning as `/users`: `workflows:read` stays broad because item pages
 * resolve their states through it, so the System grant is what admits a user
 * to the editor.
 */
export const Route = createFileRoute('/lifecycles')({
  beforeLoad: ({ context: { queryClient } }) =>
    requireSystemAccess(queryClient),
})
