/**
 * Small filesystem helpers shared by the memory stores.
 *
 * Every write in this plugin is atomic (temporary file + rename) so a crash
 * never leaves a half-written knowledge base, and every read is byte-capped so
 * a hand-edited giant file cannot stall the prompt assembly.
 */

import { closeSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * Read a text file up to a byte budget without loading the whole file.
 * @param {string} file absolute path
 * @param {number} maxBytes byte budget
 * @returns {{ text: string, bytes: number, truncated: boolean, exists: boolean }} capped contents
 */
export function readCapped(file, maxBytes) {
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
export function writeAtomic(file, text) {
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
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
 * Cheap change fingerprint for a set of files: paths, sizes, and mtimes.
 * @param {Array<string | null | undefined>} files absolute paths
 * @returns {string} stable signature
 */
export function fileSignature(files) {
  const parts = []
  for (const file of files) {
    if (!file) {
      parts.push('-')
      continue
    }
    try {
      const stat = statSync(file)
      parts.push(`${stat.size}:${stat.mtimeMs}`)
    } catch {
      parts.push('missing')
    }
  }
  return parts.join('|')
}
