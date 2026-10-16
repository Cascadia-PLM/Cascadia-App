// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/** Download a blob without leaking its temporary URL or DOM link. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    try {
      document.body.appendChild(link)
      link.click()
    } finally {
      link.remove()
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Match the existing UTC-dated CSV export names across grids and BOMs. */
export function downloadDatedCsv(content: string, basename: string): void {
  const date = new Date().toISOString().split('T')[0]
  downloadBlob(
    new Blob([content], { type: 'text/csv;charset=utf-8;' }),
    `${basename}-${date}.csv`,
  )
}
