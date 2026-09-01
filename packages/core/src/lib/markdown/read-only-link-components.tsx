// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { Components } from 'react-markdown'

/**
 * `a`/`img` overrides for a `<ReactMarkdown urlTransform={toAppRelativeUrl}>`
 * that renders read-only model prose — no in-app navigation handler to hand
 * an app-relative href off to, just text.
 *
 * `toAppRelativeUrl` empties every off-origin `href`/`src`, but react-markdown
 * still renders the attribute as `href=""`/`src=""` when nothing overrides
 * the component. A browser treats both as "reload the current page" — an
 * `<img>` fetches it immediately, an `<a>` on the next click — which would
 * discard whatever the viewer had in progress. Swap the empty case for the
 * link text / alt text instead.
 */
export const readOnlyMarkdownLinkComponents: Partial<Components> = {
  a: ({ href, children }) =>
    href ? <a href={href}>{children}</a> : <span>{children}</span>,
  img: ({ src, alt }) =>
    src ? (
      <img src={src} alt={alt ?? ''} className="max-w-full" />
    ) : (
      <span>{alt}</span>
    ),
}
