// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/work-instructions/$id')({
  component: WorkInstructionLayout,
})

function WorkInstructionLayout() {
  return <Outlet />
}
