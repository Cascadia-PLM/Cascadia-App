import postgres from 'postgres'

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  console.error('Error: DATABASE_URL environment variable is required')
  process.exit(1)
}

async function resetDatabase() {
  const sql = postgres(connectionString, { max: 1 })

  try {
    console.log('Dropping all tables...')

    // Drop all tables in the correct order
    await sql`DROP TABLE IF EXISTS workflow_history CASCADE`
    await sql`DROP TABLE IF EXISTS auth_events CASCADE`
    await sql`DROP TABLE IF EXISTS item_relationships CASCADE`
    await sql`DROP TABLE IF EXISTS change_orders CASCADE`
    await sql`DROP TABLE IF EXISTS documents CASCADE`
    await sql`DROP TABLE IF EXISTS parts CASCADE`
    await sql`DROP TABLE IF EXISTS workflow_instances CASCADE`
    await sql`DROP TABLE IF EXISTS workflow_steps CASCADE`
    await sql`DROP TABLE IF EXISTS workflow_definitions CASCADE`
    await sql`DROP TABLE IF EXISTS sessions CASCADE`
    await sql`DROP TABLE IF EXISTS user_roles CASCADE`
    await sql`DROP TABLE IF EXISTS items CASCADE`
    await sql`DROP TABLE IF EXISTS users CASCADE`
    await sql`DROP TABLE IF EXISTS roles CASCADE`

    console.log('All tables dropped successfully!')
  } catch (error) {
    console.error('Error dropping tables:', error)
  } finally {
    await sql.end()
  }
}

resetDatabase()
