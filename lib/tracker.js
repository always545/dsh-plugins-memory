/**
 * Per-agent turn bookkeeping.
 *
 * `tools/result` contributes the files a file tool successfully touched, while
 * `agent/turn-stopping` consumes the bucket and writes one turn record. The
 * tracker is process-local state; the durable source of truth remains the
 * workspace snapshot plus the project files themselves.
 */

/** One agent's in-flight turn state. */
export class TurnTracker {
  constructor() {
    /** @type {Map<string, { turn: number, files: Map<string, string>, annotation: object | null }>} */
    this.buckets = new Map()
  }

  /**
   * @param {string} agentId owning session id
   * @returns {{ turn: number, files: Map<string, string>, annotation: object | null }} mutable bucket
   */
  bucket(agentId) {
    const key = String(agentId)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { turn: 0, files: new Map(), annotation: null }
      this.buckets.set(key, bucket)
    }
    return bucket
  }

  /**
   * @param {string} agentId owning session id
   * @param {number} turn current turn number
   * @returns {void}
   */
  noteTurn(agentId, turn) {
    if (!Number.isFinite(turn)) return
    this.bucket(agentId).turn = Math.trunc(turn)
  }

  /**
   * @param {string} agentId owning session id
   * @returns {number} last observed turn number, or 0
   */
  currentTurn(agentId) {
    return this.bucket(agentId).turn
  }

  /**
   * Record one successful file mutation. A later write in the same turn
   * replaces the earlier timestamp for that path.
   * @param {string} agentId owning session id
   * @param {string} relativePath project-relative POSIX path
   * @param {string} at ISO timestamp
   * @returns {void}
   */
  trackFile(agentId, relativePath, at) {
    if (!relativePath) return
    this.bucket(agentId).files.set(relativePath, at)
  }

  /**
   * @param {string} agentId owning session id
   * @param {object | null} annotation normalized `memory_record` annotation
   * @returns {void}
   */
  setAnnotation(agentId, annotation) {
    this.bucket(agentId).annotation = annotation
  }

  /**
   * Consume one agent's bucket.
   * @param {string} agentId owning session id
   * @returns {{ turn: number, files: Map<string, string>, annotation: object | null }} detached bucket
   */
  take(agentId) {
    const key = String(agentId)
    const bucket = this.buckets.get(key) ?? { turn: 0, files: new Map(), annotation: null }
    this.buckets.delete(key)
    return bucket
  }

  /**
   * @param {string} agentId owning session id
   * @returns {void}
   */
  drop(agentId) {
    this.buckets.delete(String(agentId))
  }
}

/**
 * Collect live descendant agent ids of one root session.
 * @param {{ list: () => object[] } | undefined} agentsService the `ctx.agents` service, when present
 * @param {string} rootId root session id
 * @returns {string[]} descendant ids, nearest first
 */
export function descendantIds(agentsService, rootId) {
  if (!agentsService || typeof agentsService.list !== 'function') return []
  const children = new Map()
  for (const agent of agentsService.list()) {
    const parent = agent?.session?.header?.parentSession
    if (!parent) continue
    const key = String(parent)
    const list = children.get(key) ?? []
    list.push(String(agent.id))
    children.set(key, list)
  }
  const result = []
  const stack = [...(children.get(String(rootId)) ?? [])]
  while (stack.length) {
    const id = stack.pop()
    result.push(id)
    stack.push(...(children.get(id) ?? []))
  }
  return result
}
