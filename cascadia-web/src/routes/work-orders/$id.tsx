// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/work-orders/$id')({
  component: WorkOrderLayout,
})

function WorkOrderLayout() {
  return <Outlet />
}
