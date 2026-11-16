import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db/pool'
import { authenticate, requireAdmin } from '../middleware/auth'
import type { Herbicide } from '../types'

const router = Router()

// Empty strings from forms are stored as NULL
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : v), z.string().max(max).optional())

const herbicideSchema = z.object({
  weed_name: z.string().trim().min(1).max(300),
  herbicide_name: z.string().trim().min(1).max(200),
  active_ingredient: optionalText(300),
  dosage: z.string().trim().min(1).max(500),
  application_method: optionalText(2000),   // application measures: how to apply
  application_timing: optionalText(1000),   // correct time to apply
  crop: optionalText(100),                  // crop to apply on ("All crops" or a specific crop)
  mode_of_action: optionalText(200),        // herbicide group, useful for resistance rotation
  pre_harvest_interval: optionalText(100),  // e.g. "14 days"
  safety_notes: optionalText(2000),
})
type HerbicideInput = z.infer<typeof herbicideSchema>
const values = (h: HerbicideInput) => [
  h.weed_name, h.herbicide_name, h.active_ingredient ?? null, h.dosage, h.application_method ?? null,
  h.application_timing ?? null, h.crop ?? null, h.mode_of_action ?? null, h.pre_harvest_interval ?? null, h.safety_notes ?? null,
]

/**
 * @swagger
 * /api/herbicide:
 *   get:
 *     summary: List herbicide records (public — no auth required)
 *     tags: [Herbicide]
 *     parameters:
 *       - in: query
 *         name: q
 *         description: Search by weed name or herbicide name
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: List of herbicide records
 */
router.get('/', async (req: Request, res: Response) => {
  const q = (req.query.q as string | undefined)?.toLowerCase()
  const limit = Math.min(Number(req.query.limit) || 100, 500)

  if (q) {
    const records = await query<Herbicide>(
      `SELECT * FROM herbicide_db
       WHERE LOWER(weed_name) LIKE $1 OR LOWER(herbicide_name) LIKE $1
          OR LOWER(COALESCE(crop, '')) LIKE $1 OR LOWER(COALESCE(active_ingredient, '')) LIKE $1
       ORDER BY weed_name, herbicide_name LIMIT $2`,
      [`%${q}%`, limit]
    )
    res.json(records)
    return
  }

  const records = await query<Herbicide>(
    'SELECT * FROM herbicide_db ORDER BY weed_name, herbicide_name LIMIT $1',
    [limit]
  )
  res.json(records)
})

/**
 * @swagger
 * /api/herbicide/{id}:
 *   get:
 *     summary: Get a single herbicide record by ID
 *     tags: [Herbicide]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Herbicide record
 *       404:
 *         description: Not found
 */
router.get('/:id', async (req: Request, res: Response) => {
  const record = await queryOne<Herbicide>('SELECT * FROM herbicide_db WHERE id = $1', [req.params.id])
  if (!record) { res.status(404).json({ error: 'Not found' }); return }
  res.json(record)
})

/**
 * @swagger
 * /api/herbicide:
 *   post:
 *     summary: Add a new herbicide record (admin only)
 *     tags: [Herbicide]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [weed_name, herbicide_name, dosage]
 *             properties:
 *               weed_name:          { type: string }
 *               herbicide_name:     { type: string }
 *               active_ingredient:  { type: string }
 *               dosage:             { type: string }
 *               application_method: { type: string, description: Application measures }
 *               application_timing: { type: string, description: Correct time to apply }
 *               crop:               { type: string, description: Crop to apply on }
 *               mode_of_action:     { type: string }
 *               pre_harvest_interval: { type: string }
 *               safety_notes:       { type: string }
 *     responses:
 *       201:
 *         description: Record created
 *       403:
 *         description: Admin only
 */
router.post('/', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const parsed = herbicideSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() })
    return
  }
  const [record] = await query<Herbicide>(
    `INSERT INTO herbicide_db
       (weed_name, herbicide_name, active_ingredient, dosage, application_method, application_timing, crop,
        mode_of_action, pre_harvest_interval, safety_notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [...values(parsed.data), req.user!.userId]
  )
  res.status(201).json(record)
})

/**
 * @swagger
 * /api/herbicide/{id}:
 *   put:
 *     summary: Update a herbicide record (admin only)
 *     tags: [Herbicide]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/HerbicideUpdate'
 *     responses:
 *       200:
 *         description: Updated record
 *       404:
 *         description: Not found
 */
router.put('/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const parsed = herbicideSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() })
    return
  }
  const [record] = await query<Herbicide>(
    `UPDATE herbicide_db
     SET weed_name=$1, herbicide_name=$2, active_ingredient=$3, dosage=$4, application_method=$5,
         application_timing=$6, crop=$7, mode_of_action=$8, pre_harvest_interval=$9, safety_notes=$10,
         updated_at=now()
     WHERE id=$11
     RETURNING *`,
    [...values(parsed.data), req.params.id]
  )
  if (!record) { res.status(404).json({ error: 'Not found' }); return }
  res.json(record)
})

/**
 * @swagger
 * /api/herbicide/{id}:
 *   delete:
 *     summary: Delete a herbicide record (admin only)
 *     tags: [Herbicide]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Deleted
 */
router.delete('/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const rows = await query('DELETE FROM herbicide_db WHERE id = $1 RETURNING id', [req.params.id])
  if (!rows.length) { res.status(404).json({ error: 'Not found' }); return }
  res.status(204).send()
})

export default router
