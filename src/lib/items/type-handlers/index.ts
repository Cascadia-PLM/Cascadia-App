import type { TypeHandler } from './types'

export type { TypeHandler }

const handlers = new Map<string, TypeHandler>()

export function registerTypeHandler(typeName: string, handler: TypeHandler) {
  handlers.set(typeName, handler)
}

export function getTypeHandler(typeName: string): TypeHandler | undefined {
  return handlers.get(typeName)
}
