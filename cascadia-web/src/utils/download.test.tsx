// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { expect, it, vi } from 'vitest'
import { downloadBlob } from './download'

it('releases the link and object URL when clicking fails', () => {
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
    throw new Error('click failed')
  })
  try {
    expect(() => downloadBlob(new Blob(['data']), 'export.csv')).toThrow(
      'click failed',
    )
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:test')
    expect(document.body.querySelector('a[download="export.csv"]')).toBeNull()
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
