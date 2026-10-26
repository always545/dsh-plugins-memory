/**
 * Dependency-free smoke test for the project-memory plugin.
 *
 * Run with: node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_CONFIG, normalizeConfig } from '../lib/config.js'
import { buildConsolidationBrief, jaccard, renderConsolidationBrief } from '../lib/consolidate.js'
import { deriveCurrentFiles, mergeTurnChanges, planRetention } from '../lib/derive.js'
import { buildDreamingPrompt, runDreaming } from '../lib/dreaming.js'
import {
  autoSummary,
  buildPromptBlock,
  buildReadText,
  buildSearchText,
  buildWorkingText,
  mergeTurnNotes,
  parseTurns,
  recallLine,
  recordLine,
  validateAnnotation,
  workingText,
} from '../lib/format.js'
import { isInsideMemoryDir, toProjectRelative } from '../lib/paths.js'
import { buildRecallIndex, focusText, recallForPrompt, reinforcedIds, searchMemory } from '../lib/recall.js'
import { decayFactor, deriveImportance, salience, storedImportance, TYPE_IMPORTANCE } from '../lib/salience.js'
import { buildIndex, makeDoc, search, snippetOf, tokenize } from '../lib/search.js'
import { longTermSections, MemoryStore, applySectionEdit, sectionsOf } from '../lib/store.js'
import { createTools } from '../lib/tools.js'
import { descendantIds, TurnTracker } from '../lib/tracker.js'
import { WorkingMemory, workingSessionKey } from '../lib/working.js'

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`FAIL - ${name}\n${error?.stack ?? error}`)
  }
}

const temporary = []
function project(files = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-project-memory-'))
  temporary.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return root
}

function config(overrides = {}) {
  return { ...normalizeConfig({}), ...overrides }
}

function turn(overrides) {
  return {
    v: 1,
    id: overrides.id ?? `t_${Math.random().toString(36).slice(2, 8)}`,
    turn: overrides.turn ?? 1,
    at: overrides.at ?? new Date().toISOString(),
    session: 'session-test',
    cwd: '/tmp/project',
    type: overrides.type ?? 'fix',
    summary: overrides.summary ?? 'changed things',
    ...(overrides.subject ? { subject: overrides.subject } : {}),
    ...(overrides.detail ? { detail: overrides.detail } : {}),
    files: overrides.files ?? [],
    ...(overrides.pinned === true ? { pinned: true } : {}),
    ...(Number.isFinite(overrides.importance) ? { importance: overrides.importance } : {}),
    ...(Number.isFinite(overrides.hits) ? { hits: overrides.hits } : {}),
    origin: 'snapshot',
    source: overrides.source ?? 'auto',
  }
}

try {
  test('normalizeConfig keeps documented defaults and repairs bad values', () => {
    const defaults = normalizeConfig()
    assert.equal(defaults.directoryName, DEFAULT_CONFIG.directoryName)
    assert.equal(defaults.language, 'zh')
    assert.deepEqual(defaults.recordToolNames, ['write', 'edit'])
    const repaired = normalizeConfig({
      directoryName: '../escape',
      language: 'fr',
      forgetMode: 'nuke',
      maxShortTermRecords: -3,
      recordToolNames: ['', 'edit', 'edit'],
      sectionOrder: Number.NaN,
    })
    assert.equal(repaired.directoryName, 'memory')
    assert.equal(repaired.language, 'zh')
    assert.equal(repaired.forgetMode, 'archive')
    assert.equal(repaired.maxShortTermRecords, DEFAULT_CONFIG.maxShortTermRecords)
    assert.deepEqual(repaired.recordToolNames, ['edit'])
    assert.equal(repaired.sectionOrder, DEFAULT_CONFIG.sectionOrder)
  })

  test('paths normalizes project-relative targets and rejects escapes', () => {
    const root = project({ 'src/a.py': 'a' })
    assert.equal(toProjectRelative('src/a.py', root, root), 'src/a.py')
    assert.equal(toProjectRelative(path.join(root, 'src/a.py'), root, root), 'src/a.py')
    assert.equal(toProjectRelative('../outside.py', root, root), null)
    assert.equal(toProjectRelative(root, root, root), null)
    assert.equal(isInsideMemoryDir('memory/long-term.md', 'memory'), true)
    assert.equal(isInsideMemoryDir('memoryish/a.md', 'memory'), false)
    assert.equal(isInsideMemoryDir('src/memory/a.md', 'memory'), false)
  })

  test('toProjectRelative tolerates another spelling of the project root', () => {
    const rawRoot = project({ 'src/a.py': 'a' })
    const canonicalRoot = realpathSync(rawRoot)
    assert.equal(toProjectRelative(path.join(rawRoot, 'src/a.py'), canonicalRoot, canonicalRoot), 'src/a.py')
    assert.equal(toProjectRelative(path.join(rawRoot, 'src/new-file.js'), canonicalRoot, canonicalRoot), 'src/new-file.js')
  })

  test('ensure creates the skeleton once and never overwrites user edits', () => {
    const root = project()
    const store = new MemoryStore(config())
    const first = store.ensure(root)
    assert.deepEqual(first.created.length, 3)
    assert.ok(existsSync(path.join(root, 'memory', 'long-term.md')))
    assert.ok(existsSync(path.join(root, 'memory', 'short-term.jsonl')))
    assert.ok(existsSync(path.join(root, 'memory', 'README.md')))
    writeFileSync(path.join(root, 'memory', 'long-term.md'), '# custom\n', 'utf8')
    const second = store.ensure(root)
    assert.deepEqual(second.created, [])
    assert.equal(readFileSync(path.join(root, 'memory', 'long-term.md'), 'utf8'), '# custom\n')
  })

  test('parseTurns tolerates malformed lines and foreign records', () => {
    const text = [
      JSON.stringify(turn({ id: 't_ok', files: [{ path: 'a.py' }] })),
      'not json',
      JSON.stringify({ v: 1, at: 'x', files: [] }),
      '',
      JSON.stringify({ v: 2, at: 'x', files: [] }),
    ].join('\n')
    const parsed = parseTurns(text)
    assert.equal(parsed.turns.length, 1)
    assert.equal(parsed.badLines, 3)
  })

  test('mergeTurnChanges turns several touches into one net change set', () => {
    const merged = mergeTurnChanges({
      snapshotFiles: [
        { path: 'src/a.py', added: 3, deleted: 1 },
        { path: 'memory/long-term.md', added: 9, deleted: 0 },
      ],
      trackedFiles: [{ path: 'src/a.py' }, { path: 'src/b.py' }],
      modelFiles: ['src/c.py', 'src/a.py', '../escape.py'],
      maxFiles: 50,
      directoryName: 'memory',
    })
    assert.deepEqual(
      merged.files.map((file) => file.path),
      ['src/a.py', 'src/b.py', 'src/c.py'],
    )
    assert.equal(merged.files[0].added, 3)
    assert.equal(merged.files[1].added, undefined)
  })

  test('a turn record lists a and b even when a was touched twice', () => {
    const root = project()
    const store = new MemoryStore(config())
    store.appendTurn(
      root,
      turn({
        id: 't_one',
        turn: 7,
        files: [
          { path: 'src/a.py', added: 4, deleted: 2 },
          { path: 'src/b.py', added: 1, deleted: 0 },
        ],
      }),
    )
    const read = store.readTurns(root)
    assert.equal(read.turns.length, 1)
    assert.deepEqual(
      read.turns[0].files.map((file) => file.path),
      ['src/a.py', 'src/b.py'],
    )
  })

  test('deriveCurrentFiles keeps both files of one turn and later updates only one', () => {
    const turns = [
      turn({ id: 't1', turn: 1, at: '2026-10-25T10:00:00.000Z', files: [{ path: 'a.py', added: 1 }, { path: 'b.py', added: 2 }] }),
      turn({ id: 't2', turn: 2, at: '2026-10-25T11:00:00.000Z', files: [{ path: 'a.py', added: 5 }] }),
    ]
    const current = deriveCurrentFiles(turns, 10)
    assert.deepEqual(
      current.map((file) => [file.path, file.turn]),
      [
        ['a.py', 2],
        ['b.py', 1],
      ],
    )
  })

  test('planRetention keeps current providers, recent records, and enforces caps', () => {
    const now = Date.parse('2026-10-26T00:00:00.000Z')
    const old = '2026-01-01T00:00:00.000Z'
    const recent = '2026-10-25T23:30:00.000Z'
    const turns = [
      turn({ id: 'old-a', at: old, files: [{ path: 'a.py' }] }),
      turn({ id: 'old-b', at: old, files: [{ path: 'b.py' }] }),
      turn({ id: 'recent-c', at: recent, files: [{ path: 'c.py' }] }),
      turn({ id: 'recent-d', at: recent, files: [{ path: 'd.py' }] }),
    ]
    const retention = planRetention(turns, { now, config: config({ maxShortTermRecords: 3 }) })
    const kept = retention.kept.map((record) => record.id)
    // The two January records exceed maxAgeDays even though they are current providers.
    assert.deepEqual(kept, ['recent-c', 'recent-d'])
    assert.ok(retention.forgotten.some((record) => record.id === 'old-a'))

    const expired = planRetention([turn({ id: 'expired', at: '2026-01-01T00:00:00.000Z', files: [{ path: 'x' }] })], {
      now,
      config: config(),
    })
    assert.equal(expired.kept.length, 0)
    assert.equal(expired.forgotten.length, 1)

    const capped = planRetention(
      [
        turn({ id: 'c1', at: '2026-10-25T20:00:00.000Z', files: [{ path: '1' }] }),
        turn({ id: 'c2', at: '2026-10-25T21:00:00.000Z', files: [{ path: '2' }] }),
        turn({ id: 'c3', at: '2026-10-25T22:00:00.000Z', files: [{ path: '3' }] }),
      ],
      { now, config: config({ maxShortTermRecords: 2 }) },
    )
    assert.deepEqual(capped.kept.map((record) => record.id), ['c2', 'c3'])
    assert.deepEqual(capped.forgotten.map((record) => record.id), ['c1'])
  })

  test('compact archives forgotten records and keeps the live window bounded', () => {
    const root = project()
    const store = new MemoryStore(config({ maxShortTermRecords: 2, recentRetentionHours: 1, maxAgeDays: 3650 }))
    store.ensure(root)
    const now = Date.parse('2026-10-26T00:00:00.000Z')
    const old = '2026-10-20T00:00:00.000Z'
    writeFileSync(
      store.paths(root).turns,
      [
        turn({ id: 't-old-1', at: old, files: [{ path: 'a.py' }] }),
        turn({ id: 't-old-2', at: old, files: [{ path: 'b.py' }] }),
        turn({ id: 't-new', at: '2026-10-25T23:59:00.000Z', files: [{ path: 'c.py' }] }),
      ]
        .map(recordLine)
        .join(''),
      'utf8',
    )
    const result = store.compact(root, now)
    assert.equal(result.kept, 2)
    assert.equal(result.forgotten, 1)
    assert.equal(store.countArchive(root), 1)
    const live = parseTurns(readFileSync(store.paths(root).turns, 'utf8')).turns.map((record) => record.id)
    assert.deepEqual(live, ['t-old-2', 't-new'])
  })

  test('drop mode deletes forgotten records instead of archiving them', () => {
    const root = project()
    const store = new MemoryStore(config({ forgetMode: 'drop', maxShortTermRecords: 1, recentRetentionHours: 1 }))
    store.ensure(root)
    const now = Date.parse('2026-10-26T00:00:00.000Z')
    writeFileSync(
      store.paths(root).turns,
      [turn({ id: 't1', at: '2026-10-20T00:00:00.000Z', files: [{ path: 'a' }] }), turn({ id: 't2', at: '2026-10-25T23:59:00.000Z', files: [{ path: 'b' }] })]
        .map(recordLine)
        .join(''),
      'utf8',
    )
    store.compact(root, now)
    assert.equal(store.countArchive(root), 0)
  })

  test('forget and long-term edits work on disk', () => {
    const root = project()
    const store = new MemoryStore(config())
    store.appendTurn(root, turn({ id: 't1', files: [{ path: 'a.py' }], subject: 'config a' }))
    store.appendTurn(root, turn({ id: 't2', files: [{ path: 'b.py' }] }))
    assert.equal(store.forget(root, (record) => record.subject === 'config a'), 1)
    assert.equal(store.readTurns(root).turns.length, 1)

    const updated = store.updateLongTerm(root, { section: '技术栈', content: 'Python 3.12，Windows 与 macOS' })
    assert.ok(updated.sections.includes('技术栈'))
    assert.match(readFileSync(store.paths(root).longTerm, 'utf8'), /Python 3\.12/)
    store.updateLongTerm(root, { section: '技术栈', mode: 'replace_section', content: 'Python 3.13' })
    const text = readFileSync(store.paths(root).longTerm, 'utf8')
    assert.match(text, /Python 3\.13/)
    assert.doesNotMatch(text, /Python 3\.12/)
    const fallback = store.updateLongTerm(root, { content: '补充：离线也可运行' })
    assert.ok(fallback.sections.includes('补充记录'))
    assert.throws(() => store.updateLongTerm(root, { section: '不存在的章节', content: 'x' }), /没有章节/)
  })

  test('long-term writes respect the configured size cap', () => {
    const root = project()
    const store = new MemoryStore(config({ maxLongTermBytes: 600 }))
    assert.throws(() => store.updateLongTerm(root, { section: '技术栈', content: 'x'.repeat(2000) }), /上限/)
  })

  test('applySectionEdit keeps neighbouring sections intact', () => {
    const text = '# T\n\n## A\n\na\n\n## B\n\nb\n'
    const appended = applySectionEdit(text, { section: 'A', mode: 'append', content: 'new', language: 'en' })
    assert.match(appended, /## A\n\na\n\n- new\n\n## B\n\nb/)
    assert.deepEqual(sectionsOf(appended), ['A', 'B'])
  })

  test('validateAnnotation normalizes fields and rejects escapes', () => {
    const root = project()
    const annotation = validateAnnotation(
      { summary: '  fixed\n a bug ', type: 'fix', files: ['src/a.py', 'memory/long-term.md'] },
      { config: config(), root, cwd: root },
    )
    assert.equal(annotation.summary, 'fixed a bug')
    assert.deepEqual(annotation.files, ['src/a.py'])
    assert.throws(() => validateAnnotation({ summary: 'x', files: ['../x'] }, { config: config(), root, cwd: root }), /outside the project/)
    assert.throws(() => validateAnnotation({}, { config: config(), root, cwd: root }), /summary is required/)
  })

  test('autoSummary names several files and counts', () => {
    const summary = autoSummary([{ path: 'a.py', added: 3, deleted: 1 }, { path: 'b.py', added: 12, deleted: 0 }], 'zh')
    assert.match(summary, /2 个文件/)
    assert.match(summary, /a\.py\(\+3\/-1\)/)
  })

  test('mergeTurnNotes folds subagent notes into the parent record', () => {
    const parent = mergeTurnNotes({
      annotation: { summary: 'parent work', type: 'fix', detail: 'why it changed' },
      childNotes: [{ sessionId: 'session-abcdef123456', summary: 'child work', type: 'docs' }],
      files: [{ path: 'a.py' }],
      language: 'zh',
    })
    assert.equal(parent.summary, 'parent work')
    assert.equal(parent.type, 'fix')
    assert.equal(parent.source, 'agent')
    assert.match(parent.detail, /why it changed/)
    assert.match(parent.detail, /子代理 abcdef12：child work/)

    const onlyChild = mergeTurnNotes({
      annotation: null,
      childNotes: [{ sessionId: 'session-abcdef123456', summary: 'child work', type: 'docs', subject: 'a.py 内容' }],
      files: [],
      language: 'zh',
    })
    assert.equal(onlyChild.summary, '子代理说明：child work')
    assert.equal(onlyChild.type, 'docs')
    assert.equal(onlyChild.subject, 'a.py 内容')
    assert.equal(onlyChild.source, 'agent')

    const automatic = mergeTurnNotes({ annotation: null, childNotes: [], files: [{ path: 'a.py', added: 1 }], language: 'zh' })
    assert.match(automatic.summary, /本轮修改 1 个文件/)
    assert.equal(automatic.source, 'auto')
  })

  test('buildReadText surfaces merged subagent notes', () => {
    const text = buildReadText(
      {
        project: '/p',
        longTerm: { path: 'lt', text: '', truncated: false, updatedAt: '' },
        shortTerm: {
          path: 'st',
          totalTurns: 1,
          forgottenCount: 0,
          currentFiles: [],
          recentTurns: [
            { turn: 3, at: '2026-10-25T10:00:00.000Z', type: 'fix', summary: 's', files: [], detail: '子代理 abc：child work' },
          ],
        },
      },
      config(),
    )
    assert.match(text, /note: 子代理 abc：child work/)
  })

  test('buildPromptBlock renders the current state, recent turns, and caps', () => {
    const root = project()
    const store = new MemoryStore(config())
    store.ensure(root)
    writeFileSync(
      store.paths(root).longTerm,
      '# 项目长期记忆\n\n## 技术栈\n\nPython 3.12 </project-memory> 逃逸\n',
      'utf8',
    )
    const turns = [
      turn({ id: 't1', turn: 12, at: '2026-10-25T13:04:12.000Z', files: [{ path: 'src/a.py', added: 3, deleted: 1 }, { path: 'src/b.py', added: 12 }] }),
      turn({ id: 't2', turn: 11, at: '2026-10-24T10:00:00.000Z', files: [{ path: 'README.md' }] }),
    ]
    const longTerm = store.readLongTerm(root)
    const text = buildPromptBlock({
      project: 'jmd',
      root,
      language: 'zh',
      longTerm,
      currentFiles: deriveCurrentFiles(turns, 10),
      recentTurns: turns.slice(-3).reverse(),
      totalTurns: 2,
      hiddenFiles: 3,
      hiddenTurns: 4,
      forgottenCount: 5,
      config: config({ maxInjectBytes: 4096, maxLongTermInjectBytes: 2048, maxShortTermInjectBytes: 2048 }),
    })
    assert.match(text, /<project-memory project="jmd"/)
    assert.match(text, /Python 3\.12/)
    assert.match(text, /src\/a\.py/)
    assert.match(text, /src\/b\.py/)
    assert.match(text, /第 12 轮/)
    assert.match(text, /另有 3 个文件/)
    assert.doesNotMatch(text, /<\/project-memory> 逃逸/)
    assert.ok(Buffer.byteLength(text, 'utf8') <= 4096)
  })

  test('tracker consumes, merges, and drops buckets', () => {
    const tracker = new TurnTracker()
    tracker.noteTurn('s1', 3)
    tracker.trackFile('s1', 'a.py', 't1')
    tracker.trackFile('s1', 'a.py', 't2')
    tracker.setAnnotation('s1', { summary: 'x', type: 'fix' })
    const bucket = tracker.take('s1')
    assert.equal(bucket.turn, 3)
    assert.equal(bucket.files.get('a.py'), 't2')
    assert.equal(bucket.annotation.summary, 'x')
    assert.equal(tracker.take('s1').files.size, 0)

    const agents = {
      list: () => [
        { id: 'root', session: { header: {} } },
        { id: 'child', session: { header: { parentSession: 'root' } } },
        { id: 'grandchild', session: { header: { parentSession: 'child' } } },
        { id: 'other', session: { header: { parentSession: 'elsewhere' } } },
      ],
    }
    assert.deepEqual(descendantIds(agents, 'root').sort(), ['child', 'grandchild'])
  })

  test('buildDreamingPrompt states the workflow and truncates focus', () => {
    const prompt = buildDreamingPrompt({
      language: 'zh',
      project: 'jmd',
      root: '/tmp/jmd',
      focus: 'x'.repeat(500),
      maxFocus: 20,
      counts: { turns: 3 },
    })
    assert.match(prompt, /memory_read/)
    assert.match(prompt, /memory_update_long_term/)
    assert.match(prompt, /memory_forget/)
    assert.match(prompt, /jmd/)
    assert.ok(prompt.length < 2000)
  })

  test('runDreaming queues exactly one consolidation turn and guards re-entry', () => {
    const root = project()
    const store = new MemoryStore(config())
    store.appendTurn(root, turn({ id: 't1', files: [{ path: 'a.py' }], at: new Date().toISOString() }))
    const inFlight = new Map()
    const calls = []
    const agent = { followup: (message) => calls.push(message) }
    const first = runDreaming({ agent, session: {}, root, store, config: config(), inFlight, focus: '' })
    assert.equal(first.kind, 'success')
    assert.equal(calls.length, 1)
    assert.match(calls[0].content[0].text, /memory_read/)
    assert.equal(calls[0].source.kind, 'project-memory')
    const second = runDreaming({ agent, session: {}, root, store, config: config(), inFlight, focus: '' })
    assert.equal(second.kind, 'error')
    assert.equal(calls.length, 1)

    inFlight.clear()
    const throwing = { followup: () => { throw new Error('nope') } }
    const failed = runDreaming({ agent: throwing, session: {}, root, store, config: config(), inFlight, focus: '' })
    assert.equal(failed.kind, 'error')
  })

  test('runDreaming refuses an empty window without queuing a turn', () => {
    const root = project()
    const store = new MemoryStore(config())
    const calls = []
    const result = runDreaming({
      agent: { followup: (message) => calls.push(message) },
      session: {},
      root,
      store,
      config: config(),
      inFlight: new Map(),
    })
    assert.equal(result.kind, 'success')
    assert.equal(calls.length, 0)
  })

  test('memory directory writes never appear in a change set', () => {
    const merged = mergeTurnChanges({
      snapshotFiles: [{ path: 'memory/short-term.jsonl', added: 1, deleted: 0 }],
      trackedFiles: [{ path: 'memory/long-term.md' }],
      modelFiles: [],
      maxFiles: 50,
      directoryName: 'memory',
    })
    assert.deepEqual(merged.files, [])
  })

  test('longTerm skeleton has the documented sections', () => {
    const store = new MemoryStore(config())
    const root = project()
    store.ensure(root)
    const sections = sectionsOf(readFileSync(store.paths(root).longTerm, 'utf8'))
    assert.deepEqual(sections, ['项目概述', '技术栈', '目录结构与模块', '构建、运行与验证', '编码与协作约定', '重要决策'])
  })

  // ---------------------------------------------------------------------------
  // Layered memory: configuration knobs.
  // ---------------------------------------------------------------------------
  test('normalizeConfig repairs the layered-memory knobs', () => {
    const defaults = normalizeConfig({})
    assert.equal(defaults.promptRefresh, 'session')
    assert.equal(defaults.enableWorkingMemory, true)
    assert.equal(defaults.injectRelevantTurns, DEFAULT_CONFIG.injectRelevantTurns)
    assert.equal(defaults.importanceHalfLifeDays, DEFAULT_CONFIG.importanceHalfLifeDays)
    const repaired = normalizeConfig({
      promptRefresh: 'always',
      importanceHalfLifeDays: 0,
      workingMemoryMaxBytes: 10,
      archiveSearchLimit: -5,
      searchMaxResults: 999,
    })
    assert.equal(repaired.promptRefresh, 'session')
    assert.equal(repaired.importanceHalfLifeDays, DEFAULT_CONFIG.importanceHalfLifeDays)
    assert.equal(repaired.workingMemoryMaxBytes, DEFAULT_CONFIG.workingMemoryMaxBytes)
    assert.equal(repaired.archiveSearchLimit, DEFAULT_CONFIG.archiveSearchLimit)
    assert.equal(repaired.searchMaxResults, DEFAULT_CONFIG.searchMaxResults)
  })

  // ---------------------------------------------------------------------------
  // Retrieval: tokenization, BM25, snippets.
  // ---------------------------------------------------------------------------
  test('tokenize splits CJK into bigrams and drops stopwords', () => {
    const terms = tokenize('修复 登录 Cookie 处理 the and')
    assert.ok(terms.includes('修复'))
    assert.ok(terms.includes('登录'))
    assert.ok(terms.includes('处理'))
    assert.ok(terms.includes('cookie'))
    assert.ok(!terms.includes('the'))
    assert.ok(!terms.includes('and'))
    assert.deepEqual(tokenize(''), [])
  })

  test('BM25 ranks the relevant record first for CJK queries', () => {
    const docs = [
      makeDoc({ id: 'a', kind: 'turn', title: '数据库迁移脚本', body: '修复迁移回滚失败', at: '2026-10-25T10:00:00.000Z', importance: 0.7 }),
      makeDoc({ id: 'b', kind: 'turn', title: '调整按钮颜色', body: 'CSS 变量替换', at: '2026-10-25T11:00:00.000Z', importance: 0.4 }),
    ]
    const index = buildIndex(docs)
    const hits = search(index, '迁移 回滚', { limit: 5, now: Date.parse('2026-10-26T00:00:00.000Z') })
    assert.equal(hits[0].doc.id, 'a')
    assert.equal(hits.some((hit) => hit.doc.id === 'b'), false)
  })

  test('snippetOf cuts around the matched term and stays bounded', () => {
    const text = `${'长'.repeat(200)}迁移失败${'尾'.repeat(200)}`
    const snippet = snippetOf(text, ['迁移'], 60)
    assert.ok(snippet.includes('迁移'))
    assert.ok(Array.from(snippet).length <= 62)
  })

  // ---------------------------------------------------------------------------
  // Salience: importance, decay, reinforcement, retention.
  // ---------------------------------------------------------------------------
  test('salience combines importance, decay, and retrieval reinforcement', () => {
    const cfg = config()
    const now = Date.parse('2026-10-26T00:00:00.000Z')
    const featured = turn({ type: 'feature', files: [{ path: 'a' }], source: 'agent', at: '2026-10-25T23:00:00.000Z' })
    assert.ok(deriveImportance(featured) > deriveImportance(turn({ type: 'chore', at: featured.at })))
    assert.ok(TYPE_IMPORTANCE.feature > TYPE_IMPORTANCE.chore)
    const old = turn({ at: '2026-09-26T00:00:00.000Z', files: [{ path: 'a' }] })
    const decayed = decayFactor(old, { now, config: cfg })
    assert.ok(decayed < 0.5)
    assert.ok(decayFactor({ ...old, hits: 10 }, { now, config: cfg }) > decayed)
    assert.equal(storedImportance({ ...old, importance: 2 }), 1)
    assert.ok(salience({ ...old, importance: 1, hits: 10 }, { now, config: cfg }) > salience(old, { now, config: cfg }))
  })

  test('retention keeps pinned records and stretches the window by importance', () => {
    const now = Date.parse('2026-10-26T00:00:00.000Z')
    const cfg = config()
    const aged = '2026-01-01T00:00:00.000Z'
    const pinnedPlan = planRetention([turn({ id: 'pin', at: aged, pinned: true, files: [{ path: 'a' }] })], { now, config: cfg })
    assert.deepEqual(pinnedPlan.kept.map((record) => record.id), ['pin'])
    const unpinnedPlan = planRetention([turn({ id: 'drop', at: aged, files: [{ path: 'a' }] })], { now, config: cfg })
    assert.equal(unpinnedPlan.kept.length, 0)

    const windowOf = (id, importance) =>
      planRetention(
        [
          turn({ id, at: new Date(now - 30 * 3600_000).toISOString(), importance, files: [{ path: 'x' }] }),
          turn({ id: 'newer', at: new Date(now - 3600_000).toISOString(), files: [{ path: 'x' }] }),
        ],
        { now, config: cfg },
      )
    assert.deepEqual(windowOf('important', 1).kept.map((record) => record.id), ['important', 'newer'])
    assert.deepEqual(windowOf('dull', 0).forgotten.map((record) => record.id), ['dull'])
  })

  test('planRetention enforces the pinned budget last', () => {
    const now = Date.parse('2026-10-26T00:00:00.000Z')
    const aged = '2026-01-01T00:00:00.000Z'
    const plan = planRetention(
      [
        turn({ id: 'p1', at: aged, pinned: true, files: [{ path: 'a' }] }),
        turn({ id: 'p2', at: aged, pinned: true, files: [{ path: 'b' }] }),
      ],
      { now, config: config({ maxPinnedRecords: 1, maxShortTermRecords: 1 }) },
    )
    assert.equal(plan.kept.length, 1)
  })

  // ---------------------------------------------------------------------------
  // Working memory.
  // ---------------------------------------------------------------------------
  test('working memory merges updates, expires by TTL, and prunes', () => {
    const root = project()
    const cfg = normalizeConfig({ workingMemoryMaxSessions: 2 })
    const working = new WorkingMemory(cfg)
    const now = Date.parse('2026-10-26T00:00:00.000Z')
    const first = working.write(root, 'session/a:b', { task: '重构记忆层', next: ['写检索', '写测试'] }, now)
    assert.match(first.path, /session_a_b\.json$/)
    assert.equal(workingSessionKey('a/b:c'), 'a_b_c')
    assert.equal(working.read(root, 'session/a:b', now).task, '重构记忆层')
    working.write(root, 'session/a:b', { next: ['写检索', '补文档'], notes: ['临时想法'] }, now + 1000)
    const merged = working.read(root, 'session/a:b', now + 1000)
    assert.deepEqual(merged.next, ['写检索', '写测试', '补文档'])
    assert.deepEqual(merged.notes, ['临时想法'])
    working.write(root, 'session/a:b', { next: ['只保留这个'], replaceArrays: true }, now + 2000)
    assert.deepEqual(working.read(root, 'session/a:b', now + 2000).next, ['只保留这个'])
    assert.equal(working.read(root, 'session/a:b', now + 2000 + 73 * 3600_000), null)

    const fresh = now + 3000
    working.write(root, 's1', { task: 'one' }, fresh)
    working.write(root, 's2', { task: 'two' }, fresh + 1)
    working.write(root, 's3', { task: 'three' }, fresh + 2)
    assert.equal(working.prune(root, fresh + 10).removed, 2)

    const tiny = new WorkingMemory(normalizeConfig({ workingMemoryMaxBytes: 512 }))
    const squeezed = tiny.write(project(), 'big', { task: 'x'.repeat(300), next: ['y'.repeat(200), 'z'.repeat(200)], notes: ['n'.repeat(200)] }, now)
    assert.ok(Buffer.byteLength(JSON.stringify(squeezed.state), 'utf8') <= 512)
  })

  // ---------------------------------------------------------------------------
  // Store: sections, pin patches, reinforcement, signatures.
  // ---------------------------------------------------------------------------
  test('store exposes sections, pin patches, reinforcement, and a signature', () => {
    const root = project()
    const store = new MemoryStore(config())
    store.ensure(root)
    const names = longTermSections(readFileSync(store.paths(root).longTerm, 'utf8')).map((section) => section.name)
    assert.deepEqual(names, ['项目概述', '技术栈', '目录结构与模块', '构建、运行与验证', '编码与协作约定', '重要决策'])
    assert.deepEqual(store.readLongTermSections(root).sections.map((section) => section.name), names)
    const before = store.signature(root)
    store.appendTurn(root, turn({ id: 't1', files: [{ path: 'a.py' }] }))
    assert.notEqual(store.signature(root), before)
    assert.equal(store.updateTurns(root, (record) => record.id === 't1', { pinned: true }).updated, 1)
    assert.equal(store.readTurns(root).turns[0].pinned, true)
    const now = Date.now()
    assert.equal(store.touchTurns(root, ['t1'], now), 1)
    assert.equal(store.readTurns(root).turns[0].hits, 1)
    assert.equal(store.touchTurns(root, ['t1'], now + 1000), 0)
    assert.equal(store.touchTurns(root, ['t1'], now + 7200_000, 0), 1)
    assert.equal(store.readTurns(root).turns[0].hits, 2)
  })

  // ---------------------------------------------------------------------------
  // Recall: focus, relevance ranking, archive search.
  // ---------------------------------------------------------------------------
  test('recall ranks against the working focus and searches archived turns', () => {
    const root = project()
    const cfg = config()
    const store = new MemoryStore(cfg)
    store.ensure(root)
    const now = Date.parse('2026-10-26T00:00:00.000Z')
    store.appendTurn(root, turn({ id: 't-db', turn: 8, at: '2026-10-24T10:00:00.000Z', summary: '数据库迁移脚本回滚失败', files: [{ path: 'db/migrate.py' }] }))
    store.appendTurn(root, turn({ id: 't-ui', turn: 9, at: '2026-10-25T10:00:00.000Z', summary: '调整按钮颜色与 CSS 变量', files: [{ path: 'web/theme.css' }] }))
    const working = new WorkingMemory(cfg)
    working.write(root, 'session-test', { task: '修复数据库迁移回滚' }, now)
    const state = working.read(root, 'session-test', now)
    assert.equal(focusText(state), '修复数据库迁移回滚')
    const index = buildRecallIndex({ turns: store.readTurns(root).turns, archive: [], sections: [], working: state, config: cfg })
    const recall = recallForPrompt({ index, focus: focusText(state), excludeIds: new Set(), limit: 3, now, config: cfg })
    assert.equal(recall[0].recordId, 't-db')
    const excluded = recallForPrompt({ index, focus: focusText(state), excludeIds: new Set(['t-db']), limit: 3, now, config: cfg })
    assert.equal(excluded.every((item) => item.recordId !== 't-db'), true)

    store.forget(root, (record) => record.id === 't-db')
    const archived = searchMemory({
      turns: store.readTurns(root).turns,
      archive: store.readArchive(root, 10).entries,
      sections: [],
      query: '数据库 回滚',
      limit: 5,
      now,
      config: cfg,
    })
    assert.equal(archived.items[0].kind, 'archive')
    assert.equal(archived.items[0].recordId, 't-db')
    assert.deepEqual([...reinforcedIds(archived.items)], ['t-db'])
  })

  // ---------------------------------------------------------------------------
  // Prompt assembly with the new layers.
  // ---------------------------------------------------------------------------
  test('buildPromptBlock places working memory and recall around long-term memory', () => {
    const root = project()
    const store = new MemoryStore(config())
    store.ensure(root)
    writeFileSync(store.paths(root).longTerm, '# 项目长期记忆\n\n## 技术栈\n\nPython 3.12\n', 'utf8')
    const text = buildPromptBlock({
      project: 'jmd',
      root,
      language: 'zh',
      longTerm: store.readLongTerm(root),
      currentFiles: [],
      recentTurns: [turn({ id: 't9', turn: 9, summary: '最近改动', files: [] })],
      totalTurns: 9,
      hiddenFiles: 0,
      hiddenTurns: 5,
      forgottenCount: 1,
      working: { task: '重构记忆层', next: ['写检索'], questions: [], notes: [], updatedAt: new Date().toISOString() },
      recall: [{ kind: 'turn', turn: 3, at: '2026-10-20T10:00:00.000Z', type: 'fix', summary: '数据库迁移回滚', snippet: '回滚失败已修复' }],
      config: config({ maxInjectBytes: 4096 }),
    })
    assert.match(text, /工作记忆（本会话/)
    assert.match(text, /重构记忆层/)
    assert.match(text, /相关召回/)
    assert.match(text, /数据库迁移回滚/)
    assert.ok(text.indexOf('工作记忆') < text.indexOf('长期记忆'))
    assert.ok(text.indexOf('长期记忆') < text.indexOf('相关召回'))
    assert.ok(text.indexOf('相关召回') < text.indexOf('短期记忆 · 按文件'))
    assert.ok(Buffer.byteLength(text, 'utf8') <= 4096)
  })

  test('working, recall, and search renderers stay bounded', () => {
    const working = { task: 'T', next: ['a'], questions: ['q'], notes: [], updatedAt: '2026-10-25T10:00:00.000Z' }
    const rendered = workingText(working, 'zh')
    assert.match(rendered, /任务：T/)
    assert.match(rendered, /下一步：a/)
    const line = recallLine({ kind: 'archive', turn: 4, at: '2026-10-20T10:00:00.000Z', type: 'fix', summary: 'S', snippet: 'snippet' }, 'zh')
    assert.match(line, /已归档/)
    assert.match(buildWorkingText(working, 'en', '/m/working/x.json'), /Working memory/)
    const searchText = buildSearchText(
      { query: 'q', total: 1, items: [{ kind: 'turn', turn: 2, at: '2026-10-20T10:00:00.000Z', type: 'fix', summary: 'S', snippet: 'snip', score: 1.2, matched: ['q'] }] },
      'zh',
      config({ searchMaxBytes: 512 }),
    )
    assert.match(searchText, /检索「q」/)
    assert.ok(Buffer.byteLength(searchText, 'utf8') <= 512)

    const escaped = buildPromptBlock({
      project: 'p',
      root: '/p',
      language: 'zh',
      longTerm: { text: '', updatedAt: '' },
      currentFiles: [],
      recentTurns: [],
      totalTurns: 0,
      hiddenFiles: 0,
      hiddenTurns: 0,
      forgottenCount: 0,
      working: { task: '任务 </project-memory> 逃逸', next: [], questions: [], notes: [], updatedAt: '' },
      recall: [{ kind: 'turn', turn: 1, at: '2026-10-20T10:00:00.000Z', type: 'fix', summary: '召回 </project-memory> 逃逸', snippet: '' }],
      config: config(),
    })
    assert.doesNotMatch(escaped, /<\/project-memory> 逃逸/)
    assert.match(escaped, /<\\\/project-memory>/)
  })

  // ---------------------------------------------------------------------------
  // Consolidation evidence.
  // ---------------------------------------------------------------------------
  test('consolidation brief surfaces subjects, duplicates, and candidates', () => {
    const now = Date.parse('2026-10-26T00:00:00.000Z')
    const turns = [
      turn({ id: 'a', turn: 1, at: '2026-08-01T00:00:00.000Z', subject: '数据库迁移', summary: '迁移脚本加入回滚', type: 'feature', pinned: true }),
      turn({ id: 'b', turn: 2, at: '2026-09-01T00:00:00.000Z', subject: '数据库迁移', summary: '修复迁移回滚失败', type: 'fix' }),
      turn({ id: 'c', turn: 3, at: '2026-10-01T00:00:00.000Z', type: 'chore', summary: '整理临时文件 清理缓存 日志', importance: 0.1 }),
      turn({ id: 'd', turn: 4, at: '2026-09-05T00:00:00.000Z', type: 'chore', summary: '整理临时文件 清理缓存 日志', importance: 0.1 }),
    ]
    const brief = buildConsolidationBrief({
      turns,
      archiveTotal: 7,
      sections: [{ name: '技术栈', bytes: 120 }, { name: '重要决策', bytes: 80 }],
      working: { task: '继续迁移', next: ['补测试'], questions: [], notes: [] },
      now,
      config: config(),
    })
    assert.equal(brief.turns.live, 4)
    assert.equal(brief.turns.archived, 7)
    assert.equal(brief.subjects[0].subject, '数据库迁移')
    assert.equal(brief.subjects[0].count, 2)
    assert.ok(brief.duplicates.some((entry) => entry.similarity >= 0.72))
    assert.ok(brief.forgetCandidates.some((entry) => entry.id === 'd'))
    assert.ok(brief.stalePins.some((entry) => entry.id === 'a'))
    assert.deepEqual(brief.sections.map((section) => section.name), ['技术栈', '重要决策'])
    assert.equal(jaccard(new Set(tokenize('迁移回滚失败')), new Set(tokenize('迁移回滚失败'))), 1)
    const rendered = renderConsolidationBrief(brief, 'zh', 1024, (value, max) => (value.length > max ? value.slice(0, max) : value))
    assert.match(rendered, /数据库迁移/)
    assert.match(rendered, /固定/)
  })

  // ---------------------------------------------------------------------------
  // Tools: search, working memory, pin.
  // ---------------------------------------------------------------------------
  test('memory tools search, reinforce, manage working memory, and pin', () => {
    const root = project()
    const cfg = config()
    const store = new MemoryStore(cfg)
    store.ensure(root)
    store.appendTurn(root, turn({ id: 't-db', turn: 5, at: new Date().toISOString(), summary: '数据库迁移回滚失败', files: [{ path: 'db/migrate.py' }] }))
    const working = new WorkingMemory(cfg)
    const session = { id: 'session-test', header: { cwd: root } }
    const ctx = {
      sessions: { get: (id) => (id === 'session-test' ? session : null) },
      get: (name) => (name === 'workingDirectory' ? { get: () => root } : undefined),
    }
    const tools = createTools({ ctx, store, working, tracker: new TurnTracker(), config: cfg })
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    assert.deepEqual([...byName.keys()].sort(), [
      'memory_forget',
      'memory_pin',
      'memory_read',
      'memory_record',
      'memory_search',
      'memory_update_long_term',
      'memory_work',
    ])
    const execution = { agent: { id: 'session-test', session } }

    const searched = byName.get('memory_search').execute({ query: '数据库 回滚' }, execution)
    assert.equal(searched.items[0].recordId, 't-db')
    assert.equal(searched.items[0].turn, 5)
    assert.equal(store.readTurns(root).turns[0].hits, 1)

    const workTool = byName.get('memory_work')
    const updated = workTool.execute({ op: 'update', task: '修复迁移', next: ['补测试'] }, execution)
    assert.equal(updated.state.task, '修复迁移')
    assert.deepEqual(updated.state.next, ['补测试'])
    assert.equal(workTool.execute({ op: 'read' }, execution).state.exists, true)
    assert.equal(workTool.execute({ op: 'clear' }, execution).state.exists, false)

    const pinTool = byName.get('memory_pin')
    const pinned = pinTool.execute({ ids: ['t-db'] }, execution)
    assert.equal(pinned.updated, 1)
    assert.equal(pinned.totalPinned, 1)
    assert.equal(pinTool.execute({ ids: ['t-db'], pinned: false }, execution).totalPinned, 0)

    const read = byName.get('memory_read')
    assert.ok(read.execute({ scope: 'brief' }, execution).brief.length > 0)
    assert.equal(read.execute({ scope: 'working' }, execution).working.exists, false)
  })

  // ---------------------------------------------------------------------------
  // Dreaming carries the evidence brief.
  // ---------------------------------------------------------------------------
  test('dreaming prompt carries the consolidation brief and the new tools', () => {
    const root = project()
    const cfg = config()
    const store = new MemoryStore(cfg)
    store.appendTurn(root, turn({ id: 't1', turn: 1, subject: '数据库迁移', summary: '迁移脚本加入回滚', files: [{ path: 'db/migrate.py' }] }))
    store.appendTurn(root, turn({ id: 't2', turn: 2, subject: '数据库迁移', summary: '修复迁移回滚失败', files: [{ path: 'db/migrate.py' }] }))
    const calls = []
    const result = runDreaming({
      agent: { followup: (message) => calls.push(message) },
      session: { id: 'session-test' },
      root,
      store,
      workingStore: new WorkingMemory(cfg),
      config: cfg,
      inFlight: new Map(),
    })
    assert.equal(result.kind, 'success')
    assert.equal(calls.length, 1)
    const prompt = calls[0].content[0].text
    assert.match(prompt, /数据库迁移 ×2/)
    assert.match(prompt, /memory_pin/)
    assert.match(prompt, /memory_search/)
  })
} finally {
  for (const root of temporary) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup.
    }
  }
}

if (failures.length) {
  console.error(`\n${failures.length} test(s) failed, ${passed} passed.`)
  process.exitCode = 1
} else {
  console.log(`\nAll ${passed} smoke tests passed.`)
}
