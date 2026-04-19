import { sql } from 'drizzle-orm'
import { db } from '../src/lib/db'

async function check() {
  // Check constraints
  const constraints = await db.execute(sql`
    SELECT conname, pg_get_constraintdef(oid) as definition
    FROM pg_constraint
    WHERE conrelid = 'items'::regclass
    AND contype = 'u'
  `)
  console.log('Unique constraints on items table:')
  console.log(JSON.stringify(constraints, null, 2))

  // Check for items with revision '-'
  const revMinusItems = await db.execute(sql`
    SELECT item_number, revision, design_id, name
    FROM items
    WHERE revision = '-'
    LIMIT 20
  `)
  console.log('\nItems with revision "-":')
  console.log(JSON.stringify(revMinusItems, null, 2))

  // Check for MBOM designs
  const mbomDesigns = await db.execute(sql`
    SELECT id, code, name, design_type
    FROM designs
    WHERE design_type = 'Manufacturing'
    LIMIT 10
  `)
  console.log('\nManufacturing designs:')
  console.log(JSON.stringify(mbomDesigns, null, 2))

  process.exit(0)
}

check().catch((e) => {
  console.error('Error:', e.message)
  process.exit(1)
})
