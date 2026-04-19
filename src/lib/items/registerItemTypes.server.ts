/**
 * Server-Side Item Type Registration
 *
 * Registers all item types for server-side use (API routes, data validation).
 * Shared definitions come from item-type-definitions.ts; this file only
 * adds dummy components (server has no React rendering).
 */

import { ItemTypeRegistry } from './registry'
import { ITEM_TYPE_DEFINITIONS } from './item-type-definitions'
import { itemLogger } from '@/lib/logging/logger'

// Dummy components for server-side registration (no React on server)
const DummyComponent = () => null

for (const def of Object.values(ITEM_TYPE_DEFINITIONS)) {
  ItemTypeRegistry.register({
    ...def,
    components: {
      form: DummyComponent as any,
      table: DummyComponent as any,
      detail: DummyComponent as any,
    },
  })
}

/**
 * Initialize the registry to load runtime configurations from database.
 * This runs asynchronously but the registry will work with code defaults
 * until runtime configs are loaded.
 */
ItemTypeRegistry.initialize()
  .then(() => {
    itemLogger.info('Registry initialized with runtime configurations')
  })
  .catch((error) => {
    itemLogger.error({ err: error }, 'Failed to initialize registry')
    // Continue with code-only definitions if DB init fails
  })
