/**
 * The `/dreaming` consolidation command.
 *
 * A command handler cannot mutate the conversation itself, so the manual
 * trigger returns immediately and queues one ordinary next-turn prompt through
 * `agent.followup`. The model then uses the memory tools to promote stable
 * consensus into long-term memory and to forget what no longer applies.
 */

import path from 'node:path'

import { buildConsolidationBrief, renderConsolidationBrief } from './consolidate.js'
import { truncateUtf8 } from './format.js'
import { dreamingPrompt } from './templates.js'

/**
 * Build the consolidation prompt (exported for the smoke test).
 * @param {{ language: 'zh' | 'en', project: string, root: string, focus?: string, maxFocus: number, counts: { turns: number }, brief?: string }} input
 * @returns {string} prompt text
 */
export function buildDreamingPrompt(input) {
  return dreamingPrompt(input.language, input)
}

/**
 * Queue one consolidation turn for the invoking session.
 * @param {object} input
 * @param {object} input.agent live agent handle
 * @param {object} input.session owning session
 * @param {string} input.root canonical project directory
 * @param {import('./store.js').MemoryStore} input.store memory store
 * @param {import('./working.js').WorkingMemory} [input.workingStore] working-memory store
 * @param {object} input.config effective config
 * @param {Map<string, number>} input.inFlight project roots currently being consolidated
 * @param {string} [input.focus] optional free-text focus from the command line
 * @returns {{ kind: 'success', text: string } | { kind: 'error', text: string }} command result
 */
export function runDreaming({ agent, session, root, store, workingStore, config, inFlight, focus }) {
  const zh = config.language !== 'en'
  let live = 0
  let brief = ''
  try {
    store.ensure(root)
    const turns = store.readTurns(root).turns
    live = turns.length
    const workingState = workingStore ? workingStore.read(root, session?.id) : null
    const analysis = buildConsolidationBrief({
      turns,
      archiveTotal: store.countArchive(root),
      sections: store.readLongTermSections(root).sections,
      working: workingState,
      config,
    })
    brief = renderConsolidationBrief(analysis, config.language, config.consolidateBriefBytes, truncateUtf8)
  } catch (error) {
    return {
      kind: 'error',
      text: zh ? `无法读取项目记忆：${String(error?.message ?? error)}` : `Could not read project memory: ${String(error?.message ?? error)}`,
    }
  }
  if (live === 0) {
    return {
      kind: 'success',
      text: zh ? '短期记忆为空，暂无可整理内容。' : 'Short-term memory is empty; nothing to consolidate.',
    }
  }

  const now = Date.now()
  const blockedUntil = inFlight.get(root)
  if (blockedUntil && blockedUntil > now) {
    const seconds = Math.ceil((blockedUntil - now) / 1000)
    return {
      kind: 'error',
      text: zh
        ? `已有一次 /dreaming 整理在进行中（约 ${seconds} 秒后可再次触发）。`
        : `A /dreaming consolidation is already in progress (retry in about ${seconds}s).`,
    }
  }

  const followup = agent && typeof agent.followup === 'function' ? agent.followup.bind(agent) : null
  if (!followup) {
    return {
      kind: 'error',
      text: zh ? '当前会话无法追加回合，暂不能开始整理。' : 'This session cannot queue another turn, so consolidation cannot start.',
    }
  }

  const prompt = buildDreamingPrompt({
    language: config.language,
    project: path.basename(root),
    root,
    focus,
    maxFocus: config.dreamingFocusMaxChars,
    counts: { turns: live },
    brief,
  })

  try {
    followup({ content: [{ type: 'text', text: prompt }], source: { kind: 'project-memory' } })
  } catch (error) {
    return {
      kind: 'error',
      text: zh ? `无法排入整理回合：${String(error?.message ?? error)}` : `Could not queue the consolidation turn: ${String(error?.message ?? error)}`,
    }
  }

  inFlight.set(root, now + config.dreamingCooldownMs)
  void session
  return {
    kind: 'success',
    text: zh
      ? '已开始整理项目记忆（memory/）。模型会读取短期记忆、更新长期记忆并清理过时记录，完成后给出摘要。'
      : 'Consolidation started (memory/). The model will read short-term memory, update long-term memory, forget outdated rows, and report a summary.',
  }
}
