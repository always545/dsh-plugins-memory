/**
 * Dependency-free smoke test for the project-memory plugin.
 *
 * Run with: node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { DEFAULT_CONFIG, normalizeConfig } from '../lib/config.js'
import { deriveCurrentFiles, mergeTurnChanges, planRetention } from '../lib/derive.js'
import { buildDreamingPrompt, runDreaming } from '../lib/dreaming.js'
import { autoSummary, buildPromptBlock, buildReadText, mergeTurnNotes, parseTurns, recordLine, validateAnnotation } from '../lib/format.js'
import { isInsideMemoryDir, toProjectRelative } from '../lib/paths.js'
import { MemoryStore, applySectionEdit, sectionsOf } from '../lib/store.js'
import { descendantIds, TurnTracker } from '../lib/tracker.js'

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
    origin: 'snapshot',
    source: 'auto',
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
