// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq } from 'drizzle-orm'
import { changeOrderDesigns, designs } from '../db/schema'
import type { TransactionClient } from '../db'

/**
 * The one program a change order belongs to, for `context.programId`, or null.
 *
 * A change order belongs to no design — it links any number — so it belongs to
 * a program only when every design it links sits in the same one. A change
 * order spanning programs has no single program, and neither does one that
 * links no design yet: their facts stay instance-wide, and a program-scoped
 * consumer must read that null as "not mine", never as "everyone's". Anything
 * that is not a change order links no designs this way, and gets null too.
 */
export async function resolveChangeOrderProgram(
  tx: TransactionClient,
  changeOrderId: string,
): Promise<string | null> {
  const rows = await tx
    .selectDistinct({ programId: designs.programId })
    .from(changeOrderDesigns)
    .innerJoin(designs, eq(designs.id, changeOrderDesigns.designId))
    .where(eq(changeOrderDesigns.changeOrderId, changeOrderId))
  const [only] = rows
  return rows.length === 1 && only?.programId ? only.programId : null
}
