// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useQuery } from '@tanstack/react-query'
import { setupStatusQuery } from '@/lib/query/options/setup'

export type { SetupProgressState, SetupStatus } from '@/lib/query/options/setup'

export function useSetupStatus() {
  return useQuery(setupStatusQuery())
}
