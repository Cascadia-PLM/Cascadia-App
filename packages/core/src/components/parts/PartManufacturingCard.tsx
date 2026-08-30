// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { Part } from '@/lib/items/types/part'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ViewEditBadge,
  ViewEditCurrency,
  ViewEditNumber,
  ViewEditText,
} from '@/components/ui'

const PART_TYPE_OPTIONS = [
  { value: 'Manufacture', label: 'Manufacture' },
  { value: 'Purchase', label: 'Purchase' },
  { value: 'Software', label: 'Software' },
  { value: 'Phantom', label: 'Phantom' },
]

const TRACKING_MODE_OPTIONS = [
  { value: 'none', label: 'Not tracked' },
  { value: 'lot', label: 'Lot tracked' },
  { value: 'serial', label: 'Serial tracked' },
]

const WEIGHT_UNIT_OPTIONS = [
  { value: 'kg', label: 'kg' },
  { value: 'g', label: 'g' },
  { value: 'lb', label: 'lb' },
  { value: 'oz', label: 'oz' },
]

const CURRENCY_OPTIONS = [
  { value: 'USD', label: 'USD' },
  { value: 'EUR', label: 'EUR' },
  { value: 'GBP', label: 'GBP' },
  { value: 'JPY', label: 'JPY' },
]

/**
 * Production and sourcing fields: type, tracking policy, material, weight,
 * cost, lead time.
 *
 * Takes both parts because the page shows the *displayed* version's values
 * while reading, and the *edited* draft while editing — the same pair every
 * field card on this page threads. The option lists live here rather than in
 * PartDetail because nothing else uses them.
 */
export function PartManufacturingCard({
  edited,
  displayed,
  isEditing,
  onFieldChange,
}: {
  edited: Part
  displayed: Part
  isEditing: boolean
  onFieldChange: (field: keyof Part, value: unknown) => void
}) {
  const updateField = onFieldChange

  return (
    <Card>
      <CardHeader>
        <CardTitle>Manufacturing Details</CardTitle>
        <CardDescription>Production and sourcing information</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <ViewEditBadge
            label="Type"
            value={isEditing ? edited.partType : displayed.partType}
            onChange={(v) => updateField('partType', v)}
            isEditing={isEditing}
            options={PART_TYPE_OPTIONS}
            variant={(v) => {
              const m: Record<
                string,
                'default' | 'secondary' | 'success' | 'outline'
              > = {
                Manufacture: 'default',
                Purchase: 'secondary',
                Software: 'success',
                Phantom: 'outline',
              }
              return m[v] || 'default'
            }}
          />
          <ViewEditBadge
            label="Tracking"
            value={
              isEditing
                ? (edited.trackingMode ?? 'none')
                : (displayed.trackingMode ?? 'none')
            }
            onChange={(v) => updateField('trackingMode', v)}
            isEditing={isEditing}
            options={TRACKING_MODE_OPTIONS}
            variant={(v) => {
              const m: Record<
                string,
                'default' | 'secondary' | 'success' | 'outline'
              > = {
                none: 'outline',
                lot: 'secondary',
                serial: 'success',
              }
              return m[v] || 'outline'
            }}
          />
          <ViewEditText
            label="Material"
            value={isEditing ? edited.material : displayed.material}
            onChange={(v) => updateField('material', v)}
            isEditing={isEditing}
            placeholder="e.g., Aluminum 6061"
          />
          <ViewEditNumber
            label="Weight"
            value={isEditing ? edited.weight : displayed.weight}
            onChange={(v) => updateField('weight', v)}
            isEditing={isEditing}
            unitOptions={WEIGHT_UNIT_OPTIONS}
            unitValue={isEditing ? edited.weightUnit : displayed.weightUnit}
            onUnitChange={(v) => updateField('weightUnit', v)}
            step="0.001"
          />
          <ViewEditCurrency
            label="Cost"
            value={isEditing ? edited.cost : displayed.cost}
            onChange={(v) => updateField('cost', v)}
            isEditing={isEditing}
            currency={isEditing ? edited.costCurrency : displayed.costCurrency}
            currencyOptions={CURRENCY_OPTIONS}
            onCurrencyChange={(v) => updateField('costCurrency', v)}
          />
          <ViewEditNumber
            label="Lead Time"
            value={isEditing ? edited.leadTimeDays : displayed.leadTimeDays}
            onChange={(v) =>
              updateField('leadTimeDays', v ? parseInt(v) : undefined)
            }
            isEditing={isEditing}
            unit="days"
            min={0}
          />
        </dl>
      </CardContent>
    </Card>
  )
}
