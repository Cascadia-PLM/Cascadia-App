// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Sparkles } from 'lucide-react'
import { NavSubItem } from '@/components/layout/NavSubItem'

/**
 * The sidebar's way into the collaborative design sessions this module adds.
 *
 * It lives here rather than in core's `SidebarNav` because the route it points
 * at lives here too: core never names a module's routes.
 */
export function DesignSessionsNavItem({
  onNavClick,
}: {
  onNavClick: () => void
}) {
  return (
    <NavSubItem
      to="/designs/collaborative"
      icon={Sparkles}
      label="Design Sessions"
      onClick={onNavClick}
      activeOptions={{ exact: true }}
      testId="nav-design-sessions"
    />
  )
}
