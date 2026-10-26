/**
 * Working memory: the per-session scratchpad that sits above the knowledge base.
 *
 * Long-term memory is shared and stable; short-term memory describes what
 * already happened. Neither answers "what am I doing right now, what is still
 * open, what should I not forget". That state is scarce, volatile, and belongs
 * to one session, so it lives in its own file (`memory/working/<session>.json`),
 * expires by TTL, and is injected at the very top of the memory block.
 *
 * The store never rewrites another session's file and never throws on a
 * malformed one: a broken scratchpad must not break a turn.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

import { readCapped, writeAtomic } from './fsutil.js'

/** Maximum number of entries in one working-memory list. */
export const WORKING_MAX_ITEMS = 8
/** Maximum characters for one working-memory list entry. */
export const WORKING_MAX_ITEM_CHARS = 200
/** Maximum characters for the task line. */
export const WORKING_MAX_TASK_CHARS = 300

const WORKING_LISTS = ['next', 'questions', 'notes']

/**
 * Make a session id safe as a file name.
 * @param {unknown} sessionId session id
 * @returns {string} file key
 */
export function workingSessionKey(sessionId) {
  const key = String(sessionId ?? '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 96)
  return key || 'session'
}

/**
 * Collapse whitespace and cap a single-line value.
 * @param {unknown} value source
 * @param {number} max maximum characters
 * @returns {string} normalized value
 */
function clampLine(value, max) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

/**
 * Normalize one working-memory list: strings only, deduplicated, bounded.
 * @param {unknown} value candidate list
 * @param {number} maxItems maximum entries
 * @returns {string[]} normalized list
 */
function clampList(value, maxItems = WORKING_MAX_ITEMS) {
  if (!Array.isArray(value)) return []
  const list = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const line = clampLine(item, WORKING_MAX_ITEM_CHARS)
    if (!line || list.includes(line)) continue
    list.push(line)
    if (list.length >= maxItems) break
  }
  return list
}

/**
 * One project's working-memory files.
 */
export class WorkingMemory {
  /**
   * @param {ReturnType<import('./config.js').normalizeConfig>} config effective config
   */
  constructor(config) {
    this.config = config
  }

  /**
   * @param {string} root project directory
   * @returns {string} absolute working directory
   */
  dir(root) {
    return path.join(root, this.config.directoryName, 'working')
  }

  /**
   * @param {string} root project directory
   * @param {unknown} sessionId session id
   * @returns {string} absolute file path
   */
  path(root, sessionId) {
    return path.join(this.dir(root), `${workingSessionKey(sessionId)}.json`)
  }

  /**
   * Read one session's working memory.
   * @param {string} root project directory
   * @param {unknown} sessionId session id
   * @param {number} [now] reference time
   * @returns {{ v: 1, session: string, createdAt: string, updatedAt: string, task: string, next: string[], questions: string[], notes: string[] } | null} state, or null when absent/expired
   */
  read(root, sessionId, now = Date.now()) {
    const file = this.path(root, sessionId)
    const read = readCapped(file, Math.max(1024, this.config.workingMemoryMaxBytes * 4))
    if (!read.exists) return null
    let value
    try {
      value = JSON.parse(read.text)
    } catch {
      return null
    }
    if (!value || typeof value !== 'object' || value.v !== 1) return null
    const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : ''
    const updated = Date.parse(updatedAt)
    const ttlMs = this.config.workingMemoryTtlHours * 3_600_000
    if (ttlMs > 0 && Number.isFinite(updated) && now - updated > ttlMs) return null
    return {
      v: 1,
      session: String(value.session ?? sessionId),
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : updatedAt,
      updatedAt,
      task: clampLine(value.task, WORKING_MAX_TASK_CHARS),
      next: clampList(value.next),
      questions: clampList(value.questions),
      notes: clampList(value.notes),
    }
  }

  /**
   * Merge a patch into one session's working memory and write it atomically.
   *
   * `task` replaces the current line (an empty string clears it); the list
   * fields append unique entries unless `replaceArrays` is set.
   * @param {string} root project directory
   * @param {unknown} sessionId session id
   * @param {{ task?: string, next?: string[], questions?: string[], notes?: string[], replaceArrays?: boolean }} patch update
   * @param {number} [now] reference time
   * @returns {{ state: object, path: string, bytes: number }} written state
   */
  write(root, sessionId, patch, now = Date.now()) {
    const current = this.read(root, sessionId, now) ?? {
      v: 1,
      session: String(sessionId ?? ''),
      createdAt: new Date(now).toISOString(),
      updatedAt: '',
      task: '',
      next: [],
      questions: [],
      notes: [],
    }
    const next = {
      v: 1,
      session: current.session,
      createdAt: current.createdAt,
      updatedAt: new Date(now).toISOString(),
      task: typeof patch?.task === 'string' ? clampLine(patch.task, WORKING_MAX_TASK_CHARS) : current.task,
      next: joinList(current.next, patch?.next, patch?.replaceArrays),
      questions: joinList(current.questions, patch?.questions, patch?.replaceArrays),
      notes: joinList(current.notes, patch?.notes, patch?.replaceArrays),
    }
    this.fitToBudget(next)
    const file = this.path(root, sessionId)
    mkdirSync(this.dir(root), { recursive: true })
    const text = `${JSON.stringify(next, null, 2)}\n`
    writeAtomic(file, text)
    return { state: next, path: file, bytes: Buffer.byteLength(text, 'utf8') }
  }

  /**
   * Shrink a state until it fits the configured byte budget.
   * @param {object} state mutable state
   * @returns {void}
   */
  fitToBudget(state) {
    const max = Math.max(512, this.config.workingMemoryMaxBytes)
    const size = () => Buffer.byteLength(JSON.stringify(state), 'utf8')
    while (size() > max) {
      const list = WORKING_LISTS.find((name) => state[name].length > 0)
      if (!list) break
      state[list].pop()
    }
    if (size() > max) {
      const chars = Array.from(state.task)
      while (size() > max && chars.length > 20) {
        chars.pop()
        state.task = `${chars.join('').trimEnd()}…`
      }
    }
  }

  /**
   * Delete one session's working memory.
   * @param {string} root project directory
   * @param {unknown} sessionId session id
   * @returns {boolean} whether a file was removed
   */
  clear(root, sessionId) {
    const file = this.path(root, sessionId)
    if (!existsSync(file)) return false
    rmSync(file, { force: true })
    return true
  }

  /**
   * Drop expired sessions and enforce the session count cap.
   * @param {string} root project directory
   * @param {number} [now] reference time
   * @returns {{ removed: number, kept: number }} prune result
   */
  prune(root, now = Date.now()) {
    const dir = this.dir(root)
    if (!existsSync(dir)) return { removed: 0, kept: 0 }
    const ttlMs = this.config.workingMemoryTtlHours * 3_600_000
    const entries = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const file = path.join(dir, name)
      let updated = now
      try {
        const stat = statSync(file)
        updated = stat.mtimeMs
        const read = readCapped(file, Math.max(1024, this.config.workingMemoryMaxBytes * 4))
        const value = JSON.parse(read.text)
        const parsed = Date.parse(String(value?.updatedAt ?? ''))
        if (Number.isFinite(parsed)) updated = parsed
      } catch {
        // A malformed scratchpad is still prunable; fall back to mtime.
      }
      entries.push({ file, updated })
    }
    entries.sort((left, right) => right.updated - left.updated)
    let removed = 0
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]
      const expired = ttlMs > 0 && now - entry.updated > ttlMs
      const overCap = index >= this.config.workingMemoryMaxSessions
      if (!expired && !overCap) continue
      try {
        rmSync(entry.file, { force: true })
        removed += 1
      } catch {
        // Another process may have removed it first.
      }
    }
    return { removed, kept: entries.length - removed }
  }
}

/**
 * Append new unique entries to a list.
 * @param {string[]} current existing entries
 * @param {unknown} incoming candidate entries
 * @param {boolean} [replace] replace instead of append
 * @returns {string[]} merged list
 */
function joinList(current, incoming, replace) {
  if (incoming === undefined) return current
  const added = clampList(incoming)
  if (replace) return added
  const merged = [...current]
  for (const entry of added) if (!merged.includes(entry)) merged.push(entry)
  return merged.slice(0, WORKING_MAX_ITEMS)
}
