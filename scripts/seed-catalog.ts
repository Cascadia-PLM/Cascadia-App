/**
 * Component Catalog Seed Script
 *
 * Thin CLI shim around `CatalogSeedService.run()`. Safe to re-run —
 * categories use onConflictDoNothing on slug; entries are inserted
 * unconditionally and duplicate-insert errors are caught and counted as
 * skipped.
 *
 * Usage: npx tsx scripts/seed-catalog.ts
 */

import { CatalogSeedService } from '../src/lib/services/CatalogSeedService.ts'

async function main() {
  console.log('=== Component Catalog Seed ===\n')

  const result = await CatalogSeedService.run()

  console.log(`  ${result.categoriesReady} categories ready`)
  console.log(
    `  ${result.inserted} entries inserted, ${result.skipped} skipped`,
  )
  console.log('\nDone!')
  process.exit(0)
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
