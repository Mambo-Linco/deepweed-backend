import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db/pool'
import { requireAdmin } from '../middleware/auth'
import type { Feedback } from '../types'

const router = Router()

// A farmer's feedback after an identification (is_correct / corrected species / comment) or a free message.
const feedbackSchema = z.object({
  message: z.string().max(2000).optional().default(''),
  is_correct: z.boolean().optional(),
  scan_id: z.string().uuid().optional(),
  corrected_weed_name: z.string().max(300).optional(),
}).refine(v => v.message.trim().length > 0 || v.is_correct !== undefined, {
  message: 'Provide a message or is_correct',
})

// Joined scan details so admins (and farmers) see what the feedback is about
const SCAN_COLUMNS = `s.weed_name AS scan_weed_name, s.confidence AS scan_confidence,
                      s.crop_type AS scan_crop_type, s.top3 AS scan_top3`

/**
 * @swagger
 * /api/feedback:
 *   post:
 *     summary: Send feedback (farmer)
 *     tags: [Feedback]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Feedback stored }
 */
router.post('/', async (req: Request, res: Response) => {
  const parsed = feedbackSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() })
    return
  }
  const { message, is_correct, scan_id, corrected_weed_name } = parsed.data
  const text = message.trim() || (is_correct ? 'Identification confirmed correct' : 'Identification marked incorrect')
  const [fb] = await query<Feedback>(
    `INSERT INTO feedback (user_id, message, is_correct, scan_id, corrected_weed_name)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.user!.userId, text, is_correct ?? null, scan_id ?? null, corrected_weed_name ?? null]
  )
  res.status(201).json(fb)
})

/**
 * @swagger
 * /api/feedback/my:
 *   get:
 *     summary: The current user's feedback, including admin replies
 *     tags: [Feedback]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of feedback with replies }
 */
router.get('/my', async (req: Request, res: Response) => {
  const items = await query<Feedback>(
    `SELECT f.*, ${SCAN_COLUMNS}
     FROM feedback f
     LEFT JOIN weed_scans s ON s.id = f.scan_id
     WHERE f.user_id = $1
     ORDER BY f.created_at DESC
     LIMIT 200`,
    [req.user!.userId]
  )
  res.json(items)
})

/**
 * @swagger
 * /api/feedback/summary:
 *   get:
 *     summary: Counts of feedback by status (admin only)
 *     tags: [Feedback]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ pending, reviewed, resolved, total }" }
 */
router.get('/summary', requireAdmin, async (_req: Request, res: Response) => {
  const rows = await query<{ status: string; count: string }>('SELECT status, COUNT(*) FROM feedback GROUP BY status')
  const out = { pending: 0, reviewed: 0, resolved: 0, total: 0 }
  for (const r of rows) {
    const n = Number(r.count)
    if (r.status in out) (out as Record<string, number>)[r.status] = n
    out.total += n
  }
  res.json(out)
})

/**
 * @swagger
 * /api/feedback:
 *   get:
 *     summary: List all farmer feedback with farmer and scan details (admin only)
 *     tags: [Feedback]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [pending, reviewed, resolved] } }
 *       - { in: query, name: limit, schema: { type: integer, default: 50 } }
 *       - { in: query, name: offset, schema: { type: integer, default: 0 } }
 *     responses:
 *       200: { description: Feedback list, newest first }
 */
router.get('/', requireAdmin, async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const offset = Number(req.query.offset) || 0
  const status = req.query.status as string | undefined

  const params: unknown[] = [limit, offset]
  let where = ''
  if (status) {
    if (!['pending', 'reviewed', 'resolved'].includes(status)) {
      res.status(400).json({ error: 'Invalid status' })
      return
    }
    params.push(status)
    where = `WHERE f.status = $${params.length}`
  }

  const items = await query<Feedback & { farmer_email: string; farmer_name: string }>(
    `SELECT f.*, u.email AS farmer_email,
            u.first_name || ' ' || u.last_name AS farmer_name,
            ${SCAN_COLUMNS}
     FROM feedback f
     JOIN users u ON u.id = f.user_id
     LEFT JOIN weed_scans s ON s.id = f.scan_id
     ${where}
     ORDER BY f.created_at DESC LIMIT $1 OFFSET $2`,
    params
  )
  res.json(items)
})

const patchSchema = z.object({
  status: z.enum(['pending', 'reviewed', 'resolved']).optional(),
  reply: z.string().trim().min(1).max(2000).optional(),
  admin_note: z.string().trim().min(1).max(2000).optional(), // legacy name for reply
}).refine(v => v.status !== undefined || v.reply !== undefined || v.admin_note !== undefined, {
  message: 'Provide status and/or reply',
})

/**
 * @swagger
 * /api/feedback/{id}:
 *   patch:
 *     summary: Mark feedback reviewed/resolved and/or reply to the farmer (admin only)
 *     tags: [Feedback]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status: { type: string, enum: [pending, reviewed, resolved] }
 *               reply:  { type: string, description: Message shown to the farmer }
 *     responses:
 *       200: { description: Updated feedback }
 *       404: { description: Not found }
 */
router.patch('/:id', requireAdmin, async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() })
    return
  }
  const status = parsed.data.status
  const reply = parsed.data.reply ?? parsed.data.admin_note

  // Replying marks the feedback as reviewed (unless a status is given) and flags the reply as unread for the farmer.
  const [fb] = await query<Feedback>(
    `UPDATE feedback
     SET status = CASE
           WHEN $1::text IS NOT NULL THEN $1::text
           WHEN $2::text IS NOT NULL AND status = 'pending' THEN 'reviewed'
           ELSE status END,
         admin_note = COALESCE($2, admin_note),
         replied_at = CASE WHEN $2::text IS NOT NULL THEN now() ELSE replied_at END,
         reply_seen_at = CASE WHEN $2::text IS NOT NULL THEN NULL ELSE reply_seen_at END,
         reviewed_by = $3,
         updated_at = now()
     WHERE id = $4
     RETURNING *`,
    [status ?? null, reply ?? null, req.user!.userId, req.params.id]
  )
  if (!fb) { res.status(404).json({ error: 'Not found' }); return }
  res.json(fb)
})

/**
 * @swagger
 * /api/feedback/{id}/seen:
 *   patch:
 *     summary: Farmer marks the admin's reply as read
 *     tags: [Feedback]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string, format: uuid } }
 *     responses:
 *       200: { description: Updated feedback }
 *       404: { description: Not found }
 */
router.patch('/:id/seen', async (req: Request, res: Response) => {
  const fb = await queryOne<Feedback>(
    `UPDATE feedback SET reply_seen_at = now()
     WHERE id = $1 AND user_id = $2 AND replied_at IS NOT NULL AND reply_seen_at IS NULL
     RETURNING *`,
    [req.params.id, req.user!.userId]
  )
  if (!fb) {
    // already seen, or not this user's feedback: don't leak which
    const own = await queryOne<Feedback>('SELECT * FROM feedback WHERE id = $1 AND user_id = $2', [req.params.id, req.user!.userId])
    if (!own) { res.status(404).json({ error: 'Not found' }); return }
    res.json(own)
    return
  }
  res.json(fb)
})

export default router
