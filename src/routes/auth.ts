import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { jwtSecret, jwtExpiresIn } from '../config'
import { z } from 'zod'
import { query, queryOne } from '../db/pool'
import type { User } from '../types'
const router = Router()
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  farm_location: z.string().optional(),
  primary_crop: z.string().optional(),
})
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})
/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new farmer account
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, first_name, last_name]
 *             properties:
 *               email:        { type: string, format: email }
 *               password:     { type: string, minLength: 8 }
 *               first_name:   { type: string }
 *               last_name:    { type: string }
 *               farm_location:{ type: string }
 *               primary_crop: { type: string }
 *     responses:
 *       201:
 *         description: Account created; returns JWT token
 *       400:
 *         description: Validation error or email already taken
 */
router.post('/register', async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() })
    return
  }
  const { email, password, first_name, last_name, farm_location, primary_crop } = parsed.data
  const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email])
  if (existing) {
    res.status(400).json({ error: 'Email already registered' })
    return
  }
  const password_hash = await bcrypt.hash(password, 10)
  const [user] = await query<User>(
    `INSERT INTO users (email, password_hash, first_name, last_name, farm_location, primary_crop)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, email, first_name, last_name, role, farm_location, primary_crop, created_at`,
    [email, password_hash, first_name, last_name, farm_location ?? null, primary_crop ?? 'Maize']
  )
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    jwtSecret(),
    { expiresIn: jwtExpiresIn() as never }
  )
  res.status(201).json({ token, user })
})
/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Sign in and receive a JWT token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:    { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Login successful; returns JWT token and user profile
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() })
    return
  }
  const { email, password } = parsed.data
  const user = await queryOne<User & { password_hash: string }>(
    'SELECT * FROM users WHERE email = $1',
    [email]
  )
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    res.status(401).json({ error: 'Invalid email or password' })
    return
  }
  const { password_hash: _, ...safeUser } = user
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    jwtSecret(),
    { expiresIn: jwtExpiresIn() as never }
  )
  res.json({ token, user: safeUser })
})
/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Get current authenticated user's profile
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile
 *       401:
 *         description: Unauthorized
 */
router.get('/me', async (req: Request, res: Response) => {
  // authenticate middleware added in index.ts
  const user = await queryOne<User>(
    'SELECT id, email, first_name, last_name, role, farm_location, primary_crop, created_at FROM users WHERE id = $1',
    [req.user!.userId]
  )
  res.json(user)
})
export default router
