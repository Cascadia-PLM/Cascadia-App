// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Upload files to an item: the multipart counterpart of `apiFetch`, which
 * always sends JSON. Posts to the same endpoint `FileUploadZone` does.
 */

export interface UploadItemFilesOptions {
  /** Version context for the upload. */
  branchId?: string
  /** Index into `files` of the one to designate as the item thumbnail. */
  thumbnailIndex?: number
}

export interface UploadedItemFile {
  id: string
  originalFileName: string
}

export async function uploadItemFiles(
  itemId: string,
  files: Array<File>,
  options: UploadItemFilesOptions = {},
): Promise<Array<UploadedItemFile>> {
  const formData = new FormData()
  if (options.branchId) formData.append('branchId', options.branchId)
  files.forEach((file, index) => {
    formData.append(`file${index}`, file)
    if (index === options.thumbnailIndex) {
      formData.append(`file${index}_isThumbnail`, 'true')
    }
  })

  const response = await fetch(`/api/v1/items/${itemId}/files/upload`, {
    method: 'POST',
    body: formData,
  })

  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(errorMessage(body, response.status))
  }

  const result = body as {
    data?: { files?: Array<UploadedItemFile> }
    files?: Array<UploadedItemFile>
  } | null
  return result?.data?.files ?? result?.files ?? []
}

/** The most specific message an error body offers, else the status. */
function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const nested = record.error
    if (nested && typeof nested === 'object') {
      const message = (nested as Record<string, unknown>).message
      if (typeof message === 'string' && message) return message
    }
    for (const key of ['details', 'message', 'error']) {
      const value = record[key]
      if (typeof value === 'string' && value) return value
    }
  }
  return `Upload failed (HTTP ${status})`
}
