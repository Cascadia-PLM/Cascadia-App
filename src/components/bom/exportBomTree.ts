import type { BOMTreeNode } from './types'

interface ExportOptions {
  filename?: string
  includeEcoFields?: boolean
}

interface FlattenedNode {
  level: number
  itemNumber: string
  name: string
  revision: string
  state: string
  itemType: string
  quantity?: number
  findNumber?: number
  designCode?: string
  isExternal?: boolean
  changeAction?: string | null
  isInEco?: boolean
}

/**
 * Recursively flattens a BOM tree into a flat array with level indicators
 */
function flattenBomTree(
  nodes: Array<BOMTreeNode>,
  level: number = 0,
): Array<FlattenedNode> {
  const result: Array<FlattenedNode> = []

  for (const node of nodes) {
    result.push({
      level,
      itemNumber: node.itemNumber,
      name: node.name,
      revision: node.revision,
      state: node.state,
      itemType: node.itemType,
      quantity: node.quantity,
      findNumber: node.findNumber,
      designCode: node.designCode,
      isExternal: node.isExternal,
      changeAction: node.changeAction,
      isInEco: node.isInEco,
    })

    if (node.children && node.children.length > 0) {
      result.push(...flattenBomTree(node.children, level + 1))
    }
  }

  return result
}

/**
 * Escapes a value for CSV format
 */
function escapeCSV(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  const strValue = String(value)
  if (
    strValue.includes(',') ||
    strValue.includes('"') ||
    strValue.includes('\n')
  ) {
    return `"${strValue.replace(/"/g, '""')}"`
  }
  return strValue
}

/**
 * Exports a BOM tree to CSV and triggers download
 */
export function exportBomTreeToCsv(
  nodes: Array<BOMTreeNode>,
  options: ExportOptions = {},
): void {
  const { filename = 'bom-structure', includeEcoFields = false } = options

  const flattened = flattenBomTree(nodes)

  // Build headers
  const headers = [
    'Level',
    'Item Number',
    'Name',
    'Revision',
    'State',
    'Type',
    'Quantity',
    'Find Number',
    'Design',
    'External',
  ]

  if (includeEcoFields) {
    headers.push('In ECO', 'Change Action')
  }

  // Build rows
  const rows = flattened.map((node) => {
    const row = [
      node.level,
      node.itemNumber,
      node.name,
      node.revision,
      node.state,
      node.itemType,
      node.quantity ?? '',
      node.findNumber ?? '',
      node.designCode ?? '',
      node.isExternal ? 'Yes' : '',
    ]

    if (includeEcoFields) {
      row.push(node.isInEco ? 'Yes' : '', node.changeAction ?? '')
    }

    return row.map(escapeCSV)
  })

  // Combine headers and rows
  const csvContent = [
    headers.join(','),
    ...rows.map((row) => row.join(',')),
  ].join('\n')

  // Create and download file
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${filename}-${new Date().toISOString().split('T')[0]}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(link.href)
}

/**
 * Exports a flat list of affected items to CSV (for ECO table view)
 */
export function exportAffectedItemsToCsv(
  items: Array<{
    itemNumber?: string | null
    name?: string | null
    itemType?: string | null
    designCode?: string | null
    changeAction?: string | null
    currentRevision?: string | null
    currentState?: string | null
    targetRevision?: string | null
    targetState?: string | null
  }>,
  filename: string = 'affected-items',
): void {
  const headers = [
    'Item Number',
    'Name',
    'Type',
    'Design',
    'Change Action',
    'Current Revision',
    'Current State',
    'Target Revision',
    'Target State',
  ]

  const rows = items.map((item) => [
    escapeCSV(item.itemNumber ?? ''),
    escapeCSV(item.name ?? ''),
    escapeCSV(item.itemType ?? ''),
    escapeCSV(item.designCode ?? ''),
    escapeCSV(item.changeAction ?? ''),
    escapeCSV(item.currentRevision ?? ''),
    escapeCSV(item.currentState ?? ''),
    escapeCSV(item.targetRevision ?? ''),
    escapeCSV(item.targetState ?? ''),
  ])

  const csvContent = [
    headers.join(','),
    ...rows.map((row) => row.join(',')),
  ].join('\n')

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${filename}-${new Date().toISOString().split('T')[0]}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(link.href)
}
