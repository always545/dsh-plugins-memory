/**
 * Salience: how much a memory record still deserves attention.
 *
 * Two signals replace "age alone":
 *
 * - importance: derived once from what the record contains (change type,
 *   whether the model explained it, how many files) or supplied explicitly;
 * - decay: an Ebbinghaus-style half-life, slowed down by retrieval
 *   reinforcement (`hits`), so a record that keeps being recalled stays alive.
 *
 * The retention plan and the prompt ranking both consume these functions, so a
 * pinned decision cannot silently age out and a chore record cannot crowd out a
 * fix forever.
 */

/** Baseline importance per change type, in [0, 1]. */
export const TYPE_IMPORTANCE = Object.freeze({
  feature: 0.85,
  fix: 0.7,
  refactor: 0.75,
  config: 0.65,
  test: 0.5,
  docs: 0.45,
  other: 0.4,
  chore: 0.3,
})

const DAY_MS = 86_400_000

/**
 * Clamp a number into [0, 1].
 * @param {number} value candidate
 * @returns {number} clamped value
 */
function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Derive importance for a record that does not carry one.
 * @param {object} turn turn record
 * @returns {number} importance in [0, 1]
 */
export function deriveImportance(turn) {
  const type = typeof turn?.type === 'string' ? turn.type : 'other'
  let score = TYPE_IMPORTANCE[type] ?? TYPE_IMPORTANCE.other
  if (typeof turn?.subject === 'string' && turn.subject.trim()) score += 0.05
  if (typeof turn?.detail === 'string' && turn.detail.trim().length >= 60) score += 0.05
  const files = Array.isArray(turn?.files) ? turn.files.length : 0
  score += Math.min(0.08, files * 0.02)
  if (turn?.source === 'agent') score += 0.05
  if (turn?.pinned === true) score = Math.max(score, 0.9)
  return clamp01(score)
}

/**
 * Importance of a record: the stored value when present, otherwise derived.
 * @param {object} turn turn record
 * @returns {number} importance in [0, 1]
 */
export function storedImportance(turn) {
  if (Number.isFinite(turn?.importance)) return clamp01(turn.importance)
  return deriveImportance(turn)
}

/**
 * @param {object} turn turn record
 * @returns {boolean} whether the record is pinned against forgetting
 */
export function isPinned(turn) {
  return turn?.pinned === true
}

/**
 * @param {unknown} iso ISO timestamp
 * @param {number} now reference time
 * @returns {number} age in days, never negative
 */
function ageInDays(iso, now) {
  const parsed = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, now - parsed) / DAY_MS
}

/**
 * Decayed attention for one record.
 *
 * `0.5 ** (age / halfLife)` for the base curve, multiplied by up to 1.5 from
 * retrieval reinforcement, capped at 1.2 so fresh records still lead.
 * @param {object} turn turn record
 * @param {object} input
 * @param {number} input.now reference time
 * @param {object} input.config effective config
 * @returns {number} decay factor in [0, 1.2]
 */
export function decayFactor(turn, { now, config }) {
  const halfLife = Math.max(1, Number(config?.importanceHalfLifeDays) || 21)
  const base = Math.pow(0.5, ageInDays(turn?.at, now) / halfLife)
  const hits = Number.isFinite(turn?.hits) ? Math.max(0, turn.hits) : 0
  const reinforcement = 1 + Math.min(0.5, hits * 0.05)
  return Math.min(1.2, base * reinforcement)
}

/**
 * Combined salience in [0, 1].
 * @param {object} turn turn record
 * @param {{ now: number, config: object }} input salience inputs
 * @returns {number} salience
 */
export function salience(turn, input) {
  return clamp01(storedImportance(turn) * Math.min(1, decayFactor(turn, input)))
}

/**
 * How much the recent-retention window stretches for one record.
 * Legacy records without an importance around 0.5 keep multiplier ≈ 1.
 * @param {object} turn turn record
 * @returns {number} multiplier in [0.5, 1.5]
 */
export function retentionMultiplier(turn) {
  return 0.5 + storedImportance(turn)
}

/**
 * Rank records by salience, best first; ties break on recency then id.
 * @param {object[]} turns turn records
 * @param {{ now: number, config: object, limit?: number }} input ranking inputs
 * @returns {object[]} ranked records
 */
export function rankBySalience(turns, { now, config, limit = 20 }) {
  return [...turns]
    .map((turn) => ({ turn, score: salience(turn, { now, config }) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      const leftAt = Date.parse(String(left.turn?.at ?? '')) || 0
      const rightAt = Date.parse(String(right.turn?.at ?? '')) || 0
      if (rightAt !== leftAt) return rightAt - leftAt
      return String(left.turn?.id ?? '') < String(right.turn?.id ?? '') ? -1 : 1
    })
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.turn)
}
