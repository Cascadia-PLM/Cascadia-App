import { useRef, useState } from 'react'
import { AlertCircle, Download, FileSpreadsheet, Upload, X } from 'lucide-react'
import type { ChangeEvent, DragEvent } from 'react'
import type { ColumnMapping, ImportItemType, ParsedFile } from '@/lib/import'
import { Badge, Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  ACCEPTED_EXTENSIONS,
  MAX_FILE_SIZE,
  MAX_IMPORT_ROWS,
  ParseError,
  autoDetectMappings,
  getImportConfig,
  parseFile,
} from '@/lib/import'

interface FileUploadStepProps {
  itemType?: ImportItemType
  value: ParsedFile | null
  onChange: (file: ParsedFile, mappings: Array<ColumnMapping>) => void
  onClear?: () => void
}

/**
 * Step 2: Upload and parse Excel/CSV file.
 */
export function FileUploadStep({
  itemType = 'Part',
  value,
  onChange,
  onClear,
}: FileUploadStepProps) {
  const config = getImportConfig(itemType)
  const [isDragging, setIsDragging] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      await processFile(files[0])
    }
  }

  const handleFileInput = async (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await processFile(e.target.files[0])
    }
  }

  const processFile = async (file: File) => {
    setIsProcessing(true)
    setError(null)

    try {
      const parsed = await parseFile(file)
      const mappings = autoDetectMappings(parsed.headers, itemType)
      onChange(parsed, mappings)
    } catch (err) {
      if (err instanceof ParseError) {
        setError(err.message)
      } else {
        setError(
          'Failed to parse file. Please ensure it is a valid Excel or CSV file.',
        )
      }
    } finally {
      setIsProcessing(false)
    }
  }

  const handleClear = () => {
    setError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleDownloadTemplate = async () => {
    try {
      const templatePath = `/api/v1/import/templates/${config.pluralLabel.toLowerCase()}`
      const response = await fetch(templatePath)
      if (!response.ok) throw new Error('Failed to download template')

      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${config.pluralLabel.toLowerCase()}-import-template.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      setError('Failed to download template')
    }
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i]
  }

  return (
    <div className="space-y-6">
      <div className="text-center mb-8">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Upload your {config.pluralLabel.toLowerCase()} file
        </h3>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          Excel (.xlsx) or CSV files are supported. Maximum {MAX_IMPORT_ROWS}{' '}
          rows.
        </p>
      </div>

      {/* Template Download */}
      <div className="flex justify-center">
        <Button
          variant="outline"
          size="sm"
          onClick={handleDownloadTemplate}
          className="text-cyan-600"
        >
          <Download className="h-4 w-4 mr-2" />
          Download Template
        </Button>
      </div>

      {/* Drop Zone */}
      {!value ? (
        <div
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            'border-2 border-dashed rounded-lg p-12 text-center transition-colors cursor-pointer',
            isDragging
              ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-900/20'
              : 'border-slate-300 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-600',
            isProcessing && 'opacity-50 pointer-events-none',
          )}
          onClick={() => fileInputRef.current?.click()}
        >
          {isProcessing ? (
            <>
              <div className="w-12 h-12 mx-auto mb-4 animate-spin rounded-full border-4 border-slate-300 border-t-cyan-600" />
              <p className="text-lg font-medium text-slate-900 dark:text-white">
                Processing file...
              </p>
            </>
          ) : (
            <>
              <Upload className="w-12 h-12 mx-auto mb-4 text-slate-400" />
              <p className="text-lg font-medium text-slate-900 dark:text-white mb-2">
                Drop your file here or click to browse
              </p>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Supported: {ACCEPTED_EXTENSIONS.join(', ')} | Max size:{' '}
                {formatFileSize(MAX_FILE_SIZE)}
              </p>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS.join(',')}
            onChange={handleFileInput}
            className="hidden"
          />
        </div>
      ) : (
        /* File Preview */
        <div className="border rounded-lg p-6 bg-slate-50 dark:bg-slate-800">
          <div className="flex items-start gap-4">
            <div className="p-3 bg-white dark:bg-slate-700 rounded-lg shadow-sm">
              <FileSpreadsheet className="w-8 h-8 text-green-600" />
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-medium text-slate-900 dark:text-white truncate">
                {value.fileName}
              </h4>
              <div className="flex items-center gap-3 mt-2">
                <Badge variant="outline">{value.fileType.toUpperCase()}</Badge>
                <span className="text-sm text-slate-600 dark:text-slate-400">
                  {value.totalRows} rows
                </span>
                <span className="text-sm text-slate-600 dark:text-slate-400">
                  {value.headers.length} columns
                </span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                handleClear()
                onClear?.()
              }}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* Preview of first few rows */}
          <div className="mt-4 overflow-x-auto">
            <div className="text-sm font-medium text-slate-600 dark:text-slate-400 mb-2">
              Preview (first 3 rows):
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  {value.headers.slice(0, 6).map((header, i) => (
                    <th
                      key={i}
                      className="px-2 py-1 text-left text-slate-600 dark:text-slate-400 font-medium"
                    >
                      {header}
                    </th>
                  ))}
                  {value.headers.length > 6 && (
                    <th className="px-2 py-1 text-left text-slate-400">
                      +{value.headers.length - 6} more
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {value.rows.slice(0, 3).map((row, rowIdx) => (
                  <tr
                    key={rowIdx}
                    className="border-b border-slate-300 dark:border-slate-700"
                  >
                    {value.headers.slice(0, 6).map((header, colIdx) => (
                      <td
                        key={colIdx}
                        className="px-2 py-1 text-slate-700 dark:text-slate-300 max-w-[150px] truncate"
                      >
                        {row[header] !== undefined ? String(row[header]) : '-'}
                      </td>
                    ))}
                    {value.headers.length > 6 && (
                      <td className="px-2 py-1">...</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="p-4 rounded-lg bg-red-50 border border-red-200 dark:bg-red-900/20 dark:border-red-800">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-red-600 mt-0.5" />
            <div>
              <p className="font-medium text-red-800 dark:text-red-200">
                Error processing file
              </p>
              <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
