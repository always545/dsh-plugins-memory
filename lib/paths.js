/**
 * Project-root resolution and path containment for project-memory.
 *
 * A "project" is the DSH workspace directory a Session runs in. Memory always
 * lives inside it, and every path this plugin persists is project-relative so
 * the knowledge base stays portable when the folder moves.
 */

import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * @param {unknown} target candidate path
 * @returns {boolean} whether the path names an existing directory
 */
export function isDirectory(target) {
  if (typeof target !== 'string' || !target) return false
  try {
    return statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve symlinks so two spellings of one directory compare equal.
 * @param {string} target absolute path
 * @returns {string} canonical absolute path
 */
export function canonicalize(target) {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

/**
 * Resolve the project directory of one session.
 * @param {object | undefined} session DSH session
 * @param {(session: object) => string | undefined} [resolveWorkingDirectory]
 *   reads the session's current working directory (a `cd` may have moved it)
 * @returns {string | null} canonical absolute project directory
 */
export function projectRootOf(session, resolveWorkingDirectory) {
  if (!session) return null
  let current
  try {
    current = resolveWorkingDirectory?.(session)
  } catch {
    current = undefined
  }
  const raw = current || session.header?.cwd
  if (typeof raw !== 'string' || !raw) return null
  return canonicalize(raw)
}

/**
 * Whether one absolute path lives strictly under another.
 * @param {string} child absolute path
 * @param {string} parent absolute path
 * @returns {boolean} containment
 */
export function insideRoot(child, parent) {
  if (!child || !parent) return false
  const rel = path.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/**
 * Normalize a tool-supplied path to a project-relative POSIX path.
 * @param {unknown} target absolute or working-directory-relative path
 * @param {string} root project directory
 * @param {string} [cwd] session working directory for relative targets
 * @returns {string | null} relative path, or null when outside the project
 */
export function toProjectRelative(target, root, cwd) {
  if (typeof target !== 'string' || !target.trim() || !root) return null
  const absolute = path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd || root, target)
  if (!insideRoot(absolute, root)) return null
  return path.relative(root, absolute).split(path.sep).join('/')
}

/**
 * Whether a project-relative path belongs to the plugin's own memory directory.
 * @param {string} relative project-relative path
 * @param {string} directoryName memory directory name
 * @returns {boolean} whether the path must stay out of change records
 */
export function isInsideMemoryDir(relative, directoryName) {
  if (!relative || !directoryName) return false
  return relative === directoryName || relative.startsWith(`${directoryName}/`)
}
