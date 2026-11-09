// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Make a request-body schema reject keys it does not declare.
 *
 * A plain `z.object()` *strips* unknown keys: the parse succeeds and the key
 * is gone. On a request body that is a silent failure — a caller who sends
 * `{ "descripton": "…" }`, or a field this route never accepted, gets a 200
 * and an unchanged row, with nothing to say why. `apiHandler` runs every
 * `body:` schema through this function once, at route construction, so the
 * same body is a 400 naming the key instead.
 *
 * The conversion is deep — nested objects, arrays, unions, optionals and the
 * other wrappers are rebuilt with their objects made strict — and it only
 * changes objects that never chose a policy. An object that already says
 * what to do with extra keys (`.passthrough()` / `.loose()`, `.catchall(x)`,
 * `.strict()`) keeps that choice; its declared properties are still
 * converted. So the opt-out for a route that genuinely forwards arbitrary
 * keys is the one Zod already has: write `.passthrough()`.
 *
 * Two shapes are deliberately left alone:
 * - **Intersections.** Each side of `A.and(B)` sees the whole value, so a
 *   strict side would reject the other side's keys.
 * - **The output side of a pipe.** `z.object(…).transform(…)` is validated
 *   on its input; whatever the transform returns is the route's own value.
 *   (A `z.preprocess` pipe is the exception: its *output* is the schema the
 *   body is validated against, so that side is converted.)
 *
 * Clones keep their source as `parent`, so `.describe()` / `.meta()`
 * metadata is inherited. The OpenAPI document is still generated from the
 * route's original schema, not this one, so component `$ref`s survive.
 */

import { z } from 'zod'

type Schema = z.ZodType
type Def = Record<string, unknown> & { type: string }

const converted = new WeakMap<Schema, Schema>()

export function rejectUnknownKeys<T extends Schema>(schema: T): T {
  return strict(schema) as T
}

function strict(schema: Schema): Schema {
  const cached = converted.get(schema)
  if (cached) return cached
  const result = convert(schema)
  converted.set(schema, result)
  return result
}

function convert(schema: Schema): Schema {
  const def = schema._zod.def as Def
  const rebuild = (next: Record<string, unknown>): Schema =>
    schema.clone({ ...def, ...next } as never, { parent: true })

  switch (def.type) {
    case 'object': {
      const shape = def.shape as Record<string, Schema>
      let changed = def.catchall === undefined
      const nextShape: Record<string, Schema> = {}
      for (const [key, value] of Object.entries(shape)) {
        const next = strict(value)
        if (next !== value) changed = true
        nextShape[key] = next
      }
      if (!changed) return schema
      return rebuild({
        shape: nextShape,
        catchall: def.catchall ?? z.never(),
      })
    }

    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
      return child(schema, def, 'innerType', rebuild)

    case 'array':
      return child(schema, def, 'element', rebuild)

    case 'record':
      return child(schema, def, 'valueType', rebuild)

    case 'tuple': {
      const items = def.items as Array<Schema>
      const nextItems = items.map(strict)
      const rest = def.rest as Schema | null | undefined
      const nextRest = rest ? strict(rest) : rest
      if (nextRest === rest && nextItems.every((s, i) => s === items[i]))
        return schema
      return rebuild({ items: nextItems, rest: nextRest })
    }

    case 'union': {
      const options = def.options as Array<Schema>
      const nextOptions = options.map(strict)
      if (nextOptions.every((s, i) => s === options[i])) return schema
      return rebuild({ options: nextOptions })
    }

    case 'pipe': {
      const input = def.in as Schema
      const output = def.out as Schema
      // A preprocess pipe validates with its output side; any other pipe
      // validates with its input and the output is the route's own value.
      if ((input._zod.def as Def).type === 'transform') {
        const nextOut = strict(output)
        return nextOut === output ? schema : rebuild({ out: nextOut })
      }
      const nextIn = strict(input)
      return nextIn === input ? schema : rebuild({ in: nextIn })
    }

    case 'lazy': {
      const getter = def.getter as () => Schema
      return rebuild({ getter: () => strict(getter()) })
    }

    default:
      return schema
  }
}

/** Convert a wrapper's one inner schema, keeping the wrapper when it is unchanged. */
function child(
  schema: Schema,
  def: Def,
  key: string,
  rebuild: (next: Record<string, unknown>) => Schema,
): Schema {
  const inner = def[key] as Schema
  const next = strict(inner)
  return next === inner ? schema : rebuild({ [key]: next })
}

/**
 * Reject the keys of `value` that `schema` does not declare, and nothing else.
 *
 * For routes that hand a body on to a service which validates it against a
 * schema of its own — `ItemService.create` parses against the registered
 * item type — and whose errors should stay the service's. This runs the
 * strict form of that schema only to find unknown keys; every other issue is
 * left for the service to report in its own words.
 */
export function assertNoUnknownKeys(schema: z.ZodType, value: unknown): void {
  const result = rejectUnknownKeys(schema).safeParse(value)
  if (result.success) return
  const unknown = result.error.issues.filter(
    (issue) => issue.code === 'unrecognized_keys',
  )
  if (unknown.length > 0) throw new z.ZodError(unknown)
}
