/**
 * project-memory: a per-project shared knowledge base for DeepSeek Harness.
 *
 * Trigger summary:
 * - workspace created        → create `memory/` (long-term.md, short-term.jsonl, README.md)
 * - agent created            → ensure + compact + freeze the prompt snapshot
 * - development turn ends    → compare the turn snapshots, write one net-change record, compact
 * - working directory change → re-render for the new project
 * - `/dreaming`              → queue one model turn that consolidates short-term into long-term
 *
 * The plugin writes no session events. Everything durable lives in files under
 * `<project>/memory/`, so fork, resume, and replay stay untouched by design.
 */

import path from 'node:path'

import { normalizeConfig } from './lib/config.js'
import { deriveCurrentFiles, mergeTurnChanges } from './lib/derive.js'
import { buildPromptBlock, makeRecordId, mergeTurnNotes, truncateUtf8 } from './lib/format.js'
import { canonicalize, isDirectory, isInsideMemoryDir, projectRootOf, toProjectRelative } from './lib/paths.js'
import { MemoryStore } from './lib/store.js'
import { descendantIds, TurnTracker } from './lib/tracker.js'
import { createTools } from './lib/tools.js'
import { runDreaming } from './lib/dreaming.js'

export const name = 'project-memory'

// `tools`, `systemPrompt`, and `sessions` are the plugin's hard surface.
// `commands`, `agents`, `workingDirectory`, `workspaceRegistry`, and
// `workspaceChanges` are optional and read through `ctx.get()`, so the plugin
// still records memory in a composition that omits any of them.
export const inject = ['tools', 'systemPrompt', 'sessions']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 * @param {unknown} rawConfig loader row config
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const store = new MemoryStore(config)
  const tracker = new TurnTracker()

  /** @type {Map<string, string>} session id → frozen prompt block */
  const frozen = new Map()
  /** @type {Map<string, { turn: number, seq: number }>} session id → latest workspace/changes event */
  const changeEvents = new Map()
  /** @type {Map<string, Array<{ turn: number, resolve: (value: any) => void, timer: any }>>} */
  const waiters = new Map()
  /** @type {Map<string, Set<number>>} session id → turns already scheduled */
  const recordedTurns = new Map()
  /** @type {Map<string, number>} project root → consolidation guard expiry */
  const dreamingInFlight = new Map()
  /** @type {Set<Promise<unknown>>} in-flight turn record writes */
  const pendingRecords = new Set()
  /** @type {Set<any>} timers owned by this activation */
  const timers = new Set()

  const warn = (message, error) => {
    try {
      ctx.logger?.warn?.(`project-memory: ${message}${error ? `: ${String(error)}` : ''}`)
    } catch {
      // Logging must never fail a listener.
    }
  }
  const workingDirectory = () => ctx.get('workingDirectory')
  const sessionRoot = (session) => projectRootOf(session, (value) => workingDirectory()?.get(value))
  const isSubagent = (session) => {
    const header = session?.header
    return Boolean(header && (header.origin === 'subagent' || header.parentSession))
  }

  /**
   * Ensure the project memory exists and return its project root.
   * @param {object | undefined} session candidate session
   * @returns {string | null} project root, or null when unusable
   */
  function ensureSession(session) {
    try {
      const root = sessionRoot(session)
      if (!root || !isDirectory(root)) return null
      store.ensure(root)
      return root
    } catch (error) {
      warn('ensuring project memory failed', error)
      return null
    }
  }

  /**
   * @param {string} projectPath absolute project directory from a workspace record
   * @returns {void}
   */
  function ensureProject(projectPath) {
    try {
      if (typeof projectPath !== 'string' || !isDirectory(projectPath)) return
      const root = canonicalize(projectPath)
      store.ensure(root)
      store.compact(root)
    } catch (error) {
      warn(`ensuring ${String(projectPath)} failed`, error)
    }
  }

  /**
   * Resolve one waiting turn's `workspace/changes` event, if it arrives in time.
   * @param {string} sessionId session id
   * @param {number} turn turn number
   * @param {number} timeoutMs wait budget
   * @returns {Promise<{ turn: number, seq: number } | null>} matching event
   */
  function waitForChange(sessionId, turn, timeoutMs) {
    const current = changeEvents.get(sessionId)
    if (current && current.turn === turn) return Promise.resolve(current)
    if (!(timeoutMs > 0)) return Promise.resolve(null)
    return new Promise((resolve) => {
      const entry = { turn, resolve: null, timer: null }
      entry.resolve = (value) => {
        if (entry.timer) clearTimeout(entry.timer)
        const list = waiters.get(sessionId)
        if (list) {
          const index = list.indexOf(entry)
          if (index >= 0) list.splice(index, 1)
          if (!list.length) waiters.delete(sessionId)
        }
        resolve(value)
      }
      entry.timer = setTimeout(() => entry.resolve(null), timeoutMs)
      timers.add(entry.timer)
      const list = waiters.get(sessionId) ?? []
      list.push(entry)
      waiters.set(sessionId, list)
    })
  }

  /**
   * @param {string} sessionId session id
   * @param {number} turn turn number
   * @param {number} seq event sequence
   * @returns {void}
   */
  function resolveWaiters(sessionId, turn, seq) {
    const list = waiters.get(sessionId)
    if (!list) return
    for (const entry of [...list]) {
      if (entry.turn === turn) entry.resolve({ turn, seq })
    }
  }

  /**
   * @param {object} hunks workspace diff hunks
   * @returns {string | null} bounded unified-diff excerpt
   */
  function excerptDiff(hunks) {
    if (!Array.isArray(hunks) || !hunks.length || config.diffMaxLines <= 0) return null
    const lines = []
    for (const hunk of hunks) {
      lines.push(`@@ -${hunk.oldStart ?? 0},${hunk.oldLines ?? 0} +${hunk.newStart ?? 0},${hunk.newLines ?? 0} @@`)
      for (const line of hunk.lines ?? []) {
        lines.push(String(line))
        if (lines.length >= config.diffMaxLines) break
      }
      if (lines.length >= config.diffMaxLines) break
    }
    if (!lines.length) return null
    return truncateUtf8(lines.join('\n'), config.diffMaxChars, '\n…')
  }

  /**
   * @param {object} changes workspaceChanges service
   * @param {object} session owning session
   * @param {number} seq workspace/changes event sequence
   * @param {number} index file index in the summary
   * @returns {Promise<string | null>} bounded diff excerpt
   */
  async function fetchDiff(changes, session, seq, index) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    timers.add(timer)
    try {
      const diff = await changes.diff(session.id, seq, index, controller.signal)
      if (!diff || diff.kind !== 'text') return null
      return excerptDiff(diff.hunks)
    } catch {
      return null
    } finally {
      clearTimeout(timer)
      timers.delete(timer)
    }
  }

  /**
   * Describe where the recorded file set came from.
   * @param {number} snapshotCount files from the workspace snapshot
   * @param {number} trackedCount files from file-tool tracking
   * @returns {string} provenance label
   */
  function originOf(snapshotCount, trackedCount, modelCount) {
    if (snapshotCount > 0 && trackedCount > 0) return 'snapshot+tracked'
    if (snapshotCount > 0) return 'snapshot'
    if (trackedCount > 0) return 'tracked'
    if (modelCount > 0) return 'agent'
    return 'agent-only'
  }

  /**
   * Write one turn record from the workspace comparison, tracked edits, the
   * model's annotation, and any subagent notes folded into this turn.
   * @param {{ session: object, turn: number, at: string, bucket: { files: Map<string, string>, annotation: object | null }, childNotes?: object[] }} input
   * @returns {Promise<void>} completion
   */
  async function recordTurn({ session, turn, at, bucket, childNotes = [] }) {
    const root = ensureSession(session)
    if (!root) return
    const sessionId = String(session.id)
    const changes = ctx.get('workspaceChanges')
    let summary = null
    let changeSeq = null
    if (changes && typeof changes.summary === 'function') {
      let event = changeEvents.get(sessionId)
      if (!event || event.turn !== turn) event = await waitForChange(sessionId, turn, config.changeWaitMs)
      if (event && event.turn === turn) {
        changeSeq = event.seq
        try {
          summary = changes.summary(session.id, event.seq) ?? null
        } catch (error) {
          warn('reading the workspace summary failed', error)
        }
      }
    }

    const snapshotFiles = []
    if (summary && Array.isArray(summary.files)) {
      const base = summary.cwd || session.header?.cwd || root
      for (let index = 0; index < summary.files.length; index += 1) {
        const file = summary.files[index]
        if (!file || typeof file.path !== 'string') continue
        const relative = toProjectRelative(file.path, root, base)
        if (!relative || isInsideMemoryDir(relative, config.directoryName)) continue
        snapshotFiles.push({
          path: relative,
          added: file.added,
          deleted: file.deleted,
          binary: file.binary === true,
          oversized: file.oversized === true,
          index,
        })
      }
    }

    const trackedFiles = [...bucket.files.entries()].map(([relativePath]) => ({ path: relativePath }))
    const modelFiles = bucket.annotation?.files ?? []
    const merged = mergeTurnChanges({
      snapshotFiles,
      trackedFiles,
      modelFiles,
      maxFiles: config.maxFilesPerRecord,
      directoryName: config.directoryName,
    })
    const annotation = bucket.annotation
    if (!merged.files.length && !annotation && !childNotes.length) return

    const diffs = []
    if (config.includeDiff && changes && changeSeq !== null && config.diffFiles > 0) {
      const candidates = snapshotFiles.filter((file) => !file.binary && !file.oversized).slice(0, config.diffFiles)
      for (const candidate of candidates) {
        const text = await fetchDiff(changes, session, changeSeq, candidate.index)
        if (text) diffs.push({ path: candidate.path, text })
      }
    }

    const notes = mergeTurnNotes({
      annotation,
      childNotes,
      files: merged.files,
      language: config.language,
      maxDetailChars: 2000,
    })
    const record = {
      v: 1,
      id: makeRecordId(),
      turn,
      at,
      session: sessionId,
      cwd: root,
      type: notes.type,
    }
    if (notes.subject) record.subject = notes.subject
    record.summary = notes.summary
    if (notes.detail) record.detail = notes.detail
    record.files = merged.files
    if (diffs.length) record.diff = diffs
    record.origin = originOf(snapshotFiles.length, trackedFiles.length, modelFiles.length)
    record.source = notes.source
    store.appendTurn(root, record)
  }

  /**
   * Schedule one turn record without blocking the turn boundary.
   * @param {object | undefined} session owning session
   * @param {number} turn turn number
   * @returns {void}
   */
  function scheduleTurnRecord(session, turn) {
    if (!session || !Number.isFinite(turn)) return
    if (isSubagent(session)) return
    const sessionId = String(session.id)
    let recorded = recordedTurns.get(sessionId)
    if (!recorded) {
      recorded = new Set()
      recordedTurns.set(sessionId, recorded)
    }
    if (recorded.has(turn)) return
    recorded.add(turn)

    const bucket = tracker.take(sessionId)
    const agents = ctx.get('agents')
    const childNotes = []
    for (const childId of descendantIds(agents, sessionId)) {
      const childBucket = tracker.take(childId)
      for (const [relativePath, writtenAt] of childBucket.files) {
        if (!bucket.files.has(relativePath)) bucket.files.set(relativePath, writtenAt)
      }
      if (childBucket.annotation?.summary) {
        childNotes.push({ sessionId: childId, ...childBucket.annotation })
      }
    }
    const at = new Date().toISOString()
    const pending = recordTurn({ session, turn, at, bucket, childNotes }).catch((error) => {
      warn(`recording turn ${turn} failed`, error)
    })
    pendingRecords.add(pending)
    void pending.finally(() => pendingRecords.delete(pending))
  }

  // ---------------------------------------------------------------------------
  // Prompt section: a frozen session-start snapshot keeps the prefix stable.
  // ---------------------------------------------------------------------------
  if (config.injectPrompt) {
    ctx.systemPrompt.section({
      name: 'project-memory',
      order: config.sectionOrder,
      interpolate: false,
      text: (assemble) => {
        try {
          const session = assemble?.agent?.session
          if (!session) return ''
          const sessionId = String(session.id)
          const cached = frozen.get(sessionId)
          if (cached !== undefined) return cached
          const root = sessionRoot(session)
          if (!root || !isDirectory(root)) return ''
          if (!isDirectory(path.join(root, config.directoryName))) return ''
          const longTerm = store.readLongTerm(root)
          const turns = store.readTurns(root)
          const allCurrent = deriveCurrentFiles(turns.turns, 1000)
          const currentFiles = allCurrent.slice(0, config.injectCurrentFiles)
          const recentTurns = turns.turns.slice(-config.injectRecentTurns).reverse()
          const text = buildPromptBlock({
            project: path.basename(root),
            root,
            language: config.language,
            longTerm,
            currentFiles,
            recentTurns,
            totalTurns: turns.turns.length,
            hiddenFiles: Math.max(0, allCurrent.length - currentFiles.length),
            hiddenTurns: Math.max(0, turns.turns.length - recentTurns.length),
            forgottenCount: store.countArchive(root),
            config,
          })
          if (text) frozen.set(sessionId, text)
          return text
        } catch (error) {
          warn('rendering the memory prompt failed', error)
          return ''
        }
      },
    })
  }

  // ---------------------------------------------------------------------------
  // Tools.
  // ---------------------------------------------------------------------------
  if (config.enableTools) {
    for (const definition of createTools({ ctx, store, tracker, config })) {
      ctx.tools.register(definition)
    }
  }

  // ---------------------------------------------------------------------------
  // Project creation: scaffold when a workspace record is first persisted.
  // ---------------------------------------------------------------------------
  ctx.on('domain/changed', (change) => {
    try {
      if (!change || change.domain !== 'workspace' || change.table !== 'workspaces' || change.operation !== 'put') return
      const projectPath = change.value?.path
      if (typeof projectPath === 'string') ensureProject(projectPath)
    } catch (error) {
      warn('handling a workspace change failed', error)
    }
  })

  // ---------------------------------------------------------------------------
  // Per-agent lifecycle.
  // ---------------------------------------------------------------------------
  ctx.on('agent/created', async (payload) => {
    try {
      const session = payload?.agent?.session
      if (!session) return
      const sessionId = String(session.id)
      frozen.delete(sessionId)
      recordedTurns.delete(sessionId)
      const root = ensureSession(session)
      if (root) store.compact(root)
    } catch (error) {
      warn('agent initialization failed', error)
    }
  })

  ctx.on('agent/pre-step', (payload, next) => {
    try {
      if (payload?.agent) tracker.noteTurn(payload.agent.id, payload.turn)
    } catch {
      // Observation only.
    }
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    try {
      if (!config.autoRecord || !exec || !exec.agent || !result || result.isError) return
      if (!config.recordToolNames.includes(exec.name)) return
      const args = exec.arguments
      const filePath = args && typeof args === 'object' ? args.file_path : undefined
      if (typeof filePath !== 'string' || !filePath) return
      const session = ctx.sessions?.get?.(exec.agent.id) ?? exec.agent.session
      if (!session) return
      const root = sessionRoot(session)
      if (!root) return
      const cwd = workingDirectory()?.get(session) || session.header?.cwd || root
      const relative = toProjectRelative(filePath, root, cwd)
      if (!relative || isInsideMemoryDir(relative, config.directoryName)) return
      tracker.trackFile(String(exec.agent.id), relative, new Date().toISOString())
    } catch (error) {
      warn('tracking a file edit failed', error)
    }
  })

  ctx.on('agent/turn-stopping', (payload) => {
    try {
      scheduleTurnRecord(payload?.agent?.session, payload?.turn)
    } catch (error) {
      warn('scheduling a turn record failed', error)
    }
  })

  ctx.on('agent/disposed', (payload) => {
    try {
      const sessionId = payload?.agent?.id ? String(payload.agent.id) : ''
      if (!sessionId) return
      tracker.drop(sessionId)
      frozen.delete(sessionId)
      recordedTurns.delete(sessionId)
    } catch {
      // Cleanup only.
    }
  })

  // ---------------------------------------------------------------------------
  // Session events: diff summaries, directory changes, and turn-end fallback.
  // ---------------------------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      const sessionId = String(session.id)
      if (event.type === 'workspace/changes') {
        const turn = Number(event.data?.turn)
        if (Number.isFinite(turn)) {
          changeEvents.set(sessionId, { turn, seq: event.seq })
          resolveWaiters(sessionId, turn, event.seq)
        }
        return
      }
      if (event.type === 'working-directory/change') {
        frozen.delete(sessionId)
        const root = ensureSession(session)
        if (root) store.compact(root)
        return
      }
      if (event.type === 'turn/end') {
        const turn = Number(event.data?.turn)
        if (Number.isFinite(turn)) scheduleTurnRecord(session, turn)
        return
      }
      if (event.type === 'turn/start') {
        const root = sessionRoot(session)
        if (root) dreamingInFlight.delete(root)
      }
    } catch (error) {
      warn('handling a session event failed', error)
    }
  })

  // ---------------------------------------------------------------------------
  // `/dreaming`: queue one consolidation turn. A command handler may only
  // return text, so the model turn is queued through `agent.followup`.
  // ---------------------------------------------------------------------------
  if (config.enableDreamingCommand) {
    let dreamingRegistered = false
    const registerDreaming = () => {
      if (dreamingRegistered) return
      const commands = ctx.get('commands')
      if (!commands || typeof commands.register !== 'function') return
      dreamingRegistered = true
      commands.register({
        name: 'dreaming',
        description:
          config.language === 'zh'
            ? '整理项目记忆：把短期记忆中的稳定共识写入长期记忆，并清理过时记录'
            : 'Consolidate project memory: promote stable consensus into long-term memory and forget outdated rows',
        input: { hint: config.language === 'zh' ? '可选：本次整理的关注点' : 'Optional focus for this consolidation' },
        handler: async (invocation) => {
          try {
            const agent = invocation?.agent
            const session = agent ? ctx.sessions.get(agent.id) ?? agent.session : null
            if (!session) {
              return {
                kind: 'error',
                text: config.language === 'zh' ? '当前会话不可用，无法整理记忆。' : 'The current session is not available.',
              }
            }
            const root = ensureSession(session)
            if (!root) {
              return {
                kind: 'error',
                text:
                  config.language === 'zh'
                    ? '当前会话没有可用的项目目录，无法整理记忆。'
                    : 'This session has no usable project directory.',
              }
            }
            if (pendingRecords.size) {
              await Promise.race([
                Promise.allSettled([...pendingRecords]),
                new Promise((resolve) => {
                  const timer = setTimeout(resolve, 2000)
                  timers.add(timer)
                }),
              ])
            }
            return runDreaming({
              agent,
              session,
              root,
              store,
              config,
              inFlight: dreamingInFlight,
              focus: invocation?.rawInput,
            })
          } catch (error) {
            warn('the dreaming command failed', error)
            return {
              kind: 'error',
              text: config.language === 'zh' ? `整理失败：${String(error?.message ?? error)}` : `Consolidation failed: ${String(error?.message ?? error)}`,
            }
          }
        },
      })
    }
    registerDreaming()
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['commands'], () => registerDreaming())
      } catch {
        // The service is mounted late in some compositions; registration is
        // idempotent and the guarded retry above is best-effort.
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Optional backfill for projects that already existed before installation.
  // ---------------------------------------------------------------------------
  if (config.scaffoldExistingProjects) {
    let attempts = 0
    const backfill = () => {
      try {
        const registry = ctx.get('workspaceRegistry')
        if (!registry || typeof registry.list !== 'function') {
          if (attempts < 20) {
            attempts += 1
            const timer = setTimeout(backfill, 1000)
            timers.add(timer)
          }
          return
        }
        for (const workspace of registry.list()) ensureProject(workspace?.path)
      } catch (error) {
        warn('backfill failed', error)
      }
    }
    backfill()
  }

  ctx.effect(() => () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }, 'project-memory timers')
}
