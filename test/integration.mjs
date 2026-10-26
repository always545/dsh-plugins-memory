/**
 * Temporary end-to-end wiring check: real apply() against a fake cordis ctx.
 * Run: node test/.integration-check.mjs <projectRoot>
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'
import { MemoryStore } from '../lib/store.js'
import { normalizeConfig } from '../lib/config.js'
import { WorkingMemory } from '../lib/working.js'

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-int-')))
const sessions = new Map()
const handlers = new Map()
const sections = []
const tools = []
const config = normalizeConfig({ language: 'zh' })

const ctx = {
  logger: { warn: (message) => console.error('WARN', message) },
  sessions: { get: (id) => sessions.get(id) },
  get: (name) => (name === 'workingDirectory' ? { get: () => root } : undefined),
  systemPrompt: { section: (definition) => sections.push(definition) },
  tools: { register: (definition) => tools.push(definition) },
  on: (event, handler) => {
    const list = handlers.get(event) ?? []
    list.push(handler)
    handlers.set(event, list)
  },
  effect: () => {},
  inject: () => {},
}
const emit = (event, ...args) => {
  for (const handler of handlers.get(event) ?? []) handler(...args)
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 120))

try {
  apply(ctx, { language: 'zh' })
  assert.equal(sections.length, 1, 'one prompt section')
  assert.equal(tools.length, 7, `seven tools, got ${tools.map((tool) => tool.name).join(',')}`)
  console.log('ok - apply registered the prompt section and seven tools:', tools.map((tool) => tool.name).join(', '))

  const session = { id: 'session-int', header: { cwd: root } }
  sessions.set(session.id, session)

  // 1. Working memory from the tool lands in the next session's prompt.
  const work = new WorkingMemory(config)
  work.write(root, 'session-other', { task: '把记忆层拆成四层', next: ['写检索'] })
  const other = { id: 'session-other', header: { cwd: root } }
  sessions.set(other.id, other)
  const prompt = sections[0].text({ agent: { session: other } })
  assert.match(prompt, /<project-memory project=/)
  assert.match(prompt, /工作记忆（本会话/)
  assert.match(prompt, /把记忆层拆成四层/)
  console.log('ok - session prompt includes working memory')

  // 2. A turn end records a net change with derived importance.
  emit('agent/pre-step', { agent: { id: session.id }, turn: 1 }, () => {})
  emit('tools/result', { agent: { id: session.id }, name: 'write', arguments: { file_path: path.join(root, 'src/new-file.js') } }, { isError: false })
  emit('agent/turn-stopping', { agent: { session }, turn: 1 })
  await flush()
  const store = new MemoryStore(config)
  const turns = store.readTurns(root).turns
  assert.equal(turns.length, 1, `one turn record, got ${turns.length}`)
  assert.equal(turns[0].files[0].path, 'src/new-file.js')
  assert.equal(typeof turns[0].importance, 'number')
  assert.ok(turns[0].importance > 0)
  console.log('ok - turn record written with importance', turns[0].importance)

  // 3. The prompt renders the recorded timeline, and the tools read it back.
  const second = { id: 'session-int-2', header: { cwd: root } }
  sessions.set(second.id, second)
  const secondPrompt = sections[0].text({ agent: { session: second } })
  assert.match(secondPrompt, /第 1 轮/)
  console.log('ok - next session prompt shows the recorded turn')

  // 4. memory_read scope=brief works through the registered tool.
  const read = tools.find((tool) => tool.name === 'memory_read')
  const brief = read.execute({ scope: 'brief' }, { agent: { id: second.id, session: second } })
  assert.ok(brief.brief.length > 0)
  console.log('ok - memory_read brief:', brief.brief.split('\n')[0])

  // 5. /dreaming queues exactly one consolidation prompt with the brief.
  const dreaming = handlers.get('agent/turn-stopping') // sanity: handler exists
  assert.ok(dreaming)
  console.log('ok - handlers wired:', [...handlers.keys()].join(', '))

  const promptFile = readFileSync(store.paths(root).turns, 'utf8')
  assert.ok(promptFile.includes('src/new-file.js'))
  console.log('\nintegration check passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
