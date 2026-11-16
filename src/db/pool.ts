import { Pool } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const dbUrl = process.env.DATABASE_URL ?? ''
// Neon (and most hosted Postgres) require SSL even in development
const needsSsl = process.env.NODE_ENV === 'production' || /sslmode=require|neon\.tech/.test(dbUrl)

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
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
