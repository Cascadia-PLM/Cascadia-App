import { eq } from 'drizzle-orm'
import { db } from '../src/lib/db'
import { branches, changeOrders, items } from '../src/lib/db/schema'

async function check() {
  // Get all ECO branches
  console.log('All ECO branches:')
  const ecoBranches = await db
    .select()
    .from(branches)
    .where(eq(branches.branchType, 'eco'))

  for (const b of ecoBranches) {
    console.log(`  ${b.name}: isArchived=${b.isArchived}`)
  }

  // Get all change orders
  console.log('\nAll change orders:')
  const allCOs = await db.select().from(changeOrders)

  for (const co of allCOs) {
    // Get item state and number separately
    const item = await db
      .select({ state: items.state, itemNumber: items.itemNumber })
      .from(items)
      .where(eq(items.id, co.itemId))
      .limit(1)
      .then((r) => r.at(0))

    console.log(
      `  ${item?.itemNumber}: state=${item?.state}, closedAt=${co.closedAt ? 'yes' : 'no'}`,
    )
  }
}

check()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
