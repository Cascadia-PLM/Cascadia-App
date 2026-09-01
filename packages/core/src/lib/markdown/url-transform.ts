// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Restrict a markdown URL to an app-relative path, or to nothing.
 *
 * Every markdown renderer in this app displays model-authored prose, and the
 * model writes it downstream of tool results and database-sourced strings —
 * item names, descriptions, comments, tool names — that any user with write
 * access authored. A URL in that text is therefore not necessarily one the
 * model chose freely, and a rendered destination is an egress channel: a link
 * carries to that host whatever the model was told to append to it, and an
 * `<img>` needs no click at all.
 *
 * Pass this as `urlTransform` to every `<ReactMarkdown>` that renders
 * model-authored text — react-markdown applies it to every URL-bearing
 * attribute (`a[href]`, `img[src]`, …) before a component sees it.
 *
 * A leading `/` is not enough on its own: `//host` and `/\host` both resolve
 * to another origin in a browser's URL parser, which normalises backslashes
 * in a special scheme. What survives is a `/` followed by neither.
 */
export function toAppRelativeUrl(url: string): string {
  return /^\/(?![/\\])/.test(url) ? url : ''
}
