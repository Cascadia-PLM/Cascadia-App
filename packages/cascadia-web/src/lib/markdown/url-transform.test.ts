// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Security gate. Every markdown renderer of model-authored text passes this
 * as `urlTransform`; a gap here reopens the link/image egress channel in
 * every one of them at once. See `packages/core/src/components/ai/ChatMessage.links.test.tsx`
 * and the design-engine renderer tests for the component-level assertions
 * that this transform is actually wired in.
 *
 * Run: npx vitest run packages/core/src/lib/markdown/url-transform.test.ts
 */

import { describe, expect, it } from 'vitest'
import { toAppRelativeUrl } from './url-transform'

const EVIL = 'exfil.example'

describe('toAppRelativeUrl', () => {
  it('keeps a path in this app', () => {
    expect(toAppRelativeUrl('/parts/abc')).toBe('/parts/abc')
    expect(toAppRelativeUrl('/parts/abc?tab=bom')).toBe('/parts/abc?tab=bom')
  })

  it('drops everything that can address another origin', () => {
    for (const url of [
      `https://${EVIL}/collect?d=secret`,
      `http://${EVIL}/collect`,
      // Protocol-relative: a path by appearance, an origin by resolution.
      `//${EVIL}/collect`,
      // Same, via the backslash a browser normalises to a slash.
      `/\\${EVIL}/collect`,
      `javascript:fetch('https://${EVIL}')`,
      'data:text/html,<script>1</script>',
      `mailto:leak@${EVIL}`,
      `HTTPS://${EVIL}`,
      'parts/abc',
      '',
    ]) {
      expect(toAppRelativeUrl(url), url || '(empty)').toBe('')
    }
  })
})
