// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { TypeHandler } from './types'

export type { TypeHandler }

const handlers = new Map<string, TypeHandler>()

export function registerTypeHandler(typeName: string, handler: TypeHandler) {
  handlers.set(typeName, handler)
}

export function getTypeHandler(typeName: string): TypeHandler | undefined {
  return handlers.get(typeName)
}
