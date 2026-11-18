// Settings read from the environment, with clear errors instead of mysterious 500s.
export class ConfigError extends Error {}

export function jwtSecret(): string {
  const s = process.env.JWT_SECRET?.trim()
  if (!s) throw new ConfigError('The server is missing its JWT_SECRET setting. Add JWT_SECRET (any long random text) in the hosting dashboard (Render: service > Environment).')
  return s
}

const TIMESPAN = /^\d+\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|y|year|years)$/i

// A blank or invalid JWT_EXPIRES_IN no longer breaks login: it falls back to 7 days.
export function jwtExpiresIn(): string | number {
  const v = (process.env.JWT_EXPIRES_IN ?? '').trim()
  if (/^\d+$/.test(v)) return Number(v) // plain number = seconds
  return TIMESPAN.test(v) ? v : '7d'
}
