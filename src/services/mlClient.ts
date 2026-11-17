export interface MlPrediction {
  class_index: number
  class_name: string
  confidence: number // 0-100
}
export interface MlResponse {
  top3: MlPrediction[]
  inference_ms: number
  model: string
}

export class MlUnavailableError extends Error {}

const ML_TIMEOUT_MS = () => Number(process.env.ML_TIMEOUT_MS) || 90_000 // a sleeping free-tier model service needs ~1 min to wake
const mlHeaders = (extra: Record<string, string> = {}) => ({ ...extra, ...(process.env.ML_API_KEY ? { 'x-api-key': process.env.ML_API_KEY } : {}) })

const ML_URL = () => {
  const url = process.env.ML_SERVICE_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8000')
  if (!url) throw new MlUnavailableError('ML_SERVICE_URL is not set on the backend')
  return url.replace(/\/$/, '')
}

/** Steps 4–7 of the flow: preprocess -> predict -> forwardPass -> top3Species (done by the Python model service). */
export async function predictImage(image: Buffer, contentType: string): Promise<MlResponse> {
  let r: Awaited<ReturnType<typeof fetch>>
  try {
    r = await fetch(`${ML_URL()}/predict`, {
      method: 'POST',
      headers: mlHeaders({ 'Content-Type': contentType }),
      body: new Uint8Array(image),
      signal: AbortSignal.timeout(ML_TIMEOUT_MS()),
    })
  } catch {
    throw new MlUnavailableError(`AI model service is not reachable at ${ML_URL()}`)
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => '')
    if (r.status === 401 || r.status === 403) {
      throw new MlUnavailableError('AI model service rejected the request (check ML_API_KEY on both services)')
    }
    if (r.status === 400 || r.status === 415 || r.status === 422) {
      throw Object.assign(new Error('The image could not be read'), { status: 400, detail })
    }
    throw new MlUnavailableError(`AI model service error (${r.status})`)
  }
  return (await r.json()) as MlResponse
}

export async function mlHealth(): Promise<unknown> {
  try {
    const r = await fetch(`${ML_URL()}/health`, { signal: AbortSignal.timeout(10_000) })
    return await r.json()
  } catch {
    return { status: 'unreachable' }
  }
}
