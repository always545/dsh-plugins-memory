/**
 * Recall: turning the record store into a ranked, queryable index.
 *
 * The index composes three sources into one BM25 space:
 *
 * - short-term turns (episodic memory: what happened, per turn);
 * - archived turns (older episodes that left the live window);
 * - long-term sections (semantic memory: stable consensus);
 * - working memory (the session scratchpad: task, open threads, pinned notes).
 *
 * The prompt uses it to inject "relevant recall" in addition to the recent
 * timeline, and `memory_search` uses it to answer explicit lookups.
 */

import { buildIndex, makeDoc, recencyRank, search, snippetOf } from './search.js'
import { isPinned, salience, storedImportance } from './salience.js'

/** Kinds that can be recalled into the prompt. */
const PROMPT_KINDS = ['turn', 'archive']

/** Per-kind ranking weights: pinned working notes beat everything else. */
const KIND_WEIGHTS = { working: 1.35, 'long-term': 1.15, turn: 1, archive: 0.9 }

/**
 * @param {object} turn turn record
 * @param {'turn' | 'archive'} kind source kind
 * @returns {object} prepared search document
 */
function turnDoc(turn, kind) {
  const id = `${kind}:${String(turn?.id ?? `${turn?.turn ?? 0}@${turn?.at ?? ''}`)}`
  const subject = typeof turn?.subject === 'string' && turn.subject.trim() ? turn.subject : ''
  const summary = typeof turn?.summary === 'string' ? turn.summary : ''
  const detail = typeof turn?.detail === 'string' ? turn.detail : ''
  const files = Array.isArray(turn?.files) ? turn.files.map((file) => file?.path).filter(Boolean) : []
  return makeDoc({
    id,
    kind,
    title: subject || summary,
    body: [summary, detail].filter(Boolean).join('\n'),
    meta: [turn?.type, ...files].filter(Boolean).join(' '),
    at: turn?.at,
    importance: storedImportance(turn),
    pinned: isPinned(turn),
    data: { recordId: turn?.id, turn: turn?.turn, type: turn?.type, subject },
  })
}

/**
 * @param {object} working working-memory state
 * @returns {object[]} prepared search documents
 */
function workingDocs(working) {
  const at = working?.updatedAt ?? ''
  const docs = []
  const add = (id, title, body) => {
    if (!title && !body) return
    docs.push(
      makeDoc({
        id: `working:${id}`,
        kind: 'working',
        title,
        body,
        at,
        importance: 1,
        pinned: true,
        data: { workingField: id },
      }),
    )
  }
  add('task', working?.task ?? '', '')
  const lists = [
    ['next', '下一步'],
    ['questions', '待确认'],
    ['notes', '临时笔记'],
  ]
  for (const [field, label] of lists) {
    for (const item of working?.[field] ?? []) add(field, item, label)
  }
  return docs
}

/**
 * Build the BM25 index for one project snapshot.
 * @param {{ turns?: object[], archive?: object[], sections?: Array<{ name: string, body: string, at?: string }>, working?: object | null, now?: number, config: object }} input sources
 * @returns {object} BM25 index
 */
export function buildRecallIndex({ turns = [], archive = [], sections = [], working = null, now = Date.now(), config }) {
  const docs = []
  for (const turn of turns) docs.push(turnDoc(turn, 'turn'))
  for (const turn of archive) docs.push(turnDoc(turn, 'archive'))
  for (const section of sections) {
    docs.push(
      makeDoc({
        id: `long-term:${String(section?.name ?? '')}`,
        kind: 'long-term',
        title: String(section?.name ?? ''),
        body: String(section?.body ?? ''),
        at: section?.at ?? '',
        importance: 1,
        pinned: true,
        data: { section: section?.name },
      }),
    )
  }
  for (const doc of workingDocs(working)) docs.push(doc)
  void now
  void config
  return buildIndex(docs)
}

/**
 * Derive the retrieval query from working memory, falling back to the latest
 * turns when the scratchpad is empty.
 * @param {object | null | undefined} working working-memory state
 * @param {object[]} [turns] live turn records, oldest first
 * @param {{ maxTurns?: number }} [options] fallback options
 * @returns {string} query text
 */
export function focusText(working, turns = [], options = {}) {
  const maxTurns = Math.max(0, options.maxTurns ?? 2)
  const parts = []
  if (working && typeof working === 'object') {
    if (working.task) parts.push(working.task)
    for (const field of ['next', 'questions', 'notes']) {
      for (const item of working[field] ?? []) parts.push(item)
    }
  }
  if (!parts.length) {
    for (const turn of turns.slice(-maxTurns)) {
      if (turn?.subject) parts.push(turn.subject)
      if (turn?.summary) parts.push(turn.summary)
    }
  }
  return parts.join(' · ').trim()
}

/**
 * Rank records against the working focus, excluding the turns already shown as
 * the recent timeline and excluding long-term sections (they are injected whole).
 * @param {object} input
 * @param {object} input.index recall index
 * @param {string} input.focus query text
 * @param {Set<string>} [input.excludeIds] record ids already rendered
 * @param {number} [input.limit] maximum items
 * @param {number} [input.now] reference time
 * @param {object} input.config effective config
 * @returns {Array<{ kind: string, recordId: string, turn: number, at: string, type: string, summary: string, snippet: string, score: number, matched: string[] }>} recall items
 */
export function recallForPrompt({ index, focus, excludeIds, limit = 4, now = Date.now(), config }) {
  const query = String(focus ?? '').trim()
  if (!query) return []
  const hits = search(index, query, {
    limit: Math.max(1, limit + (excludeIds?.size ?? 0)),
    kinds: PROMPT_KINDS,
    kindWeights: KIND_WEIGHTS,
    now,
    halfLifeDays: config?.importanceHalfLifeDays ?? 21,
  })
  const items = []
  for (const hit of hits) {
    const recordId = hit.doc.data?.recordId
    if (excludeIds && recordId && excludeIds.has(recordId)) continue
    items.push(itemOf(hit))
    if (items.length >= limit) break
  }
  return items
}

/**
 * Normalize one BM25 hit into the tool/prompt shape.
 * @param {{ doc: object, score: number, matched: string[] }} hit BM25 hit
 * @returns {object} recall item
 */
export function itemOf(hit) {
  const doc = hit.doc
  const body = doc.body || doc.title
  return {
    kind: doc.kind,
    id: doc.id,
    recordId: doc.data?.recordId ?? '',
    turn: Number.isFinite(doc.data?.turn) ? doc.data.turn : null,
    at: doc.at,
    type: String(doc.data?.type ?? ''),
    summary: String(doc.title ?? ''),
    snippet: snippetOf(body, hit.matched),
    score: Math.round(hit.score * 1000) / 1000,
    matched: hit.matched.slice(0, 6),
  }
}

/**
 * Search the whole memory, newest/most relevant first.
 * @param {{ turns?: object[], archive?: object[], sections?: object[], working?: object | null, query: string, limit?: number, kinds?: string[], now?: number, config: object }} input search request
 * @returns {{ items: object[], total: number, query: string }} search result
 */
export function searchMemory({ turns = [], archive = [], sections = [], working = null, query, limit = 8, kinds, now = Date.now(), config }) {
  const index = buildRecallIndex({ turns, archive, sections, working, now, config })
  const text = String(query ?? '').trim()
  const hits = text
    ? search(index, text, { limit, kinds, kindWeights: KIND_WEIGHTS, now, halfLifeDays: config?.importanceHalfLifeDays ?? 21 })
    : recencyRank(index, { limit, kinds, now })
  return { items: hits.map(itemOf), total: hits.length, query: text }
}

/**
 * Record ids worth reinforcing after a recall (live records only).
 * @param {object[]} items recall items
 * @returns {Set<string>} record ids
 */
export function reinforcedIds(items) {
  const ids = new Set()
  for (const item of items) {
    if (item?.recordId) ids.add(String(item.recordId))
  }
  return ids
}

/**
 * Salience-ordered snapshot used by the consolidation brief and prompt.
 * @param {object[]} turns live records
 * @param {{ now: number, config: object, limit?: number }} input options
 * @returns {object[]} records, most salient first
 */
export function salientTurns(turns, { now, config, limit = 10 }) {
  return [...turns]
    .map((turn) => ({ turn, score: salience(turn, { now, config }) }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return String(left.turn?.at ?? '') < String(right.turn?.at ?? '') ? 1 : -1
    })
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.turn)
}
