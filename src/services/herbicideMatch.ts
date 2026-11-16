import { query } from '../db/pool'
import type { Herbicide } from '../types'

/**
 * Turn a model class label such as
 *   "Blackjack (Bidens pilosa  Tsine)"
 *   "Amaranthus hybridus (Smooth pigweed  Bonongwe)"
 *   "Chaarendo"
 * into search terms that can be matched against herbicide_db.weed_name.
 */
export function searchTerms(className: string): string[] {
  const terms = new Set<string>()
  const open = className.indexOf('(')
  const base = (open === -1 ? className : className.slice(0, open)).trim()
  const inner = open === -1 ? '' : className.slice(open + 1).replace(/\)[^)]*$/, '')

  if (base) terms.add(base)
  // inner parts are separated by 2+ spaces: "Bidens pilosa  Tsine"
  for (const part of inner.split(/\s{2,}/)) {
    const t = part.replace(/\bspp\.?/i, '').trim()
    if (t) terms.add(t)
  }
  // plain binomial / genus from the base (e.g. "Amaranthus hybridus")
  const genus = base.split(/\s+/)[0]
  if (/^[A-Z][a-z]+$/.test(genus) && base.split(/\s+/).length >= 2 && /^[a-z]+$/.test(base.split(/\s+/)[1])) {
    terms.add(`${genus} ${base.split(/\s+/)[1]}`)
  }
  // ignore very short / generic fragments to avoid false matches
  return [...terms].map(t => t.toLowerCase()).filter(t => t.length >= 5)
}

/** Step 8–10 of the flow: queryHerbicides(speciesIds) -> herbicideList() */
export async function findHerbicides(className: string): Promise<Herbicide[]> {
  const terms = searchTerms(className)
  if (!terms.length) return []
  const patterns = terms.map(t => `%${t.replace(/[%_\\]/g, m => '\\' + m)}%`)
  return query<Herbicide>(
    `SELECT * FROM herbicide_db
     WHERE LOWER(weed_name) LIKE ANY($1::text[])
     ORDER BY weed_name, herbicide_name`,
    [patterns]
  )
}
