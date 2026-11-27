// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { Box, MoreVertical } from 'lucide-react'
import { GenerateCadDialog } from './GenerateCadDialog'
import type { SlotProps } from '@/ui/slot-registry'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui'

/**
 * Generative CAD actions on the part detail page.
 *
 * Core used to hold all of this: the open state, the overflow menu that exists
 * for no other reason, and the dialog itself. It now renders a slot and this
 * fills it, so an instance without the package gets no menu rather than an
 * empty one.
 *
 * The `Manufacture` check lives here because it is a rule about generative CAD,
 * not about parts. The server enforces it independently in `parts-cad.ts`;
 * this only decides whether to offer the action.
 */
export function PartCadActions({ part }: SlotProps['part-detail-actions']) {
  const [open, setOpen] = useState(false)

  if (part.partType !== 'Manufacture') return null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setOpen(true)}>
            <Box className="h-4 w-4 mr-2" />
            Generate CAD
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Radix portals this to the body, so rendering it beside the trigger
          rather than at the page root changes nothing visually. */}
      <GenerateCadDialog open={open} onOpenChange={setOpen} part={part} />
    </>
  )
}
