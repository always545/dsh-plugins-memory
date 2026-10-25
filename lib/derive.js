/**
 * Derivation rules for short-term memory: net change sets, per-file current
 * state, and the bounded retention plan.
 *
 * All functions are pure so the smoke test can pin time and input order.
 */

import { isInsideMemoryDir } from './paths.js'

const HOUR_MS = 3600_000
const DAY_MS = 86_400_000

/**
 * Merge the three change sources into one turn change set.
 *
 * Snapshot entries (from the harness workspace-changes recorder) are the
 * ground truth and keep their line counts; tracked file-tool edits and
 * model-reported files fill gaps the snapshot cannot see. A file touched
 * several times appears once with this turn's net counts.
 *
 * @param {object} input
 * @param {Array<{ path: string, added?: number, deleted?: number }>} [input.snapshotFiles]
 * @param {Array<{ path: string }>} [input.trackedFiles]
 * @param {string[]} [input.modelFiles]
 * @param {number} input.maxFiles cap on recorded files
 * @param {string} input.directoryName memory directory to filter out
 * @returns {{ files: Array<{ path: string, added?: number, deleted?: number }>, omitted: number }} merged change set
 */
export function mergeTurnChanges({ snapshotFiles = [], trackedFiles = [], modelFiles = [], maxFiles = 50, directoryName = 'memory' }) {
  const merged = new Map()
  const accepted = (relative) =>
    typeof relative === 'string' &&
    relative !== '' &&
    !relative.startsWith('/') &&
    !relative.split('/').includes('..') &&
    !isInsideMemoryDir(relative, directoryName)

  for (const file of snapshotFiles) {
    if (!file || !accepted(file.path)) continue
    const entry = { path: file.path }
    if (Number.isFinite(file.added)) entry.added = file.added
    if (Number.isFinite(file.deleted)) entry.deleted = file.deleted
    merged.set(file.path, entry)
  }
  for (const file of trackedFiles) {
    if (!file || !accepted(file.path)) continue
    if (!merged.has(file.path)) merged.set(file.path, { path: file.path })
  }
  for (const file of modelFiles) {
    if (!accepted(file)) continue
    if (!merged.has(file)) merged.set(file, { path: file })
  }

  const files = [...merged.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const omitted = Math.max(0, files.length - maxFiles)
  return { files: files.slice(0, maxFiles), omitted }
}

/**
 * Derive each file's current state: the latest record that touched it.
 * Records are in file order, so a later record is authoritative regardless of
 * clock skew.
 * @param {object[]} turns turn records in append order
 * @param {number} limit maximum derived files
 * @returns {Array<object>} current-state entries, most recently recorded first
 */
export function deriveCurrentFiles(turns, limit = 10) {
  const seen = new Set()
  const current = []
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    for (const file of turn.files ?? []) {
      if (!file || typeof file.path !== 'string' || seen.has(file.path)) continue
      seen.add(file.path)
      current.push({
        path: file.path,
        turn: turn.turn ?? 0,
        at: turn.at,
        type: turn.type ?? 'other',
        summary: turn.summary ?? '',
        ...(Number.isFinite(file.added) ? { added: file.added } : {}),
        ...(Number.isFinite(file.deleted) ? { deleted: file.deleted } : {}),
      })
      if (current.length >= limit) return current
    }
  }
  return current
}

/**
 * Count how many files have a current-state provider.
 * @param {object[]} turns turn records in append order
 * @returns {number} distinct files ever recorded in the live window
 */
export function countCurrentFiles(turns) {
  const seen = new Set()
  for (const turn of turns) {
    for (const file of turn.files ?? []) {
      if (file && typeof file.path === 'string') seen.add(file.path)
    }
  }
  return seen.size
}

/**
 * Decide which live records survive the forgetting window.
 *
 * Keep a record when it is the current provider of at least one file, or when
 * it is younger than `recentRetentionHours`. Absolute age removes even a
 * current provider. A record cap drops the oldest non-current records first.
 * @param {object[]} turns turn records in append order
 * @param {{ now: number, config: object }} input retention inputs
 * @returns {{ kept: object[], forgotten: object[], currentIds: Set<string> }} retention plan
 */
export function planRetention(turns, { now, config }) {
  const clock = Number.isFinite(now) ? now : Date.now()
  const maxAge = config.maxAgeDays * DAY_MS
  const recentWindow = config.recentRetentionHours * HOUR_MS
  const keyOf = (turn, index) => (typeof turn.id === 'string' && turn.id ? turn.id : `idx:${index}`)
  const timestampOf = (turn) => {
    const value = Date.parse(String(turn?.at ?? ''))
    return Number.isFinite(value) ? value : clock
  }

  const currentIds = new Set()
  const seenFiles = new Set()
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    let provider = false
    for (const file of turn.files ?? []) {
      if (!file || typeof file.path !== 'string' || seenFiles.has(file.path)) continue
      seenFiles.add(file.path)
      provider = true
    }
    if (provider) currentIds.add(keyOf(turn, index))
  }

  const entries = turns.map((turn, index) => ({ turn, key: keyOf(turn, index), at: timestampOf(turn) }))
  const kept = []
  const forgotten = []
  for (const entry of entries) {
    const isCurrent = currentIds.has(entry.key)
    const age = clock - entry.at
    const keep = age > maxAge ? false : isCurrent ? true : age <= recentWindow
    if (keep) kept.push(entry)
    else forgotten.push(entry)
  }

  let overflow = kept.length - config.maxShortTermRecords
  if (overflow > 0) {
    const survivors = []
    for (const entry of kept) {
      if (overflow > 0 && !currentIds.has(entry.key)) {
        forgotten.push(entry)
        overflow -= 1
        continue
      }
      survivors.push(entry)
    }
    while (overflow > 0 && survivors.length > 0) {
      forgotten.push(survivors.shift())
      overflow -= 1
    }
    kept.length = 0
    kept.push(...survivors)
  }

  const byOrder = new Map(entries.map((entry) => [entry.key, entry]))
  const orderedForgotten = forgotten
    .map((entry) => (byOrder.has(entry.key) ? byOrder.get(entry.key) : entry))
    .sort((left, right) => (left.at === right.at ? 0 : left.at - right.at))
    .map((entry) => entry.turn)
  return { kept: kept.map((entry) => entry.turn), forgotten: orderedForgotten, currentIds }
}

/**
 * Trim the archive to its own bounds.
 * @param {Array<{ turn: object, at: number }>} entries archived entries in order
 * @param {{ now: number, config: object }} input trim inputs
 * @returns {{ kept: object[], dropped: number }} kept records and dropped count
 */
export function planArchiveTrim(entries, { now, config }) {
  const clock = Number.isFinite(now) ? now : Date.now()
  const maxAge = config.archiveMaxAgeDays * DAY_MS
  const keepFrom = Math.max(0, entries.length - config.archiveMaxRecords)
  const kept = []
  let dropped = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const tooOld = clock - entry.at > maxAge
    if (index < keepFrom || tooOld) {
      dropped += 1
      continue
    }
    kept.push(entry.turn)
  }
  return { kept, dropped }
}
