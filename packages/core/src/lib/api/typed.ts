// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Helpers over the generated OpenAPI types.
 *
 * `openapi-types.gen.ts` is derived from the committed snapshot (community
 * view) by `npm run types:openapi`; these aliases turn its deeply nested
 * `paths` structure into the two shapes call sites actually want — the JSON
 * success body, and the payload under the `{ data: ... }` envelope.
 *
 * Scope discipline: these types replace hand-written response ENVELOPES
 * only. Zod-derived domain types (Part, Document, ...) stay authoritative
 * for item shapes — deriving those from the wire contract too would leave
 * two competing sources of truth for the same object.
 */

import type { paths } from './openapi-types.gen'

/** HTTP methods that appear as keys of a `paths` entry. */
type Method = 'get' | 'put' | 'post' | 'delete' | 'patch'

type SuccessCode = 200 | 201

/**
 * The JSON body of an operation's success response (200 or 201).
 *
 * Resolves to `never` for operations whose snapshot entry documents no
 * success schema yet — which is most of them; see the coverage note in the
 * generated file. Annotating the route's `openapi.responses` is what makes
 * a path usable here.
 */
export type ApiJson<
  TPath extends keyof paths,
  TMethod extends Method & keyof paths[TPath],
> = paths[TPath][TMethod] extends { responses: infer R }
  ? {
      [C in SuccessCode & keyof R]: R[C] extends {
        content: { 'application/json': infer J }
      }
        ? J
        : never
    }[SuccessCode & keyof R]
  : never

/**
 * The payload under the standard `{ data: ... }` envelope — what
 * `apiFetch(...).data` hands back.
 */
export type ApiData<
  TPath extends keyof paths,
  TMethod extends Method & keyof paths[TPath],
> =
  ApiJson<TPath, TMethod> extends { data: infer D }
    ? D
    : ApiJson<TPath, TMethod>
