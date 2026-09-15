// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Component-catalog wire types: the JSONB column shapes the schema declares
 * and the entry shape the catalog API returns. Declared apart from the schema
 * and `CatalogService` so the web package can name them; both re-export.
 */

// ============================================================================
// JSONB Type Definitions
// ============================================================================

export interface CatalogDimensions {
  width?: number // mm
  height?: number
  depth?: number
  diameter?: number
  weight?: number // grams
}

export interface CatalogMountingFeature {
  type: string // "bolt_circle", "flange", "shaft", "pin_header", "screw_terminal"
  specs: Record<string, unknown> // e.g., { boltCircleDiameter: 31, boltSize: 3, pattern: "square" }
}

export interface CatalogElectrical {
  voltage?: string // "12V", "5-24V"
  current?: string // "1.7A"
  power?: string
  interface?: string // "STEP/DIR", "I2C", "UART"
  pinout?: string
}

export interface CatalogSupplier {
  name: string // "Amazon", "DigiKey"
  partNumber?: string
  approximatePrice: number // USD
  url?: string
  lastVerified?: string // ISO date
}

export interface CatalogStockSize {
  label: string // "500mm", "300x300mm"
  dimensions: Record<string, number> // { length: 500 } or { width: 300, height: 300 }
  supplierPartNumber?: string
  approximatePrice?: number
}

export interface CatalogEntryWithCategory {
  id: string
  name: string
  description: string | null
  category: { id: string; name: string; slug: string }
  entryType: 'component' | 'raw_stock'
  dimensions: CatalogDimensions | null
  mountingFeatures: Array<CatalogMountingFeature>
  electrical: CatalogElectrical | null
  specs: Record<string, string>
  stockSizes: Array<CatalogStockSize> | null
  suppliers: Array<CatalogSupplier>
  designNotes: string | null
  tags: Array<string>
  verified: boolean
}
