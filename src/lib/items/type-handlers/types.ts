import type { TransactionClient } from '@/lib/db'

/**
 * Interface for type-specific database operations.
 * Each item type implements this to handle its own table.
 */
export interface TypeHandler {
  insert: (itemId: string, data: any, tx?: TransactionClient) => Promise<void>
  get: (itemId: string, tx?: TransactionClient) => Promise<any>
  update: (itemId: string, data: any, tx?: TransactionClient) => Promise<void>
}
