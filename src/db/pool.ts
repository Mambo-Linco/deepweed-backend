// import { Pool } from 'pg'
// import dotenv from 'dotenv'

// dotenv.config()

// const dbUrl = process.env.DATABASE_URL ?? ''
// // Neon (and most hosted Postgres) require SSL even in development
// const needsSsl = process.env.NODE_ENV === 'production' || /sslmode=require|neon\.tech/.test(dbUrl)

// export const pool = new Pool({
//   connectionString: process.env.DATABASE_URL,
//   ssl: needsSsl ? { rejectUnauthorized: false } : false,
//   max: 10,
//   idleTimeoutMillis: 30000,
//   connectionTimeoutMillis: 5000,
// })

// pool.on('error', (err) => {
//   console.error('Unexpected DB pool error:', err)
// })

// export async function query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
//   const client = await pool.connect()
//   try {
//     const result = await client.query(sql, params)
//     return result.rows as T[]
//   } finally {
//     client.release()
//   }
// }

// export async function queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null> {
//   const rows = await query<T>(sql, params)
//   return rows[0] ?? null
// }
import { Pool } from 'pg'
import dotenv from 'dotenv'

// Only load .env locally; Render injects env vars directly in production
if (process.env.NODE_ENV !== 'production') {
  dotenv.config()
}

const dbUrl = process.env.DATABASE_URL ?? ''

// Force SSL only when the URL explicitly requests it, OR when connecting to
// Render's *external* host (which always requires SSL).
// Render's *internal* URL (host ends in .internal) does NOT support SSL.
const isRenderExternal = /\.render\.com/.test(dbUrl) && !/\.internal/.test(dbUrl)
const needsSsl =
  /sslmode=require/.test(dbUrl) ||
  /neon\.tech/.test(dbUrl) ||
  isRenderExternal

export const pool = new Pool({
  connectionString: dbUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
})

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err)
})

export async function query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(sql, params)
  return result.rows as T[]
}

export async function queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}