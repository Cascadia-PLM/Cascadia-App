// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Shared BOM tree types used by EcoTreeTable and StructureTab.
 *
 * Re-exported from `@/lib/types/bom`, which is the single declaration the
 * server builds against too — keeping this path so the component imports that
 * already point here do not all have to move.
 */

export type { BOMTreeNode, OrphanItem } from '@/lib/types/bom'
