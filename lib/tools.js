/**
 * The seven model-facing memory tools.
 *
 * Schemas use only the harness-enforced JSON Schema subset (type, properties,
 * required, additionalProperties, items, enum, description). Tool results are
 * bounded and never include a whole archive.
 */

import { buildConsolidationBrief, renderConsolidationBrief } from './consolidate.js'
import { deriveCurrentFiles } from './derive.js'
import {
  buildReadText,
  buildSearchText,
  buildWorkingText,
  CHANGE_TYPES,
  oneLine,
  shortSessionId,
  truncateUtf8,
  validateAnnotation,
} from './format.js'
import { isDirectory, projectRootOf, toProjectRelative } from './paths.js'
import { reinforcedIds, searchMemory } from './recall.js'

const READ_SCOPES = ['current', 'all', 'turns', 'long-term', 'archive', 'working', 'brief']
const SEARCH_SCOPES = ['all', 'turns', 'archive', 'long-term', 'working']

const SEARCH_KINDS = {
  turns: ['turn'],
  archive: ['archive'],
  'long-term': ['long-term'],
  working: ['working'],
}

const FILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    added: { type: 'integer' },
    deleted: { type: 'integer' },
  },
  required: ['path'],
}

const CURRENT_FILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    turn: { type: 'integer' },
    at: { type: 'string' },
    type: { type: 'string' },
    summary: { type: 'string' },
    added: { type: 'integer' },
    deleted: { type: 'integer' },
  },
  required: ['path', 'turn', 'at', 'type', 'summary'],
}

const DIFF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    text: { type: 'string' },
  },
  required: ['path', 'text'],
}

const TURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    turn: { type: 'integer' },
    at: { type: 'string' },
    type: { type: 'string' },
    summary: { type: 'string' },
    detail: { type: 'string' },
    files: { type: 'array', items: FILE_SCHEMA },
    diff: { type: 'array', items: DIFF_SCHEMA },
  },
  required: ['turn', 'at', 'type', 'summary', 'files'],
}

const WORKING_STATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string' },
    exists: { type: 'boolean' },
    updatedAt: { type: 'string' },
    task: { type: 'string' },
    next: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['path', 'exists', 'updatedAt', 'task', 'next', 'questions', 'notes'],
}

const SEARCH_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string' },
    id: { type: 'string' },
    recordId: { type: 'string' },
    turn: { type: 'integer' },
    at: { type: 'string' },
    type: { type: 'string' },
    summary: { type: 'string' },
    snippet: { type: 'string' },
    score: { type: 'number' },
    matched: { type: 'array', items: { type: 'string' } },
  },
  required: ['kind', 'id', 'recordId', 'turn', 'at', 'type', 'summary', 'snippet', 'score', 'matched'],
}

const READ_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    project: { type: 'string' },
    longTerm: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        text: { type: 'string' },
        truncated: { type: 'boolean' },
        updatedAt: { type: 'string' },
      },
      required: ['path', 'text', 'truncated', 'updatedAt'],
    },
    shortTerm: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        totalTurns: { type: 'integer' },
        forgottenCount: { type: 'integer' },
        currentFiles: { type: 'array', items: CURRENT_FILE_SCHEMA },
        recentTurns: { type: 'array', items: TURN_SCHEMA },
      },
      required: ['path', 'totalTurns', 'forgottenCount', 'currentFiles', 'recentTurns'],
    },
    working: WORKING_STATE_SCHEMA,
    brief: { type: 'string' },
    archive: { type: 'array', items: TURN_SCHEMA },
    archiveTotal: { type: 'integer' },
  },
  required: ['project', 'longTerm', 'shortTerm'],
}

const READ_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: {
      type: 'string',
      enum: READ_SCOPES,
      description:
        'current (default): long-term memory plus each file current state and the last few turns. all: current plus raw turn records. turns: raw turn records including bounded diff excerpts. long-term: the long-term file only. archive: records forgotten from the live window. working: this session working memory. brief: consolidation evidence (repeated subjects, duplicates, stale pins, forget candidates).',
    },
    limit: { type: 'integer', description: 'Maximum current files, turns, or archive entries to return. Defaults to 20.' },
  },
}

const RECORD_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'One line: what this turn changed and why (max 200 characters).' },
    type: { type: 'string', enum: CHANGE_TYPES, description: 'Change category; defaults to other.' },
    subject: {
      type: 'string',
      description:
        'Optional logical subject reused across turns for the same thing (for example one config value or endpoint), so the current state groups correctly and consolidation can see repeats.',
    },
    detail: { type: 'string', description: 'Optional extra detail (max 2000 characters).' },
    files: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional project-relative files that the automatic comparison cannot see. Files touched through the file tools are added automatically.',
    },
  },
  required: ['summary'],
}

const UPDATE_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    content: { type: 'string', description: 'Markdown body. In append mode each line becomes a bullet item under the section.' },
    section: {
      type: 'string',
      description: 'Exact existing "## " section name. Omit to append under the fallback notes section.',
    },
    mode: {
      type: 'string',
      enum: ['append', 'replace_section'],
      description: 'append (default) adds bullet items to the section body; replace_section replaces that body.',
    },
  },
  required: ['content'],
}

const FORGET_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    files: { type: 'array', items: { type: 'string' }, description: 'Forget turns whose change set includes any of these project-relative paths.' },
    subject: { type: 'string', description: 'Forget turns carrying exactly this subject.' },
    before: { type: 'string', description: 'ISO date; forget turns older than it.' },
    includePinned: { type: 'boolean', description: 'Also forget pinned records. Defaults to false: pinned records are protected.' },
  },
}

const SEARCH_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      description:
        'Free-text query (Chinese and English both work). Omit an empty query to get the most recent records instead.',
    },
    limit: { type: 'integer', description: 'Maximum hits (default 8, max 50).' },
    scope: {
      type: 'string',
      enum: SEARCH_SCOPES,
      description: 'all (default): live turns, archived turns, long-term sections, and working memory. Narrow with turns, archive, long-term, or working.',
    },
  },
  required: ['query'],
}

const WORK_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', enum: ['read', 'update', 'clear'], description: 'read (default), update, or clear this session working memory.' },
    task: { type: 'string', description: 'What this session is currently doing. Replaces the previous task; an empty string clears it.' },
    next: { type: 'array', items: { type: 'string' }, description: 'Next steps (appended unless replace is true).' },
    questions: { type: 'array', items: { type: 'string' }, description: 'Open questions or pending decisions.' },
    notes: { type: 'array', items: { type: 'string' }, description: 'Short-lived notes worth remembering within this session.' },
    replace: { type: 'boolean', description: 'Replace the list fields instead of appending to them.' },
  },
  required: ['op'],
}

const PIN_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ids: { type: 'array', items: { type: 'string' }, description: 'Record ids to pin (as shown by memory_read or memory_search).' },
    subject: { type: 'string', description: 'Pin every record with exactly this subject.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Pin every record whose change set includes one of these project-relative paths.' },
    before: { type: 'string', description: 'Pin every record older than this ISO date.' },
    pinned: { type: 'boolean', description: 'true (default) pins; false unpins the matching records.' },
  },
}

/**
 * @param {object} turn raw record
 * @param {object} config effective config
 * @param {boolean} includeDiff whether to keep bounded diff excerpts
 * @returns {object} compact record matching TURN_SCHEMA
 */
function compactTurn(turn, config, includeDiff) {
  const files = (Array.isArray(turn.files) ? turn.files : [])
    .filter((file) => file && typeof file.path === 'string')
    .map((file) => ({
      path: file.path,
      ...(Number.isFinite(file.added) ? { added: file.added } : {}),
      ...(Number.isFinite(file.deleted) ? { deleted: file.deleted } : {}),
    }))
  const value = {
    turn: Number.isFinite(turn.turn) ? turn.turn : 0,
    at: String(turn.at ?? ''),
    type: String(turn.type ?? 'other'),
    summary: oneLine(turn.summary, 200),
    files,
  }
  if (typeof turn.detail === 'string' && turn.detail.trim()) value.detail = truncateUtf8(turn.detail, 4000, '…')
  if (includeDiff && Array.isArray(turn.diff) && turn.diff.length) {
    value.diff = turn.diff.slice(0, 10).map((entry) => ({
      path: String(entry?.path ?? ''),
      text: truncateUtf8(String(entry?.text ?? ''), config.diffMaxChars, '\n…'),
    }))
  }
  return value
}

/**
 * @param {unknown} value candidate
 * @param {number} fallback default
 * @param {number} min minimum
 * @param {number} max maximum
 * @returns {number} integer in range
 */
function integerOr(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * @param {object} state working-memory state or null
 * @param {string} path absolute working file
 * @returns {object} shape matching WORKING_STATE_SCHEMA
 */
function workingValue(state, path) {
  return {
    path,
    exists: Boolean(state),
    updatedAt: state?.updatedAt ?? '',
    task: state?.task ?? '',
    next: state?.next ?? [],
    questions: state?.questions ?? [],
    notes: state?.notes ?? [],
  }
}

/**
 * Build the tool definitions for one plugin activation.
 * @param {{ ctx: object, store: import('./store.js').MemoryStore, working: import('./working.js').WorkingMemory, tracker: import('./tracker.js').TurnTracker, config: object }} input
 * @returns {object[]} tool definitions
 */
export function createTools({ ctx, store, working: workingStore, tracker, config }) {
  /**
   * Resolve the project of one tool call.
   * @param {{ agent?: { id: string, session?: object } }} exec tool execution
   * @returns {{ agent: object, session: object, root: string, cwd: string }} project context
   */
  const resolveProject = (exec) => {
    const agent = exec?.agent
    if (!agent) throw new Error('This memory tool requires an owning agent session.')
    const session = ctx.sessions?.get?.(agent.id) ?? agent.session
    if (!session) throw new Error('The owning session is not available.')
    const root = projectRootOf(session, (value) => ctx.get('workingDirectory')?.get(value))
    if (!root || !isDirectory(root)) throw new Error('The project directory is not available.')
    const cwd = ctx.get('workingDirectory')?.get(session) || session.header?.cwd || root
    return { agent, session, root, cwd }
  }

  const memoryRead = {
    name: 'memory_read',
    description:
      "Read this project's shared memory: the long-term consensus, the current state of each changed file, recent turns, this session's working memory, and optionally the forgotten-record archive or the consolidation brief. The injected system prompt is a session-start snapshot; call this to see the latest memory.",
    parameters: READ_PARAMETERS,
    output: {
      schema: READ_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: buildReadText(value, config) }],
    },
    isConcurrencySafe: () => true,
    execute(args, execution) {
      const { session, root } = resolveProject(execution)
      store.ensure(root)
      const scope = READ_SCOPES.includes(args?.scope) ? args.scope : 'current'
      const limit = integerOr(args?.limit, 20, 1, 50)
      const longTerm = store.readLongTerm(root)
      const turns = store.readTurns(root)
      const dark = scope === 'turns' || scope === 'archive' || scope === 'working' || scope === 'brief'
      const longTermText = dark || !longTerm.exists ? '' : truncateUtf8(longTerm.text, config.maxReadBytes, '\n… (truncated)')
      const value = {
        project: root,
        longTerm: {
          path: longTerm.path,
          text: longTermText,
          truncated: longTerm.truncated || longTermText !== longTerm.text,
          updatedAt: longTerm.updatedAt,
        },
        shortTerm: {
          path: turns.path,
          totalTurns: turns.turns.length,
          forgottenCount: store.countArchive(root),
          currentFiles: [],
          recentTurns: [],
        },
      }
      if (scope === 'current' || scope === 'all') {
        const all = deriveCurrentFiles(turns.turns, 1000)
        value.shortTerm.currentFiles = all.slice(0, limit)
      }
      if (scope !== 'long-term' && scope !== 'working' && scope !== 'brief') {
        const turnLimit = scope === 'current' ? Math.min(limit, config.injectRecentTurns) : limit
        const withDiff = scope === 'turns' || scope === 'all'
        value.shortTerm.recentTurns = turns.turns
          .slice(-turnLimit)
          .reverse()
          .map((turn) => compactTurn(turn, config, withDiff))
      }
      if (scope === 'archive') {
        const archive = store.readArchive(root, limit)
        value.archive = archive.entries.map((turn) => compactTurn(turn, config, true))
        value.archiveTotal = archive.total
      }
      if (scope === 'working' && workingStore) {
        const state = config.enableWorkingMemory ? workingStore.read(root, session.id) : null
        value.working = workingValue(state, workingStore.path(root, session.id))
      }
      if (scope === 'brief') {
        const brief = buildConsolidationBrief({
          turns: turns.turns,
          archiveTotal: store.countArchive(root),
          sections: store.readLongTermSections(root).sections,
          working: workingStore ? workingStore.read(root, session.id) : null,
          config,
        })
        value.brief = renderConsolidationBrief(brief, config.language, config.consolidateBriefBytes, truncateUtf8)
      }
      return value
    },
  }

  const memoryRecord = {
    name: 'memory_record',
    description:
      "Describe what this development turn changed, in your own words. The record is written when the turn ends: its files, line counts, and importance are detected automatically, and this call adds the intent. Call it once after a turn's work is done.",
    parameters: RECORD_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          turn: { type: 'integer' },
          accepted: { type: 'boolean' },
          files: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['turn', 'accepted', 'files', 'note'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Recorded for turn ${value.turn}. It will be written together with this turn's detected file changes when the turn ends.`,
        },
      ],
    },
    execute(args, execution) {
      const { agent, session, root, cwd } = resolveProject(execution)
      const annotation = validateAnnotation(args, { config, root, cwd })
      const turn = tracker.currentTurn(agent.id) || 0
      tracker.setAnnotation(agent.id, annotation)
      const isChild = Boolean(session.header?.origin === 'subagent' || session.header?.parentSession)
      return {
        turn,
        accepted: true,
        files: annotation.files ?? [],
        note: isChild
          ? `Pending: this subagent session (${shortSessionId(session.id)}) adds its files and this description to the parent turn's record.`
          : "Pending: this turn's record is written at turn end after the workspace comparison.",
      }
    },
  }

  const memoryUpdateLongTerm = {
    name: 'memory_update_long_term',
    description:
      'Append to or replace one section of this project\'s long-term memory. Use it only for facts that stay true (stack, layout, build and verify commands, conventions, decisions), not for temporary state.',
    parameters: UPDATE_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
          sections: { type: 'array', items: { type: 'string' } },
        },
        required: ['path', 'bytes', 'sections'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Long-term memory updated (${value.bytes} bytes). Sections: ${value.sections.join(' | ') || '(none)'}.`,
        },
      ],
    },
    execute(args, execution) {
      const { root } = resolveProject(execution)
      const content = typeof args?.content === 'string' ? args.content : ''
      if (!content.trim()) throw new Error('content is required.')
      const section = typeof args?.section === 'string' && args.section.trim() ? args.section.trim() : undefined
      const mode = args?.mode === 'replace_section' ? 'replace_section' : 'append'
      return store.updateLongTerm(root, { section, mode, content })
    },
  }

  const memoryForget = {
    name: 'memory_forget',
    description:
      'Forget short-term turns that are outdated, reverted, or already merged into long-term memory. Provide at least one of files, subject, or before. By default records are archived, not deleted, and pinned records are protected.',
    parameters: FORGET_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          forgottenTurns: { type: 'integer' },
          mode: { type: 'string' },
        },
        required: ['forgottenTurns', 'mode'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Forgot ${value.forgottenTurns} short-term turn record(s) (mode: ${value.mode}).`,
        },
      ],
    },
    execute(args, execution) {
      const { root, cwd } = resolveProject(execution)
      const files = []
      if (args?.files !== undefined) {
        if (!Array.isArray(args.files)) throw new Error('files must be an array of project-relative paths.')
        for (const file of args.files) {
          const relative = toProjectRelative(file, root, cwd)
          if (!relative) throw new Error(`file is outside the project: ${String(file)}`)
          if (!files.includes(relative)) files.push(relative)
        }
      }
      const subject = typeof args?.subject === 'string' && args.subject.trim() ? args.subject.trim() : undefined
      const before = typeof args?.before === 'string' && args.before.trim() ? Date.parse(args.before) : undefined
      if (before !== undefined && !Number.isFinite(before)) throw new Error('before must be an ISO date.')
      if (!files.length && !subject && before === undefined) {
        throw new Error('Provide at least one of files, subject, or before.')
      }
      const includePinned = args?.includePinned === true
      let pinnedHits = 0
      const count = store.forget(root, (turn) => {
        const matches =
          (files.length && Array.isArray(turn.files) && turn.files.some((file) => files.includes(file.path))) ||
          (subject && turn.subject === subject) ||
          (before !== undefined && Number.isFinite(Date.parse(String(turn.at ?? ''))) && Date.parse(String(turn.at ?? '')) < before)
        if (!matches) return false
        if (turn.pinned === true && !includePinned) {
          pinnedHits += 1
          return false
        }
        return true
      })
      if (count === 0) {
        throw new Error(
          pinnedHits > 0
            ? 'All matching records are pinned; unpin them first or pass includePinned=true.'
            : 'No short-term record matched; nothing was forgotten.',
        )
      }
      return { forgottenTurns: count, mode: config.forgetMode }
    },
  }

  const memorySearch = {
    name: 'memory_search',
    description:
      'Search this project\'s memory by relevance (BM25 over turn summaries, details, files, long-term sections, and working memory; Chinese and English both work). Use it to find past decisions, the reason a file changed, or whether something was already done.',
    parameters: SEARCH_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          total: { type: 'integer' },
          items: { type: 'array', items: SEARCH_ITEM_SCHEMA },
        },
        required: ['query', 'total', 'items'],
      },
      render: (_args, value) => [{ type: 'text', text: buildSearchText(value, config.language, config) }],
    },
    isConcurrencySafe: () => true,
    execute(args, execution) {
      const { session, root } = resolveProject(execution)
      const scope = SEARCH_SCOPES.includes(args?.scope) ? args.scope : 'all'
      const limit = integerOr(args?.limit, config.searchMaxResults, 1, 50)
      const turns = store.readTurns(root).turns
      const archive = scope === 'archive' || scope === 'all' ? store.readArchive(root, config.archiveSearchLimit).entries : []
      const sectionView = store.readLongTermSections(root)
      const sections = sectionView.sections.map((section) => ({ ...section, at: sectionView.updatedAt }))
      const workingState = config.enableWorkingMemory && workingStore ? workingStore.read(root, session.id) : null
      const result = searchMemory({
        turns,
        archive,
        sections,
        working: workingState,
        query: typeof args?.query === 'string' ? args.query : '',
        limit,
        kinds: scope === 'all' ? undefined : SEARCH_KINDS[scope],
        config,
      })
      if (config.reinforceHits) {
        store.touchTurns(root, reinforcedIds(result.items.filter((item) => item.kind === 'turn')))
      }
      return {
        query: result.query,
        total: result.items.length,
        items: result.items.map((item) => ({ ...item, turn: Number.isFinite(item.turn) ? item.turn : 0 })),
      }
    },
  }

  const memoryWork = {
    name: 'memory_work',
    description:
      "Read or update this session's working memory: the current task, next steps, open questions, and short-lived notes. It is injected at the top of the memory block, survives across turns, and expires automatically. Use it for work in progress, not for durable project facts.",
    parameters: WORK_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string' },
          state: WORKING_STATE_SCHEMA,
        },
        required: ['op', 'state'],
      },
      render: (_args, value) => [{ type: 'text', text: buildWorkingText(value.state, config.language, value.state.path) }],
    },
    execute(args, execution) {
      const { session, root } = resolveProject(execution)
      if (!workingStore) throw new Error('Working memory is disabled in this composition.')
      const op = ['read', 'update', 'clear'].includes(args?.op) ? args.op : 'read'
      const path = workingStore.path(root, session.id)
      if (op === 'clear') {
        workingStore.clear(root, session.id)
        return { op, state: workingValue(null, path) }
      }
      if (op === 'read') {
        return { op, state: workingValue(workingStore.read(root, session.id), path) }
      }
      const patch = {}
      if (typeof args?.task === 'string') patch.task = args.task
      for (const field of ['next', 'questions', 'notes']) {
        if (args?.[field] === undefined) continue
        if (!Array.isArray(args[field])) throw new Error(`${field} must be an array of strings.`)
        patch[field] = args[field]
      }
      if (args?.replace === true) patch.replaceArrays = true
      if (!Object.keys(patch).length) throw new Error('update needs at least one of task, next, questions, or notes.')
      const written = workingStore.write(root, session.id, patch)
      return { op, state: workingValue(written.state, written.path) }
    },
  }

  const memoryPin = {
    name: 'memory_pin',
    description:
      'Pin short-term records so forgetting never drops them, or unpin them again. Select records by id, subject, files, or before date. Use it for decisions later sessions must still find.',
    parameters: PIN_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          updated: { type: 'integer' },
          pinned: { type: 'boolean' },
          totalPinned: { type: 'integer' },
        },
        required: ['updated', 'pinned', 'totalPinned'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.pinned
            ? `Pinned ${value.updated} record(s); ${value.totalPinned} pinned in total.`
            : `Unpinned ${value.updated} record(s); ${value.totalPinned} still pinned.`,
        },
      ],
    },
    execute(args, execution) {
      const { root, cwd } = resolveProject(execution)
      const ids = Array.isArray(args?.ids) ? args.ids.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()) : []
      const subject = typeof args?.subject === 'string' && args.subject.trim() ? args.subject.trim() : undefined
      const files = []
      if (args?.files !== undefined) {
        if (!Array.isArray(args.files)) throw new Error('files must be an array of project-relative paths.')
        for (const file of args.files) {
          const relative = toProjectRelative(file, root, cwd)
          if (!relative) throw new Error(`file is outside the project: ${String(file)}`)
          if (!files.includes(relative)) files.push(relative)
        }
      }
      const before = typeof args?.before === 'string' && args.before.trim() ? Date.parse(args.before) : undefined
      if (before !== undefined && !Number.isFinite(before)) throw new Error('before must be an ISO date.')
      if (!ids.length && !subject && !files.length && before === undefined) {
        throw new Error('Provide at least one of ids, subject, files, or before.')
      }
      const pinned = args?.pinned !== false
      const predicate = (turn) => {
        if (ids.length && ids.includes(String(turn?.id ?? ''))) return true
        if (subject && turn?.subject === subject) return true
        if (files.length && Array.isArray(turn?.files) && turn.files.some((file) => files.includes(file.path))) return true
        if (before !== undefined) {
          const at = Date.parse(String(turn?.at ?? ''))
          if (Number.isFinite(at) && at < before) return true
        }
        return false
      }
      const beforeTurns = store.readTurns(root).turns
      const matched = beforeTurns.filter(predicate)
      if (!matched.length) throw new Error('No short-term record matched; nothing was pinned.')
      const alreadyPinned = beforeTurns.filter((turn) => turn.pinned === true).length
      const newlyPinned = pinned ? matched.filter((turn) => turn.pinned !== true).length : 0
      const newlyUnpinned = pinned ? 0 : matched.filter((turn) => turn.pinned === true).length
      const totalPinned = alreadyPinned + newlyPinned - newlyUnpinned
      if (pinned && totalPinned > config.maxPinnedRecords) {
        throw new Error(
          `Pinning would exceed maxPinnedRecords (${config.maxPinnedRecords}); unpin some records first.`,
        )
      }
      const { updated } = store.updateTurns(root, predicate, { pinned })
      return { updated, pinned, totalPinned }
    },
  }

  const tools = [memoryRead, memoryRecord, memoryUpdateLongTerm, memoryForget]
  if (config.enableSearch) tools.push(memorySearch)
  if (config.enableWorkingMemory && workingStore) tools.push(memoryWork)
  tools.push(memoryPin)
  return tools
}
