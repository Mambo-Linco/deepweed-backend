import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'
import dotenv from 'dotenv'
import 'express-async-errors' // makes async route errors reach the error handler (Express 4)
import { ZodError } from 'zod'

import authRouter from './routes/auth'
import scansRouter from './routes/scans'
import herbicideRouter from './routes/herbicide'
import feedbackRouter from './routes/feedback'
import { runMigrations } from './db/migrate'
import { ConfigError } from './config'
import predictRouter from './routes/predict'
import { authenticate } from './middleware/auth'

dotenv.config()

const app = express()
// Behind Render's proxy: needed for correct client IPs (rate limiting) and https detection
app.set('trust proxy', 1)

const PORT = Number(process.env.PORT) || 3000

// --- Database setup: tables are created/updated by the server itself ---------------------------------------
// The server starts even if the database is unreachable (wrong URL, sleeping, ...). It keeps retrying and
// reports the problem at /health, instead of crashing and leaving the web app with "cannot reach the server".
const dbState = { ready: false, attempts: 0, error: null as string | null }

function describeDbError(e: unknown): string {
  const err = e as { code?: string; message?: string }
  const msg = err?.message ?? ''
  if (!process.env.DATABASE_URL) return 'DATABASE_URL is not set'
  if (msg.includes('ADMIN_EMAIL')) return msg
  switch (err?.code) {
    case '28P01': case '28000': return 'database login failed (wrong user or password in DATABASE_URL)'
    case '3D000': return 'the database name in DATABASE_URL does not exist'
    case 'ENOTFOUND': case 'EAI_AGAIN': return 'database host not found (check DATABASE_URL)'
    case 'ECONNREFUSED': return 'the database refused the connection (check the host and port in DATABASE_URL)'
    case 'ETIMEDOUT': return 'connecting to the database timed out'
    case '42501': return 'the database user is not allowed to create tables or extensions'
  }
  if (/timeout/i.test(msg)) return 'connecting to the database timed out (it may be waking up)'
  if (/ssl|tls|certificate/i.test(msg)) return 'SSL problem connecting to the database'
  return `database setup failed${err?.code ? ` (code ${err.code})` : ''}: see the server logs`
}

async function initDatabase() {
  for (;;) {
    dbState.attempts++
    try {
      await runMigrations()
      dbState.ready = true
      dbState.error = null
      console.log('Database ready.')
      return
    } catch (e) {
      dbState.error = describeDbError(e)
      console.error(`Database setup failed (attempt ${dbState.attempts}): ${dbState.error}`)
      console.error(e)
      await new Promise((r) => setTimeout(r, 15_000))
    }
  }
}

// --- CORS: one policy, must come BEFORE routes ---
const isProd = process.env.NODE_ENV === 'production'
// local origins are only allowed while developing; a hosted server accepts just ALLOWED_ORIGINS
const defaultOrigins = isProd ? [] : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000']
const envOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean)
const allowedOrigins = Array.from(new Set([...defaultOrigins, ...envOrigins]))
if (isProd && !process.env.JWT_SECRET?.trim()) console.error('ERROR: JWT_SECRET is not set - logins will fail until you add it.')
if (isProd && !allowedOrigins.length) console.warn('WARNING: ALLOWED_ORIGINS is empty - browsers will be blocked by CORS. Set it to your web app address.')
app.use(cors({ origin: allowedOrigins, credentials: true }))

// Security & parsing
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(express.json({ limit: '2mb' }))

// Rate limiting
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, please slow down.' },
}))
// Until the database is ready, answer API calls with a clear message instead of a crash
app.use('/api', (req, res, next) => {
  if (dbState.ready || req.path.startsWith('/predict/status')) { next(); return }
  res.status(503).json({ error: 'The database is not ready yet. Try again in a moment.', problem: dbState.error })
})

app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts.' },
}))

// Swagger / OpenAPI docs
const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'DeepWeed API',
      version: '1.0.0',
      description: 'REST API for the DeepWeed smart weed detection system',
      contact: { name: 'DeepWeed Team' },
    },
    servers: [{ url: isProd ? '/' : `http://localhost:${PORT}`, description: isProd ? 'This server' : 'Local development' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Obtain a token via POST /api/auth/login, then prefix with "Bearer "',
        },
      },
    },
    tags: [
      { name: 'Auth', description: 'Register, login, and profile' },
      { name: 'Scans', description: 'Weed scan history (per-farmer)' },
      { name: 'Herbicide', description: 'Herbicide database (read: public, write: admin)' },
      { name: 'Feedback', description: 'Farmer feedback and admin review' },
      { name: 'Predict', description: 'Weed identification from a photo (AI model)' },
    ],
  },
  apis: ['./src/routes/*.ts'],
})

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'DeepWeed API Docs',
  swaggerOptions: { persistAuthorization: true },
}))
app.get('/openapi.json', (_req, res) => res.json(swaggerSpec))

// Routes
app.use('/api/auth/me', authenticate)         // protect /me only
app.use('/api/auth', authRouter)
app.use('/api/scans', authenticate, scansRouter)
app.use('/api/herbicide', herbicideRouter)    // GET is public; auth applied per-route
app.use('/api/feedback', authenticate, feedbackRouter)
app.use('/api/predict', predictRouter)       // image -> top-3 species + herbicides (public)

// Health check
app.get('/health', (_req, res) => {
  // always 200 so the platform keeps the service up and you can read what is wrong
  res.json({
    status: dbState.ready ? 'ok' : 'degraded',
    db: dbState.ready ? 'ready' : { ready: false, attempts: dbState.attempts, problem: dbState.error },
    environment: process.env.NODE_ENV ?? 'development',
    cors_allowed_origins: allowedOrigins,
    ml_service_configured: !!process.env.ML_SERVICE_URL,
    jwt_secret_set: !!process.env.JWT_SECRET?.trim(),
  })
})

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ConfigError) {
    console.error(err.message)
    res.status(503).json({ error: err.message })
    return
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', details: err.flatten() })
    return
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Payload too large' })
    return
  }
  // Postgres: unique violation (e.g. same weed + herbicide + crop added twice)
  if (err?.code === '23505') {
    res.status(409).json({ error: 'A record with the same weed, herbicide and crop already exists' })
    return
  }
  // Postgres: invalid text representation (e.g. malformed UUID in the URL)
  if (err?.code === '22P02') {
    res.status(400).json({ error: 'Invalid identifier' })
    return
  }
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`\nDeepWeed API listening on port ${PORT} (${isProd ? 'production' : 'development'})`)
  console.log('  Swagger docs → /docs   Health check → /health\n')
  void initDatabase()
})
export default app
