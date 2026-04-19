import postgres from 'postgres'

const sql = postgres(
  process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/cascadia',
)

async function main() {
  const tables = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_name LIKE 'ai_%'
    ORDER BY table_name
  `
  console.log('AI tables in database:')
  tables.forEach((t) => console.log('  -', t.table_name))
  await sql.end()
}

main()
