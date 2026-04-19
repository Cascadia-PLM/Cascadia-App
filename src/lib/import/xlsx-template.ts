import ExcelJS from 'exceljs'
import type { ItemFieldConfig } from './field-configs/types'

/**
 * Generate an XLSX template file for import.
 *
 * Creates a workbook with a styled header row and an example data row.
 * Required fields are marked with an asterisk (*) in the header.
 */
export async function generateXlsxTemplate(
  fields: Array<ItemFieldConfig>,
  sheetName: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet(sheetName)

  // Configure columns from field definitions
  worksheet.columns = fields.map((f) => ({
    header: f.required ? `${f.label} *` : f.label,
    key: f.field,
    width: Math.max(f.label.length + 4, 15),
  }))

  // Style header row
  const headerRow = worksheet.getRow(1)
  headerRow.font = { bold: true }
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE2E8F0' },
  }

  // Add example data row
  const exampleData: Record<string, string> = {}
  for (const f of fields) {
    exampleData[f.field] = f.example || ''
  }
  worksheet.addRow(exampleData)

  return Buffer.from(await workbook.xlsx.writeBuffer())
}
