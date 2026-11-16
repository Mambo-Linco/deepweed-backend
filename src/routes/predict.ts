import express, { Router, Request, Response } from 'express'
import { predictImage, MlUnavailableError, mlHealth } from '../services/mlClient'
import { findHerbicides } from '../services/herbicideMatch'

const router = Router()

const LOW_CONFIDENCE = 50 // percent

/**
 * @swagger
 * /api/predict:
 *   post:
 *     summary: Identify a weed from a photo (top-3 species + herbicide options)
 *     description: Send the raw image bytes as the request body (Content-Type image/jpeg, image/png or image/webp).
 *     tags: [Predict]
 *     requestBody:
 *       required: true
 *       content:
 *         image/jpeg: { schema: { type: string, format: binary } }
 *         image/png:  { schema: { type: string, format: binary } }
 *         image/webp: { schema: { type: string, format: binary } }
 *     responses:
 *       200: { description: Top-3 species with confidence and matching herbicide records }
 *       400: { description: Missing or unreadable image }
 *       503: { description: AI model service unavailable }
 */
router.post(
  '/',
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '10mb' }),
  async (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'Send an image as the request body (image/jpeg, image/png or image/webp)' })
      return
    }

    let ml
    try {
      ml = await predictImage(req.body, req.headers['content-type'] ?? 'image/jpeg')
    } catch (err) {
      if (err instanceof MlUnavailableError) {
        res.status(503).json({ error: err.message })
        return
      }
      if ((err as { status?: number }).status === 400) {
        res.status(400).json({ error: 'The image could not be read. Try a clear JPG or PNG photo.' })
        return
      }
      throw err
    }

    // Steps 8–10: query herbicides for each of the top-3 species
    const top3 = await Promise.all(
      ml.top3.map(async (p, i) => ({
        rank: i + 1,
        class_index: p.class_index,
        class_name: p.class_name,
        confidence: p.confidence,
        herbicides: await findHerbicides(p.class_name),
      }))
    )

    res.json({
      top3,
      low_confidence: (top3[0]?.confidence ?? 0) < LOW_CONFIDENCE,
      model: ml.model,
      inference_ms: ml.inference_ms,
    })
  }
)

/** GET /api/predict/status — is the AI model service up? */
router.get('/status', async (_req: Request, res: Response) => {
  res.json(await mlHealth())
})

export default router
