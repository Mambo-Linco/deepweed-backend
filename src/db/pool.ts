import { Pool } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const dbUrl = process.env.DATABASE_URL ?? ''
// Neon (and most hosted Postgres) require SSL even in development
const needsSsl = process.env.NODE_ENV === 'production' || /sslmode=require|neon\.tech/.test(dbUrl)

// `sslmode=` in the URL would override the ssl option below (newer pg treats `require` as strict verify-full),
// so it is removed from the URL; SSL is configured explicitly instead.
const connectionString = dbUrl
  .replace(/([?&])sslmode=[^&]*(&|$)/, (_m, p1: string, p2: string) => (p2 ? p1 : ''))
  .replace(/[?&]$/, '')

export const pool = new Pool({
  connectionString: connectionString || undefined,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000, // a sleeping free-tier database needs a moment to wake
})

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err)
})

export async function query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
  const client = await pool.connect()
  try {
    const result = await client.query(sql, params)
    return result.rows as T[]
  } finally {
    client.release()
  }
}

export async function queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}
