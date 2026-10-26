/**
 * Consolidation evidence: deterministic analysis that feeds `/dreaming`.
 *
 * A bare "please tidy the memory" prompt asks the model to re-read everything
 * and guess. Instead the plugin computes the same things a human maintainer
 * would look at first: repeated subjects worth promoting, near-duplicate
 * records, records that went stale, pins that outlived their purpose, section
 * sizes, and the open working threads. The prompt then carries that brief, so a
 * consolidation turn starts with evidence instead of a blank page.
 */

import { tokenize } from './search.js'
import { isPinned, salience, storedImportance } from './salience.js'

const DAY_MS = 86_400_000
const DUPLICATE_THRESHOLD = 0.72
const STALE_PIN_DAYS = 30
const FORGET_AGE_DAYS = 7

/**
 * @param {object[]} turns turn records
 * @returns {Set<string>} ids of records that are the latest provider of a file
 */
export function currentProviderIds(turns) {
  const seen = new Set()
  const providers = new Set()
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    let provider = false
    for (const file of turn?.files ?? []) {
      if (!file || typeof file.path !== 'string' || seen.has(file.path)) continue
      seen.add(file.path)
      provider = true
    }
    if (provider && turn?.id) providers.add(String(turn.id))
  }
  return providers
}

/**
 * @param {object} turn turn record
 * @returns {Set<string>} summary+detail tokens
 */
function summaryTokens(turn) {
  return new Set(tokenize(`${turn?.summary ?? ''} ${turn?.detail ?? ''}`))
}

/**
 * Jaccard similarity of two token sets.
 * @param {Set<string>} left first set
 * @param {Set<string>} right second set
 * @returns {number} similarity in [0, 1]
 */
export function jaccard(left, right) {
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * @param {unknown} iso ISO timestamp
 * @param {number} now reference time
 * @returns {number} age in days
 */
function ageDays(iso, now) {
  const parsed = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, now - parsed) / DAY_MS
}

/**
 * Build the consolidation brief.
 * @param {{ turns?: object[], archiveTotal?: number, sections?: Array<{ name: string, body?: string, bytes?: number }>, working?: object | null, now?: number, config: object }} input sources
 * @returns {object} structured brief
 */
export function buildConsolidationBrief({ turns = [], archiveTotal = 0, sections = [], working = null, now = Date.now(), config }) {
  const providers = currentProviderIds(turns)
  const pinned = turns.filter((turn) => isPinned(turn))
  const bySubject = new Map()
  for (const turn of turns) {
    const subject = typeof turn?.subject === 'string' ? turn.subject.trim() : ''
    if (!subject) continue
    const entry = bySubject.get(subject) ?? { subject, count: 0, latest: null }
    entry.count += 1
    entry.latest = { turn: turn.turn ?? 0, at: turn.at ?? '', summary: turn.summary ?? '' }
    bySubject.set(subject, entry)
  }
  const promotions = [...bySubject.values()]
    .filter((entry) => entry.count >= 2)
    .sort((left, right) => right.count - left.count)
    .slice(0, 6)

  const forgetCandidates = []
  for (const turn of turns) {
    if (isPinned(turn)) continue
    if (turn?.id && providers.has(String(turn.id))) continue
    if (ageDays(turn?.at, now) < FORGET_AGE_DAYS) continue
    const score = salience(turn, { now, config })
    if (score >= 0.18) continue
    forgetCandidates.push({
      id: String(turn.id ?? ''),
      turn: turn.turn ?? 0,
      at: turn.at ?? '',
      type: turn.type ?? 'other',
      importance: Math.round(storedImportance(turn) * 100) / 100,
      ageDays: Math.round(ageDays(turn.at, now)),
    })
  }
  forgetCandidates.sort((left, right) => left.importance - right.importance || right.ageDays - left.ageDays)

  const stalePins = pinned
    .filter((turn) => ageDays(turn?.at, now) > STALE_PIN_DAYS)
    .slice(0, 5)
    .map((turn) => ({
      id: String(turn.id ?? ''),
      turn: turn.turn ?? 0,
      at: turn.at ?? '',
      ageDays: Math.round(ageDays(turn.at, now)),
      summary: turn.summary ?? '',
    }))

  const tokenSets = turns.map((turn) => ({ turn, tokens: summaryTokens(turn) }))
  const duplicates = []
  for (let left = 0; left < tokenSets.length && duplicates.length < 3; left += 1) {
    for (let right = left + 1; right < tokenSets.length && duplicates.length < 3; right += 1) {
      const similarity = jaccard(tokenSets[left].tokens, tokenSets[right].tokens)
      if (similarity < DUPLICATE_THRESHOLD) continue
      duplicates.push({
        a: { id: String(tokenSets[left].turn.id ?? ''), turn: tokenSets[left].turn.turn ?? 0, summary: tokenSets[left].turn.summary ?? '' },
        b: { id: String(tokenSets[right].turn.id ?? ''), turn: tokenSets[right].turn.turn ?? 0, summary: tokenSets[right].turn.summary ?? '' },
        similarity: Math.round(similarity * 100) / 100,
      })
    }
  }

  const scores = turns.map((turn) => salience(turn, { now, config })).sort((left, right) => right - left)
  const threshold = Math.max(0, (scores[Math.floor(scores.length * 0.1)] ?? 0.1) * 0.5)
  const lowSalience = turns.filter((turn) => !isPinned(turn) && salience(turn, { now, config }) < threshold).length

  return {
    at: new Date(now).toISOString(),
    turns: {
      live: turns.length,
      archived: archiveTotal,
      pinned: pinned.length,
      currentProviders: providers.size,
      lowSalience,
    },
    subjects: promotions,
    duplicates,
    forgetCandidates: forgetCandidates.slice(0, 5),
    stalePins,
    sections: sections.map((section) => ({
      name: String(section?.name ?? ''),
      bytes: Number.isFinite(section?.bytes) ? section.bytes : Buffer.byteLength(String(section?.body ?? ''), 'utf8'),
    })),
    working: working
      ? {
          task: working.task ?? '',
          next: (working.next ?? []).slice(0, 4),
          questions: (working.questions ?? []).slice(0, 4),
          notes: (working.notes ?? []).slice(0, 3),
        }
      : null,
  }
}

/**
 * Render a brief as bounded markdown for a consolidation prompt.
 * @param {object} brief brief from {@link buildConsolidationBrief}
 * @param {'zh' | 'en'} language rendering language
 * @param {number} maxBytes byte budget
 * @param {(text: string, maxBytes: number, suffix?: string) => string} truncate truncation helper
 * @returns {string} brief text
 */
export function renderConsolidationBrief(brief, language, maxBytes, truncate) {
  const zh = language !== 'en'
  const t = (zhText, enText) => (zh ? zhText : enText)
  const lines = []
  lines.push(
    t(
      `- 短期记录 ${brief.turns.live} 条（归档 ${brief.turns.archived}，已固定 ${brief.turns.pinned}，低显著度 ${brief.turns.lowSalience}）`,
      `- ${brief.turns.live} live records (archived ${brief.turns.archived}, pinned ${brief.turns.pinned}, low salience ${brief.turns.lowSalience})`,
    ),
  )
  if (brief.subjects.length) {
    lines.push(t(`- 重复出现的逻辑对象（可考虑写入长期记忆）：`, `- Repeated subjects (candidates for long-term memory):`))
    for (const entry of brief.subjects) {
      lines.push(
        `  - ${entry.subject} ×${entry.count}: ${entry.latest.summary}`.trim(),
      )
    }
  }
  if (brief.duplicates.length) {
    lines.push(t(`- 近似重复的记录（可合并/遗忘）：`, `- Near-duplicate records (merge or forget):`))
    for (const entry of brief.duplicates) {
      lines.push(`  - #${entry.a.turn} ↔ #${entry.b.turn} (${entry.similarity}): ${entry.a.summary} / ${entry.b.summary}`)
    }
  }
  if (brief.stalePins.length) {
    lines.push(t(`- 长期未动的 pinned 记录（确认是否仍需固定）：`, `- Stale pins (confirm whether they still matter):`))
    for (const entry of brief.stalePins) {
      lines.push(`  - #${entry.turn} (${entry.ageDays}d, ${entry.id}): ${entry.summary}`)
    }
  }
  if (brief.forgetCandidates.length) {
    lines.push(t(`- 低显著度旧记录（可遗忘）：`, `- Old low-salience records (forget candidates):`))
    for (const entry of brief.forgetCandidates) {
      lines.push(`  - #${entry.turn} (${entry.type}, ${entry.ageDays}d, ${entry.id})`)
    }
  }
  if (brief.sections.length) {
    const sizes = brief.sections.map((section) => `${section.name} ${section.bytes}B`).join(' · ')
    lines.push(t(`- 长期记忆章节大小：${sizes}`, `- Long-term section sizes: ${sizes}`))
  }
  if (brief.working) {
    const parts = []
    if (brief.working.task) parts.push(`${t('任务', 'task')}: ${brief.working.task}`)
    for (const field of ['next', 'questions', 'notes']) {
      if (brief.working[field]?.length) parts.push(`${field}: ${brief.working[field].join(' | ')}`)
    }
    if (parts.length) lines.push(t(`- 工作记忆：${parts.join('；')}`, `- Working memory: ${parts.join('; ')}`))
  }
  const text = lines.join('\n')
  return truncate(text, Math.max(256, maxBytes), '…')
}
