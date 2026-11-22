const PREFERRED_ATTRIBUTE_ORDER = [
  'Category',
  'Subcategory',
  'Standard',
  'Size',
  'Material',
  'SurfaceTreatment',
]

/**
 * Attribute values live in jsonb, which does not preserve insertion order.
 * Present the common PDM fields in a stable, related order; unknown fields
 * follow alphabetically.
 */
export function orderedAttributeEntries(
  attributes: Record<string, unknown> | null | undefined,
): Array<[string, unknown]> {
  const rank = (key: string) => {
    const index = PREFERRED_ATTRIBUTE_ORDER.indexOf(key)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  return Object.entries(attributes ?? {}).sort(([a], [b]) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    return a.localeCompare(b)
  })
}
