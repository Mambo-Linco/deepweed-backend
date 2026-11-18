import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import type { JwtPayload } from '../types'
import { jwtSecret } from '../config'

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' })
    return
  }
  const token = header.slice(7)
  let secret: string
  try { secret = jwtSecret() } catch (e) { next(e); return } // missing server setting: report it, don't blame the token
  try {
    const payload = jwt.verify(token, secret) as JwtPayload
    req.user = payload
    next()
  } catch {
    res.status(401).json({ error: 'Token expired or invalid' })
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' })
    return
  }
  next()
}
