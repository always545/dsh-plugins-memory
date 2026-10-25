/**
 * The four model-facing memory tools.
 *
 * Schemas use only the harness-enforced JSON Schema subset (type, properties,
 * required, additionalProperties, items, enum, description). Tool results are
 * bounded and never include a whole archive.
 */

import { deriveCurrentFiles } from './derive.js'
import { buildReadText, CHANGE_TYPES, oneLine, shortSessionId, truncateUtf8, validateAnnotation } from './format.js'
import { isDirectory, projectRootOf, toProjectRelative } from './paths.js'

const READ_SCOPES = ['current', 'all', 'turns', 'long-term', 'archive']

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
        'current (default): long-term memory plus each file current state and the last few turns. all: current plus raw turn records. turns: raw turn records including bounded diff excerpts. long-term: the long-term file only. archive: records forgotten from the live window.',
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
        'Optional logical subject reused across turns for the same thing (for example one config value or endpoint), so the current state groups correctly.',
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
 * Build the tool definitions for one plugin activation.
 * @param {{ ctx: object, store: import('./store.js').MemoryStore, tracker: import('./tracker.js').TurnTracker, config: object }} input
 * @returns {object[]} tool definitions
 */
export function createTools({ ctx, store, tracker, config }) {
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
      "Read this project's shared memory: the long-term consensus, the current state of each changed file, recent turns, and optionally the forgotten-record archive. The injected system prompt is a session-start snapshot; call this to see the latest memory.",
    parameters: READ_PARAMETERS,
    output: {
      schema: READ_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: buildReadText(value, config) }],
    },
    isConcurrencySafe: () => true,
    execute(args, execution) {
      const { root } = resolveProject(execution)
      store.ensure(root)
      const scope = READ_SCOPES.includes(args?.scope) ? args.scope : 'current'
      const limit = integerOr(args?.limit, 20, 1, 50)
      const longTerm = store.readLongTerm(root)
      const turns = store.readTurns(root)
      const dark = scope === 'turns' || scope === 'archive'
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
      if (scope !== 'long-term') {
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
      return value
    },
  }

  const memoryRecord = {
    name: 'memory_record',
    description:
      "Describe what this development turn changed, in your own words. The record is written when the turn ends: its files and line counts are detected automatically, and this call adds the intent. Call it once after a turn's work is done.",
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
      'Forget short-term turns that are outdated, reverted, or already merged into long-term memory. Provide at least one of files, subject, or before. By default records are archived, not deleted.',
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
      const count = store.forget(root, (turn) => {
        if (files.length && Array.isArray(turn.files) && turn.files.some((file) => files.includes(file.path))) return true
        if (subject && turn.subject === subject) return true
        if (before !== undefined) {
          const at = Date.parse(String(turn.at ?? ''))
          if (Number.isFinite(at) && at < before) return true
        }
        return false
      })
      if (count === 0) throw new Error('No short-term record matched; nothing was forgotten.')
      return { forgottenTurns: count, mode: config.forgetMode }
    },
  }

  return [memoryRead, memoryRecord, memoryUpdateLongTerm, memoryForget]
}
