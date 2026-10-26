/**
 * Filesystem store for one project's memory directory.
 *
 * Operations are synchronous and small (a bounded JSONL file plus a markdown
 * file); the Host stays responsive because each call touches at most a few
 * hundred short lines. Rewrites are atomic (temporary file + rename) so a crash
 * never leaves a half-written knowledge base.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { planArchiveTrim, planRetention } from './derive.js'
import { parseTurns, recordLine } from './format.js'
import { fileSignature, readCapped, writeAtomic } from './fsutil.js'
import { longTermSkeleton, memoryReadme } from './templates.js'

const DAY_MS = 86_400_000

/**
 * Split a long-term markdown file into its `## ` sections.
 * @param {unknown} text markdown
 * @returns {Array<{ name: string, body: string }>} sections in file order
 */
export function longTermSections(text) {
  const sections = []
  let current = null
  for (const line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      if (current) sections.push({ name: current.name, body: current.lines.join('\n').trim() })
      current = { name: heading[1].trim(), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) sections.push({ name: current.name, body: current.lines.join('\n').trim() })
  return sections
}

/**
 * @param {string} text long-term markdown
 * @returns {string[]} top-level section names
 */
export function sectionsOf(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => /^##\s+/.test(line))
    .map((line) => line.replace(/^##\s+/, '').trim())
    .filter(Boolean)
}

/**
 * Apply one append or replace operation to a named markdown section.
 * @param {string} text current markdown
 * @param {{ section?: string, mode: 'append' | 'replace_section', content: string, language: 'zh' | 'en' }} edit edit request
 * @returns {string} updated markdown
 */
export function applySectionEdit(text, edit) {
  const zh = edit.language !== 'en'
  const explicit = typeof edit.section === 'string' && edit.section.trim() !== ''
  const target = explicit ? edit.section.trim() : zh ? '补充记录' : 'Additional notes'
  if (target.length > 80) throw new Error(zh ? '章节名过长（最多 80 字符）。' : 'Section name is too long (max 80 characters).')
  const body = String(edit.content ?? '').replace(/\r\n/g, '\n').trim()
  if (!body) throw new Error(zh ? 'content 不能为空。' : 'content must not be empty.')

  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const headingIndex = lines.findIndex((line) => {
    if (!/^##\s+/.test(line)) return false
    return line.replace(/^##\s+/, '').trim() === target
  })
  if (headingIndex === -1 && explicit) {
    const available = sectionsOf(text)
    throw new Error(
      zh
        ? `长期记忆中没有章节「${target}」。可用章节：${available.length ? available.join('、') : '（无）'}`
        : `Long-term memory has no section "${target}". Available: ${available.length ? available.join(', ') : '(none)'}`,
    )
  }
  const bullet = body.split('\n').map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`))
  const normalize = (value) => `${value.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`

  if (headingIndex === -1) {
    const base = lines.join('\n').replace(/\s+$/, '')
    return normalize(`${base}\n\n## ${target}\n\n${bullet.join('\n')}`)
  }

  let end = lines.length
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index
      break
    }
  }
  const before = lines.slice(0, headingIndex + 1)
  const after = lines.slice(end)

  if (edit.mode === 'replace_section') {
    return normalize([...before, '', body, '', ...after].join('\n'))
  }

  const sectionBody = lines.slice(headingIndex + 1, end)
  while (sectionBody.length && sectionBody[sectionBody.length - 1].trim() === '') sectionBody.pop()
  const separator = sectionBody.length ? [''] : []
  return normalize([...before, ...sectionBody, ...separator, ...bullet, '', ...after].join('\n'))
}

/** Project memory storage rooted at one effective configuration. */
export class MemoryStore {
  /**
   * @param {ReturnType<import('./config.js').normalizeConfig>} config effective config
   */
  constructor(config) {
    this.config = config
  }

  /**
   * @param {string} root project directory
   * @returns {{ dir: string, longTerm: string, readme: string, turns: string, archive: string }} absolute paths
   */
  paths(root) {
    const dir = path.join(root, this.config.directoryName)
    return {
      dir,
      longTerm: path.join(dir, 'long-term.md'),
      readme: path.join(dir, 'README.md'),
      turns: path.join(dir, 'short-term.jsonl'),
      archive: path.join(dir, 'short-term-archive.jsonl'),
      working: path.join(dir, 'working'),
    }
  }

  /**
   * Create the memory skeleton, never overwriting an existing file.
   * @param {string} root project directory
   * @returns {{ dir: string, created: string[] }} directory and newly created files
   */
  ensure(root) {
    const paths = this.paths(root)
    const created = []
    mkdirSync(paths.dir, { recursive: true })
    const writeIfMissing = (file, content) => {
      if (existsSync(file)) return
      try {
        writeFileSync(file, content, { flag: 'wx', encoding: 'utf8' })
        created.push(file)
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error
      }
    }
    writeIfMissing(paths.longTerm, longTermSkeleton(this.config.language))
    writeIfMissing(paths.readme, memoryReadme(this.config.language, this.config))
    writeIfMissing(paths.turns, '')
    return { dir: paths.dir, created }
  }

  /**
   * @param {string} root project directory
   * @returns {{ path: string, text: string, bytes: number, truncated: boolean, exists: boolean, updatedAt: string }} long-term memory
   */
  readLongTerm(root) {
    const paths = this.paths(root)
    const read = readCapped(paths.longTerm, this.config.maxSourceBytes)
    let updatedAt = ''
    try {
      updatedAt = statSync(paths.longTerm).mtime.toISOString()
    } catch {
      updatedAt = ''
    }
    return { path: paths.longTerm, text: read.text, bytes: read.bytes, truncated: read.truncated, exists: read.exists, updatedAt }
  }

  /**
   * @param {string} root project directory
   * @returns {{ path: string, turns: object[], badLines: number, bytes: number, truncated: boolean }} live turn records
   */
  readTurns(root) {
    const paths = this.paths(root)
    const read = readCapped(paths.turns, this.config.maxSourceBytes)
    const parsed = parseTurns(read.text)
    return { path: paths.turns, turns: parsed.turns, badLines: parsed.badLines, bytes: read.bytes, truncated: read.truncated }
  }

  /**
   * Read long-term memory split into its searchable sections.
   * @param {string} root project directory
   * @returns {{ path: string, exists: boolean, updatedAt: string, sections: Array<{ name: string, body: string, bytes: number }> }} section view
   */
  readLongTermSections(root) {
    const longTerm = this.readLongTerm(root)
    return {
      path: longTerm.path,
      exists: longTerm.exists,
      updatedAt: longTerm.updatedAt,
      sections: longTermSections(longTerm.text).map((section) => ({
        ...section,
        bytes: Buffer.byteLength(section.body, 'utf8'),
      })),
    }
  }

  /**
   * Cheap fingerprint of the files the retrieval index depends on.
   * @param {string} root project directory
   * @returns {string} signature; equal signatures mean an unchanged index
   */
  signature(root) {
    const paths = this.paths(root)
    return fileSignature([paths.longTerm, paths.turns, paths.archive])
  }

  /**
   * Patch matching live records in place (used by pin and retrieval reinforcement).
   * @param {string} root project directory
   * @param {(turn: object) => boolean} predicate matcher
   * @param {object | ((turn: object) => object)} patch fields to merge
   * @returns {{ updated: number }} patched record count
   */
  updateTurns(root, predicate, patch) {
    const paths = this.paths(root)
    const read = this.readTurns(root)
    let updated = 0
    const next = read.turns.map((turn) => {
      if (!predicate(turn)) return turn
      updated += 1
      return { ...turn, ...(typeof patch === 'function' ? patch(turn) : patch) }
    })
    if (updated > 0) writeAtomic(paths.turns, next.map(recordLine).join(''))
    return { updated }
  }

  /**
   * Record retrieval reinforcement for recalled records.
   *
   * A record recalled within `minIntervalMs` is not touched again, so a chatty
   * session cannot turn every search into a disk write.
   * @param {string} root project directory
   * @param {Iterable<string>} ids recalled record ids
   * @param {number} [now] reference time
   * @param {number} [minIntervalMs] per-record throttle
   * @returns {number} number of records reinforced
   */
  touchTurns(root, ids, now = Date.now(), minIntervalMs = 3_600_000) {
    const wanted = ids instanceof Set ? ids : new Set(ids ?? [])
    if (!wanted.size) return 0
    const paths = this.paths(root)
    const read = this.readTurns(root)
    let touched = 0
    const next = read.turns.map((turn) => {
      if (!wanted.has(turn.id)) return turn
      const last = Date.parse(String(turn.lastHitAt ?? ''))
      if (Number.isFinite(last) && now - last < minIntervalMs) return turn
      touched += 1
      return {
        ...turn,
        hits: (Number.isFinite(turn.hits) ? Math.max(0, turn.hits) : 0) + 1,
        lastHitAt: new Date(now).toISOString(),
      }
    })
    if (touched > 0) writeAtomic(paths.turns, next.map(recordLine).join(''))
    return touched
  }

  /**
   * Append one turn record and apply forgetting.
   * @param {string} root project directory
   * @param {object} record turn record
   * @returns {{ forgotten: number, kept: number }} compaction result
   */
  appendTurn(root, record) {
    const paths = this.paths(root)
    this.ensure(root)
    appendFileSync(paths.turns, recordLine(record), 'utf8')
    return this.compact(root)
  }

  /**
   * Apply the retention window to the live file.
   * @param {string} root project directory
   * @param {number} [now] reference time for tests
   * @returns {{ forgotten: number, kept: number }} compaction result
   */
  compact(root, now = Date.now()) {
    const paths = this.paths(root)
    const read = this.readTurns(root)
    if (!read.turns.length) {
      this.trimArchive(root, now)
      return { forgotten: 0, kept: 0 }
    }
    const plan = planRetention(read.turns, { now, config: this.config })
    if (plan.forgotten.length) {
      if (this.config.forgetMode === 'archive') this.archive(root, plan.forgotten)
      writeAtomic(paths.turns, plan.kept.map(recordLine).join(''))
    }
    this.trimArchive(root, now)
    return { forgotten: plan.forgotten.length, kept: plan.kept.length }
  }

  /**
   * Forget every record matching a predicate.
   * @param {string} root project directory
   * @param {(turn: object) => boolean} predicate matcher
   * @param {number} [now] reference time for archive trimming
   * @returns {number} forgotten record count
   */
  forget(root, predicate, now = Date.now()) {
    const paths = this.paths(root)
    const read = this.readTurns(root)
    const kept = []
    const forgotten = []
    for (const turn of read.turns) {
      if (predicate(turn)) forgotten.push(turn)
      else kept.push(turn)
    }
    if (!forgotten.length) return 0
    if (this.config.forgetMode === 'archive') this.archive(root, forgotten)
    writeAtomic(paths.turns, kept.map(recordLine).join(''))
    this.trimArchive(root, now)
    return forgotten.length
  }

  /**
   * Append forgotten records to the archive file.
   * @param {string} root project directory
   * @param {object[]} turns forgotten records
   * @returns {void}
   */
  archive(root, turns) {
    if (!turns.length) return
    appendFileSync(this.paths(root).archive, turns.map(recordLine).join(''), 'utf8')
  }

  /**
   * Bound the archive by count and age.
   * @param {string} root project directory
   * @param {number} now reference time
   * @returns {void}
   */
  trimArchive(root, now = Date.now()) {
    const paths = this.paths(root)
    if (!existsSync(paths.archive)) return
    const read = readCapped(paths.archive, this.config.maxSourceBytes)
    const lines = read.text.split('\n').filter((line) => line.trim())
    if (!lines.length) return
    const entries = []
    for (const line of lines) {
      let value
      try {
        value = JSON.parse(line)
      } catch {
        // A malformed archive line means the file was edited by hand; leaving
        // the archive untouched is safer than rewriting around it.
        return
      }
      const at = Date.parse(String(value?.at ?? ''))
      entries.push({ turn: value, at: Number.isFinite(at) ? at : now })
    }
    const plan = planArchiveTrim(entries, { now, config: this.config })
    if (plan.dropped === 0) return
    writeAtomic(paths.archive, plan.kept.map(recordLine).join(''))
  }

  /**
   * @param {string} root project directory
   * @returns {number} archived record count
   */
  countArchive(root) {
    const read = readCapped(this.paths(root).archive, this.config.maxSourceBytes)
    return read.text.split('\n').filter((line) => line.trim()).length
  }

  /**
   * Read recent archived records, newest first.
   * @param {string} root project directory
   * @param {number} [limit] maximum entries
   * @returns {{ path: string, total: number, entries: object[], truncated: boolean }} archive slice
   */
  readArchive(root, limit = 20) {
    const read = readCapped(this.paths(root).archive, this.config.maxSourceBytes)
    const entries = []
    for (const line of read.text.split('\n')) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line)
        if (value && typeof value === 'object') entries.push(value)
      } catch {
        // A malformed archive line is skipped, never rewritten.
      }
    }
    return { path: this.paths(root).archive, total: entries.length, entries: entries.slice(-limit).reverse(), truncated: read.truncated }
  }

  /**
   * Append to or replace one long-term section.
   * @param {string} root project directory
   * @param {{ section?: string, mode?: 'append' | 'replace_section', content: string }} edit edit request
   * @returns {{ path: string, bytes: number, sections: string[] }} written file summary
   */
  updateLongTerm(root, edit) {
    const paths = this.paths(root)
    this.ensure(root)
    const current = this.readLongTerm(root)
    const text = current.text || longTermSkeleton(this.config.language)
    const next = applySectionEdit(text, {
      section: edit.section,
      mode: edit.mode === 'replace_section' ? 'replace_section' : 'append',
      content: edit.content,
      language: this.config.language,
    })
    const bytes = Buffer.byteLength(next, 'utf8')
    if (bytes > this.config.maxLongTermBytes) {
      throw new Error(
        this.config.language === 'en'
          ? `long-term memory would grow to ${bytes} bytes; the limit is ${this.config.maxLongTermBytes}. Consolidate or trim existing sections first.`
          : `长期记忆将增长到 ${bytes} 字节，超过上限 ${this.config.maxLongTermBytes}。请先合并或精简已有章节。`,
      )
    }
    writeAtomic(paths.longTerm, next)
    return { path: paths.longTerm, bytes, sections: sectionsOf(next) }
  }
}

/**
 * @param {string} iso candidate
 * @returns {boolean} whether the value parses as a date
 */
export function isIsoDate(iso) {
  return typeof iso === 'string' && iso.trim() !== '' && Number.isFinite(Date.parse(iso))
}

export { DAY_MS }
