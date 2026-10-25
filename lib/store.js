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
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { planArchiveTrim, planRetention } from './derive.js'
import { parseTurns, recordLine } from './format.js'
import { longTermSkeleton, memoryReadme } from './templates.js'

const DAY_MS = 86_400_000

/**
 * Read a text file up to a byte budget without loading the whole file.
 * @param {string} file absolute path
 * @param {number} maxBytes byte budget
 * @returns {{ text: string, bytes: number, truncated: boolean, exists: boolean }} capped contents
 */
function readCapped(file, maxBytes) {
  let stat
  try {
    stat = statSync(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { text: '', bytes: 0, truncated: false, exists: false }
    throw error
  }
  if (stat.size <= maxBytes) {
    return { text: readFileSync(file, 'utf8'), bytes: stat.size, truncated: false, exists: true }
  }
  const handle = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const read = readSync(handle, buffer, 0, maxBytes, 0)
    const text = buffer.subarray(0, read).toString('utf8').replace(/\uFFFD+$/u, '')
    return { text, bytes: stat.size, truncated: true, exists: true }
  } finally {
    closeSync(handle)
  }
}

/**
 * Replace a file atomically.
 * @param {string} file absolute path
 * @param {string} text new contents
 * @returns {void}
 */
function writeAtomic(file, text) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file may not exist; the original error is the useful one.
    }
    throw error
  }
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
