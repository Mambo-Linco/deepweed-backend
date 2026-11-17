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
import predictRouter from './routes/predict'
import { authenticate } from './middleware/auth'

dotenv.config()

const app = express()
// Behind Render's proxy: needed for correct client IPs (rate limiting) and https detection
app.set('trust proxy', 1)

const PORT = Number(process.env.PORT) || 3000

// --- CORS: one policy, must come BEFORE routes ---
const isProd = process.env.NODE_ENV === 'production'
// local origins are only allowed while developing; a hosted server accepts just ALLOWED_ORIGINS
const defaultOrigins = isProd ? [] : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000']
const envOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean)
const allowedOrigins = Array.from(new Set([...defaultOrigins, ...envOrigins]))
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
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
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
})
export default app
