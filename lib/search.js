/**
 * Dependency-free lexical retrieval (BM25) with CJK-aware tokenization.
 *
 * Why lexical instead of embeddings: the plugin ships inside a profile bundle,
 * cannot add a model/vector dependency, and must stay synchronous so the prompt
 * section renders during assembly. Bigram tokenization is the standard trick
 * for Japanese/Chinese/Korean text without a segmenter, and BM25 + salience
 * boosts is enough to recall "which turn decided X" from a few hundred records.
 *
 * Every function here is pure and deterministic: the smoke test pins rankings.
 */

const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/u
const WORD_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]+|[\p{L}\p{N}_]+/gu

/** Latin function words that carry no retrieval signal. */
const STOP_EN = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its ' +
    'just me more most my no not now of on once only or other our out over same she should so some such than that the ' +
    'their them then there these they this those through to too under until up very was we were what when where which ' +
    'while who whom why will with would you your'
  ).split(' '),
)

/** CJK function characters that are too common to discriminate. */
const STOP_ZH = new Set(
  '的 了 和 是 在 我 有 就 不 人 都 一 上 也 很 到 说 要 去 你 会 着 看 好 这 那 与 及 或 并 而 被 把 对 从 为 以 于 中 吧 呢 吗 啊 个 等 其 它 们 这 那'.split(' '),
)

const CJK_UNIGRAM_WEIGHT = 0.35
const CJK_BIGRAM_WEIGHT = 1

/**
 * @param {string} run a run of CJK characters
 * @returns {boolean} whether the run is CJK
 */
function isCjk(run) {
  return CJK_RE.test(run)
}

/**
 * Tokenize text into query terms: lowercased latin words plus CJK bigrams
 * (a one-character CJK run keeps its character).
 * @param {unknown} text source text
 * @returns {string[]} terms in source order, duplicates preserved
 */
export function tokenize(text) {
  const value = String(text ?? '').normalize('NFKC').toLowerCase()
  const terms = []
  for (const match of value.matchAll(WORD_RE)) {
    const run = match[0]
    if (!run) continue
    if (isCjk(run)) {
      const chars = Array.from(run)
      if (chars.length === 1) {
        if (!STOP_ZH.has(chars[0])) terms.push(chars[0])
        continue
      }
      for (let index = 0; index + 1 < chars.length; index += 1) terms.push(`${chars[index]}${chars[index + 1]}`)
      continue
    }
    if (run.length < 2 || STOP_EN.has(run)) continue
    terms.push(run)
  }
  return terms
}

/**
 * Tokenize into weighted term frequencies: CJK unigrams survive at a lower
 * weight so a single-character query can still match, without drowning the
 * ranking in shared characters.
 * @param {unknown} text source text
 * @returns {Map<string, number>} term → weight sum
 */
export function tokenizeWeighted(text) {
  const value = String(text ?? '').normalize('NFKC').toLowerCase()
  const weighted = new Map()
  const add = (term, weight) => weighted.set(term, (weighted.get(term) ?? 0) + weight)
  for (const match of value.matchAll(WORD_RE)) {
    const run = match[0]
    if (!run) continue
    if (isCjk(run)) {
      const chars = Array.from(run)
      for (const char of chars) {
        if (!STOP_ZH.has(char)) add(char, CJK_UNIGRAM_WEIGHT)
      }
      for (let index = 0; index + 1 < chars.length; index += 1) add(`${chars[index]}${chars[index + 1]}`, CJK_BIGRAM_WEIGHT)
      continue
    }
    if (run.length < 2 || STOP_EN.has(run)) continue
    add(run, 1)
  }
  return weighted
}

const TITLE_WEIGHT = 3
const BODY_WEIGHT = 1
const META_WEIGHT = 1.5

/**
 * Prepare one searchable document.
 * @param {{ id: string, kind: string, title?: string, body?: string, meta?: string, at?: string, importance?: number, pinned?: boolean, data?: object }} input document fields
 * @returns {object} prepared document with weighted term frequencies
 */
export function makeDoc(input) {
  const id = String(input?.id ?? '')
  const kind = String(input?.kind ?? 'other')
  const title = String(input?.title ?? '')
  const body = String(input?.body ?? '')
  const meta = String(input?.meta ?? '')
  const tokens = new Map()
  const add = (text, weight) => {
    for (const [term, termWeight] of tokenizeWeighted(text)) tokens.set(term, (tokens.get(term) ?? 0) + termWeight * weight)
  }
  add(title, TITLE_WEIGHT)
  add(body, BODY_WEIGHT)
  add(meta, META_WEIGHT)
  let length = 0
  for (const weight of tokens.values()) length += weight
  return {
    id,
    kind,
    title,
    body,
    meta,
    at: String(input?.at ?? ''),
    importance: Number.isFinite(input?.importance) ? Math.min(1, Math.max(0, input.importance)) : 0.5,
    pinned: input?.pinned === true,
    data: input?.data && typeof input.data === 'object' ? input.data : {},
    tokens,
    length,
  }
}

/**
 * Build an inverted index over prepared documents.
 * @param {object[]} docs documents from {@link makeDoc}
 * @returns {{ docs: object[], df: Map<string, number>, avgLength: number, total: number, k1: number, b: number }} index
 */
export function buildIndex(docs) {
  const df = new Map()
  let lengthSum = 0
  for (const doc of docs) {
    lengthSum += doc.length
    for (const term of doc.tokens.keys()) df.set(term, (df.get(term) ?? 0) + 1)
  }
  return {
    docs,
    df,
    avgLength: docs.length ? lengthSum / docs.length : 0,
    total: docs.length,
    k1: 1.2,
    b: 0.75,
  }
}

/**
 * BM25 score of one document for one query term.
 * @param {object} doc prepared document
 * @param {Map<string, number>} df document frequencies
 * @param {string} term query term
 * @param {{ avgLength: number, total: number, k1: number, b: number }} index index summary
 * @returns {number} contribution
 */
function bm25Term(doc, df, term, index) {
  const tf = doc.tokens.get(term)
  if (!tf) return 0
  const documentFrequency = df.get(term) ?? 0
  if (!documentFrequency) return 0
  const idf = Math.log(1 + (index.total - documentFrequency + 0.5) / (documentFrequency + 0.5))
  const norm = 1 - index.b + (index.b * doc.length) / (index.avgLength || 1)
  return idf * ((tf * (index.k1 + 1)) / (tf + index.k1 * norm))
}

/**
 * Recency factor in [0, 1] with a half-life.
 * @param {string} at ISO timestamp
 * @param {number} now reference time
 * @param {number} halfLifeDays half-life in days
 * @returns {number} decayed recency
 */
function recencyOf(at, now, halfLifeDays) {
  const parsed = Date.parse(String(at ?? ''))
  if (!Number.isFinite(parsed)) return 0
  const ageDays = Math.max(0, now - parsed) / 86_400_000
  const halfLife = Math.max(0.5, Number(halfLifeDays) || 21)
  return Math.pow(0.5, ageDays / halfLife)
}

/**
 * Rank documents against a query.
 *
 * Score = BM25 × kind weight × (1 + importance + pinned + recency boosts), with
 * an exact-phrase multiplier. Ties break on recency, then id, so the ranking is
 * reproducible.
 * @param {object} index index from {@link buildIndex}
 * @param {unknown} query free-text query
 * @param {object} [options] ranking options
 * @param {number} [options.limit] maximum hits
 * @param {string[]} [options.kinds] restrict to these document kinds
 * @param {Record<string, number>} [options.kindWeights] per-kind multipliers
 * @param {number} [options.now] reference time
 * @param {number} [options.halfLifeDays] recency half-life
 * @param {number} [options.importanceWeight] importance boost
 * @param {number} [options.pinBoost] pinned boost
 * @param {number} [options.minScore] drop hits at or below this score
 * @returns {Array<{ doc: object, score: number, matched: string[] }>} hits, best first
 */
export function search(index, query, options = {}) {
  const limit = Math.max(1, Math.floor(options.limit ?? 8))
  const kinds = Array.isArray(options.kinds) && options.kinds.length ? new Set(options.kinds) : null
  const kindWeights = options.kindWeights ?? {}
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const halfLifeDays = options.halfLifeDays ?? 21
  const importanceWeight = options.importanceWeight ?? 0.35
  const pinBoost = options.pinBoost ?? 0.3
  const minScore = options.minScore ?? 0
  const phrase = String(query ?? '').trim().normalize('NFKC').toLowerCase()
  const queryTerms = [...new Set(tokenize(phrase))]

  const scored = []
  for (const doc of index.docs) {
    if (kinds && !kinds.has(doc.kind)) continue
    let score = 0
    const matched = []
    for (const term of queryTerms) {
      const part = bm25Term(doc, index.df, term, index)
      if (part > 0) {
        score += part
        matched.push(term)
      }
    }
    if (!matched.length) continue
    const recency = recencyOf(doc.at, now, halfLifeDays)
    const boost = 1 + importanceWeight * doc.importance + (doc.pinned ? pinBoost : 0) + 0.25 * recency
    score *= boost * (kindWeights[doc.kind] ?? 1)
    if (phrase.length > 1) {
      const haystack = `${doc.title}\n${doc.body}\n${doc.meta}`.normalize('NFKC').toLowerCase()
      if (haystack.includes(phrase)) score *= 1.6
    }
    if (score <= minScore) continue
    scored.push({ doc, score, matched, recency })
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    if (left.doc.at !== right.doc.at) return left.doc.at < right.doc.at ? 1 : -1
    return left.doc.id < right.doc.id ? -1 : left.doc.id > right.doc.id ? 1 : 0
  })
  return scored.slice(0, limit).map(({ doc, score, matched }) => ({ doc, score, matched }))
}

/**
 * Cut a snippet around the first matched term, without splitting code points.
 * @param {unknown} text document text
 * @param {string[]} [terms] matched query terms
 * @param {number} [maxChars] maximum characters
 * @returns {string} bounded single-line snippet
 */
export function snippetOf(text, terms = [], maxChars = 160) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  const limit = Math.max(16, Math.floor(maxChars))
  if (!value) return ''
  const lower = value.toLowerCase()
  let hit = -1
  for (const term of terms) {
    if (!term) continue
    const index = lower.indexOf(term.toLowerCase())
    if (index >= 0 && (hit === -1 || index < hit)) hit = index
  }
  if (hit === -1) return cut(value, 0, limit)
  const head = Math.max(0, hit - Math.floor(limit / 3))
  return cut(value, head, limit)
}

/**
 * Slice by characters with ellipsis markers.
 * @param {string} value source
 * @param {number} start start offset in characters
 * @param {number} limit maximum characters
 * @returns {string} slice with markers
 */
function cut(value, start, limit) {
  const chars = Array.from(value)
  const end = Math.min(chars.length, start + limit)
  const body = chars.slice(start, end).join('')
  return `${start > 0 ? '…' : ''}${body}${end < chars.length ? '…' : ''}`
}

/**
 * Recency-first ordering for an empty query.
 * @param {object} index index from {@link buildIndex}
 * @param {{ limit?: number, kinds?: string[], now?: number }} [options] options
 * @returns {Array<{ doc: object, score: number, matched: string[] }>} hits, most recent first
 */
export function recencyRank(index, options = {}) {
  const limit = Math.max(1, Math.floor(options.limit ?? 8))
  const kinds = Array.isArray(options.kinds) && options.kinds.length ? new Set(options.kinds) : null
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const docs = index.docs
    .filter((doc) => !kinds || kinds.has(doc.kind))
    .map((doc) => ({ doc, score: recencyOf(doc.at, now, 21) + 0.2 * doc.importance, matched: [] }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return left.doc.at < right.doc.at ? 1 : left.doc.at > right.doc.at ? -1 : 0
    })
  return docs.slice(0, limit)
}
