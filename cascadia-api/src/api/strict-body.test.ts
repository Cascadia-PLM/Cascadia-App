// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { rejectUnknownKeys } from './strict-body'

const unknownKeys = (result: z.ZodSafeParseResult<unknown>) =>
  result.success
    ? []
    : result.error.issues
        .filter((i) => i.code === 'unrecognized_keys')
        .map((i) => [...i.path, ...i.keys].join('.'))

describe('rejectUnknownKeys', () => {
  it('rejects unknown keys at every depth a body can nest them', () => {
    const schema = rejectUnknownKeys(
      z.object({
        name: z.string(),
        meta: z.object({ a: z.number() }).optional(),
        lines: z.array(z.object({ qty: z.number() })),
        byKey: z.record(z.string(), z.object({ x: z.number() })),
        kind: z.discriminatedUnion('t', [
          z.object({ t: z.literal('a'), a: z.string() }),
          z.object({ t: z.literal('b'), b: z.string() }),
        ]),
        later: z.lazy(() => z.object({ y: z.number() })).nullable(),
        pre: z.preprocess((v) => v, z.object({ p: z.number() })),
      }),
    )

    const valid = {
      name: 'n',
      meta: { a: 1 },
      lines: [{ qty: 1 }],
      byKey: { k: { x: 1 } },
      kind: { t: 'a', a: 'x' },
      later: { y: 1 },
      pre: { p: 1 },
    }
    expect(schema.safeParse(valid).success).toBe(true)

    expect(unknownKeys(schema.safeParse({ ...valid, nmae: 'typo' }))).toEqual([
      'nmae',
    ])
    expect(
      unknownKeys(schema.safeParse({ ...valid, meta: { a: 1, b: 2 } })),
    ).toEqual(['meta.b'])
    expect(
      unknownKeys(schema.safeParse({ ...valid, lines: [{ qty: 1, z: 1 }] })),
    ).toEqual(['lines.0.z'])
    expect(
      unknownKeys(schema.safeParse({ ...valid, byKey: { k: { x: 1, q: 1 } } })),
    ).toEqual(['byKey.k.q'])
    expect(
      unknownKeys(schema.safeParse({ ...valid, later: { y: 1, w: 1 } })),
    ).toEqual(['later.w'])
    expect(
      unknownKeys(schema.safeParse({ ...valid, pre: { p: 1, r: 1 } })),
    ).toEqual(['pre.r'])
    expect(
      schema.safeParse({ ...valid, kind: { t: 'a', a: 'x', b: 'y' } }).success,
    ).toBe(false)
  })

  it('keeps an explicit passthrough, and still checks what it declares', () => {
    const schema = rejectUnknownKeys(
      z.object({ known: z.object({ a: z.number() }) }).passthrough(),
    )
    const ok = schema.safeParse({ known: { a: 1 }, extra: true })
    expect(ok.success && ok.data).toEqual({ known: { a: 1 }, extra: true })
    expect(
      unknownKeys(schema.safeParse({ known: { a: 1, b: 2 }, extra: true })),
    ).toEqual(['known.b'])
  })

  it('does not change the source schema', () => {
    const source = z.object({ a: z.number() })
    rejectUnknownKeys(source)
    expect(source.safeParse({ a: 1, b: 2 }).success).toBe(true)
  })

  it('keeps refinements and descriptions', () => {
    const schema = rejectUnknownKeys(
      z
        .object({ from: z.number(), to: z.number().describe('upper bound') })
        .refine((v) => v.from <= v.to, { path: ['to'] }),
    )
    expect(schema.safeParse({ from: 2, to: 1 }).success).toBe(false)
    const shape = (schema as unknown as z.ZodObject).shape as
      Record<string, z.ZodType> | undefined
    // The refined object is the object itself in Zod 4.
    expect(shape?.to?.description).toBe('upper bound')
  })
})
