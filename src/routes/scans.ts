import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db/pool'
import type { WeedScan } from '../types'

const router = Router()

const scanSchema = z.object({
  weed_name: z.string().min(1),
  confidence: z.number().min(0).max(100),
  crop_type: z.string().default('Unknown'),
  image_url: z.string().url().optional(),
  recommendations: z.array(z.string()).optional(),
  top3: z.array(z.object({
    class_name: z.string(),
    confidence: z.number(),
  })).max(5).optional(),
})

/**
 * @swagger
 * /api/scans:
 *   get:
 *     summary: List all weed scans for the current farmer
 *     tags: [Scans]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *       - in: query
 *         name: crop_type
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated list of scans
 */
router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100)
  const offset = Number(req.query.offset) || 0
  const cropFilter = req.query.crop_type as string | undefined

  const params: unknown[] = [req.user!.userId, limit, offset]
  let where = 'WHERE user_id = $1'
  if (cropFilter) {
    params.push(cropFilter)
    where += ` AND crop_type = $${params.length}`
  }

  const scans = await query<WeedScan>(
    `SELECT * FROM weed_scans ${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    params
  )
  const countParams = cropFilter ? [req.user!.userId, cropFilter] : [req.user!.userId]
  const countWhere = cropFilter ? 'WHERE user_id = $1 AND crop_type = $2' : 'WHERE user_id = $1'
  const [{ count }] = await query<{ count: string }>(
    `SELECT COUNT(*) FROM weed_scans ${countWhere}`,
    countParams
  )

  res.json({ data: scans, total: Number(count), limit, offset })
})

/**
 * @swagger
 * /api/scans/{id}:
 *   get:
 *     summary: Get a single scan by ID
 *     tags: [Scans]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Scan record
 *       404:
 *         description: Not found
 */
router.get('/:id', async (req: Request, res: Response) => {
  const scan = await queryOne<WeedScan>(
    'SELECT * FROM weed_scans WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user!.userId]
  )
  if (!scan) { res.status(404).json({ error: 'Scan not found' }); return }
  res.json(scan)
})

/**
 * @swagger
 * /api/scans:
 *   post:
 *     summary: Record a new weed scan result
 *     tags: [Scans]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [weed_name, confidence]
 *             properties:
 *               weed_name:       { type: string }
 *               confidence:      { type: number, minimum: 0, maximum: 100 }
 *               crop_type:       { type: string }
 *               image_url:       { type: string, format: uri }
 *               recommendations: { type: array, items: { type: string } }
 *     responses:
 *       201:
 *         description: Scan created
 */
router.post('/', async (req: Request, res: Response) => {
  const parsed = scanSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() })
    return
  }
  const { weed_name, confidence, crop_type, image_url, recommendations, top3 } = parsed.data

  const [scan] = await query<WeedScan>(
    `INSERT INTO weed_scans (user_id, weed_name, confidence, crop_type, image_url, recommendations, top3)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [req.user!.userId, weed_name, confidence, crop_type, image_url ?? null, recommendations ?? null, top3 ? JSON.stringify(top3) : null]
  )
  res.status(201).json(scan)
})

/**
 * @swagger
 * /api/scans/{id}:
 *   delete:
 *     summary: Delete a scan
 *     tags: [Scans]
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
 *       404:
 *         description: Not found
 */
router.delete('/:id', async (req: Request, res: Response) => {
  const rows = await query(
    'DELETE FROM weed_scans WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user!.userId]
  )
  if (!rows.length) { res.status(404).json({ error: 'Scan not found' }); return }
  res.status(204).send()
})

export default router
