import * as ExcelJS from 'exceljs'
import {
  ACCEPTED_EXTENSIONS,
  MAX_FILE_SIZE,
  MAX_IMPORT_ROWS,
} from './constants'
import type { ParsedFile } from './types'

/**
 * Error thrown when file parsing fails
 */
export class ParseError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'ParseError'
  }
}

/**
 * Parse an Excel or CSV file and extract headers and rows
 */
export async function parseFile(file: File): Promise<ParsedFile> {
  // Validate file extension
  const fileName = file.name.toLowerCase()
  const extension = fileName.substring(fileName.lastIndexOf('.'))

  if (!ACCEPTED_EXTENSIONS.includes(extension)) {
    throw new ParseError(
      `Invalid file type. Accepted types: ${ACCEPTED_EXTENSIONS.join(', ')}`,
      'INVALID_FILE_TYPE',
    )
  }

  // Validate file size
  if (file.size > MAX_FILE_SIZE) {
    throw new ParseError(
      `File size exceeds maximum allowed (${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB)`,
      'FILE_TOO_LARGE',
    )
  }

  // Read file as array buffer
  const arrayBuffer = await file.arrayBuffer()

  // Parse with ExcelJS
  const workbook = new ExcelJS.Workbook()
  try {
    if (extension === '.csv') {
      // For CSV, we need to use a different approach with ExcelJS
      const text = new TextDecoder().decode(arrayBuffer)
      const rows = parseCSV(text)
      return processRows(rows, file.name, 'csv')
    } else {
      // ExcelJS can load directly from ArrayBuffer in the browser
      await workbook.xlsx.load(arrayBuffer)
    }
  } catch {
    throw new ParseError(
      'Failed to parse file. Please ensure it is a valid Excel or CSV file.',
      'PARSE_FAILED',
    )
  }

  // Get first worksheet
  const worksheet = workbook.worksheets[0]
  if (!worksheet) {
    throw new ParseError('File contains no sheets', 'NO_SHEETS')
  }

  // Extract all rows as arrays
  const rawData: Array<Array<unknown>> = []
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const rowValues: Array<unknown> = []
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      // Pad array to match column position (1-indexed)
      while (rowValues.length < colNumber - 1) {
        rowValues.push('')
      }
      rowValues.push(getCellValue(cell))
    })
    rawData.push(rowValues)
  })

  // Determine file type
  const fileType: 'xlsx' | 'csv' = extension === '.csv' ? 'csv' : 'xlsx'

  return processRows(rawData, file.name, fileType)
}

/**
 * Process raw row data into ParsedFile format
 */
function processRows(
  rawData: Array<Array<unknown>>,
  fileName: string,
  fileType: 'xlsx' | 'csv',
): ParsedFile {
  if (rawData.length === 0) {
    throw new ParseError('File is empty or has no readable data', 'EMPTY_FILE')
  }

  // Extract headers from first row
  const headerRow = rawData[0]
  const headers = headerRow.map((h, index) => {
    if (h === null || h === undefined || h === '') {
      return `Column ${index + 1}`
    }
    return String(h).trim()
  })

  // Extract data rows (skip header row)
  const dataRows = rawData.slice(1)

  // Check row count
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new ParseError(
      `File contains ${dataRows.length} rows, but maximum allowed is ${MAX_IMPORT_ROWS}`,
      'TOO_MANY_ROWS',
    )
  }

  // Convert arrays to objects using headers as keys
  const rows = dataRows.map((row) => {
    const rowArray = row
    const obj: Record<string, unknown> = {}
    headers.forEach((header, index) => {
      const value = rowArray[index]
      // Normalize empty values
      if (value === null || value === undefined || value === '') {
        obj[header] = undefined
      } else if (typeof value === 'string') {
        obj[header] = value.trim()
      } else {
        obj[header] = value
      }
    })
    return obj
  })

  // Filter out completely empty rows
  const nonEmptyRows = rows.filter((row) =>
    Object.values(row).some((v) => v !== undefined && v !== ''),
  )

  return {
    headers,
    rows: nonEmptyRows,
    totalRows: nonEmptyRows.length,
    fileName,
    fileType,
  }
}

/**
 * Extract cell value handling various ExcelJS cell types
 */
function getCellValue(cell: ExcelJS.Cell): unknown {
  const value = cell.value

  if (value === null || value === undefined) {
    return ''
  }

  // Handle rich text
  if (typeof value === 'object' && 'richText' in value) {
    return value.richText.map((rt) => rt.text).join('')
  }

  // Handle formula results
  if (typeof value === 'object' && 'result' in value) {
    return (value as ExcelJS.CellFormulaValue).result
  }

  // Handle hyperlinks
  if (typeof value === 'object' && 'hyperlink' in value) {
    return value.text || value.hyperlink
  }

  // Handle dates
  if (value instanceof Date) {
    return value
  }

  // Handle error values
  if (typeof value === 'object' && 'error' in value) {
    return ''
  }

  return value
}

/**
 * RFC 4180-compliant CSV parser that handles multiline quoted fields.
 * Iterates character-by-character to correctly track quote state across line boundaries.
 */
function parseCSV(text: string): Array<Array<string>> {
  const rows: Array<Array<string>> = []
  let row: Array<string> = []
  let current = ''
  let inQuotes = false
  let i = 0

  while (i < text.length) {
    const char = text[i]

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote
          current += '"'
          i += 2
          continue
        } else {
          // End of quoted field
          inQuotes = false
          i++
          continue
        }
      } else {
        // Inside quotes — accept all characters including newlines
        current += char
        i++
        continue
      }
    }

    // Not in quotes
    if (char === '"') {
      inQuotes = true
      i++
    } else if (char === ',') {
      row.push(current)
      current = ''
      i++
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(current)
      current = ''
      if (row.some((cell) => cell !== '')) rows.push(row)
      row = []
      i += 2
    } else if (char === '\n') {
      row.push(current)
      current = ''
      if (row.some((cell) => cell !== '')) rows.push(row)
      row = []
      i++
    } else {
      current += char
      i++
    }
  }

  // Handle last field/row
  row.push(current)
  if (row.some((cell) => cell !== '')) rows.push(row)

  return rows
}

/**
 * Check if a file is a valid import file type
 */
export function isValidFileType(file: File): boolean {
  const fileName = file.name.toLowerCase()
  const extension = fileName.substring(fileName.lastIndexOf('.'))
  return ACCEPTED_EXTENSIONS.includes(extension)
}

/**
 * Get file type from file name
 */
export function getFileType(fileName: string): 'xlsx' | 'csv' | null {
  const extension = fileName.toLowerCase().substring(fileName.lastIndexOf('.'))
  if (extension === '.csv') return 'csv'
  if (extension === '.xlsx' || extension === '.xls') return 'xlsx'
  return null
}
