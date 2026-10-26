/**
 * Human- and model-facing text templates for project-memory.
 *
 * Memory content is generated once (skeleton files) or per consolidation
 * (`/dreaming`); the prompt wrapper is assembled in `format.js` from the
 * rendered memory state. Both languages share one structure so a mixed team
 * sees the same sections.
 */

/**
 * The long-term memory skeleton written when a project first gets memory.
 * @param {'zh' | 'en'} language template language
 * @returns {string} markdown skeleton
 */
export function longTermSkeleton(language) {
  if (language === 'en') {
    return `# Project long-term memory (shared consensus)

> Stable, slow-changing project consensus lives here. Time-ordered or expiring
> details belong to short-term memory (\`memory/short-term.jsonl\`).
> This file is maintained explicitly by people or by the model; the plugin only
> appends to or replaces the sections named by a tool call.

## Overview
<!-- TODO: one sentence on what this project does -->

## Tech stack
<!-- TODO: languages, frameworks, key dependencies and version constraints -->

## Layout and modules
<!-- TODO: the responsibility of each important directory -->

## Build, run, and verify
<!-- TODO: exact install, run, test, and lint commands -->

## Coding conventions
<!-- TODO: naming, formatting, error handling, commit message rules -->

## Decisions
<!-- TODO: confirmed architecture or product decisions and their reasons -->
`
  }
  return `# 项目长期记忆（基础共识）

> 这里保存长期有效、不轻易变更的项目共识；需要时间顺序、会过期的内容属于短期记忆
> （\`memory/short-term.jsonl\`）。本文件由人或模型显式维护；插件只会追加或替换
> 工具调用点名的章节，不会自动改写其它内容。

## 项目概述
<!-- 尚未填写：一句话说明这个项目做什么 -->

## 技术栈
<!-- 尚未填写：语言、框架、关键依赖与版本要求 -->

## 目录结构与模块
<!-- 尚未填写：重要目录的职责 -->

## 构建、运行与验证
<!-- 尚未填写：安装、运行、测试、lint 的具体命令 -->

## 编码与协作约定
<!-- 尚未填写：命名、格式、错误处理、提交信息等约定 -->

## 重要决策
<!-- 尚未填写：已确认的架构/产品决策及原因 -->
`
}

/**
 * The `memory/README.md` installed next to the memory files.
 * @param {'zh' | 'en'} language template language
 * @param {{ directoryName: string, maxShortTermRecords: number, recentRetentionHours: number, maxAgeDays: number, forgetMode: string }} config effective config
 * @returns {string} markdown explanation
 */
export function memoryReadme(language, config) {
  const forget = config.forgetMode === 'drop' ? '直接删除' : '移入 short-term-archive.jsonl'
  if (language === 'en') {
    return `# Project memory

This directory is this project's shared knowledge base. It is created and
maintained by the DeepSeek Harness \`project-memory\` plugin, and it is meant to
be read by every session that works in this project (and committed to git if
your team wants to share it).

The plugin uses four memory layers, each with a different lifetime:

| Layer | File | Scope | Lifetime |
|---|---|---|---|
| Working | \`working/<session>.json\` | one session | hours (\`workingMemoryTtlHours\`) |
| Episodic | \`short-term.jsonl\` | the project | bounded by salience and caps |
| Archival | \`short-term-archive.jsonl\` | the project | longer, never injected wholesale |
| Semantic | \`long-term.md\` | the project | until a person or the model changes it |

## Files

- \`long-term.md\` — semantic memory: the stable project consensus (stack,
  layout, build/verify commands, conventions, decisions). Content is the current
  state; edit it by hand or through \`memory_update_long_term\`.
- \`short-term.jsonl\` — episodic memory: one JSON object per development turn,
  describing that turn's **net** change set. Append-only; the plugin writes it
  after a turn ends by comparing the turn-start and turn-end snapshots.
- \`short-term-archive.jsonl\` — turns that left the live window (default:
  archived rather than deleted). Never injected wholesale; still searchable.
- \`working/<session>.json\` — working memory: the session's current task, next
  steps, open questions, and short-lived notes. Injected at the top of the
  memory block and pruned by TTL and session count.

## Short-term record shape

\`\`\`json
{"v":1,"id":"t_ab12cd","turn":12,"at":"2026-10-25T13:04:12.345Z","session":"…","cwd":"…",
 "type":"fix","subject":"optional logical subject","summary":"what changed and why",
 "files":[{"path":"src/a.py","added":3,"deleted":1}],
 "diff":[{"path":"src/a.py","text":"@@ …"}],
 "importance":0.7,"pinned":false,"hits":2,"lastHitAt":"2026-10-26T09:00:00.000Z",
 "origin":"snapshot+tracked","source":"agent"}
\`\`\`

- A turn is the unit: if \`a\` changed twice and \`b\` once, the record lists both
  files with the turn's net line counts.
- The **current state of a file** is derived at read time as the latest record
  that touched it, so two files changed in one turn share that turn.
- \`at\` is the turn-end timestamp (display and retention only). Ordering is the
  file order: the later appended record is authoritative.
- \`importance\` (0–1) and \`pinned\` are optional. Importance is derived from the
  change type, the detail, the file count, and whether the model explained the
  turn; a pinned record is never forgotten by the plugin.
- \`hits\`/\`lastHitAt\` count retrieval reinforcement: a record that keeps being
  recalled decays more slowly.

## Retrieval

The prompt does not inject everything. Working memory, the long-term file, and
the recent timeline are rendered directly; on top of that the plugin derives a
query from the working focus and retrieves the most relevant older turns with
BM25 (CJK bigrams + latin words), boosted by importance, pinning, and recency.
\`memory_search\` runs the same ranking on demand across live turns, archived
turns, long-term sections, and working memory.

## Forgetting

Short-term memory is a bounded, salience-aware window: the latest record of
each file, pinned records, and records younger than \`recentRetentionHours ×
(0.5 + importance)\`. Records older than ${config.maxAgeDays} days are forgotten
unless pinned. At most ${config.maxShortTermRecords} live records are kept;
overflow is ${forget}, oldest low-value records first. Stable conclusions older
than that window belong in \`long-term.md\`.

## Tools

| Tool | Purpose |
|---|---|
| \`memory_read\` | read the memory (scopes: current, all, turns, long-term, archive, working, brief) |
| \`memory_record\` | describe what this turn changed; written at turn end |
| \`memory_update_long_term\` | append to or replace one long-term section |
| \`memory_search\` | relevance search over every layer |
| \`memory_work\` | read/update/clear this session's working memory |
| \`memory_forget\` | forget outdated turns (pinned records are protected) |
| \`memory_pin\` | pin or unpin records so they survive forgetting |

## Commands

- \`/dreaming\` — consolidate: the model reads the evidence brief, searches for
  duplicates, promotes stable consensus into \`long-term.md\`, pins decisions,
  forgets outdated rows, closes working threads, and reports a summary.
`
  }
  return `# 项目记忆

本目录是这个项目的公共知识库，由 DeepSeek Harness 的 \`project-memory\` 插件创建和维护。
它供所有在本项目中工作的会话读取（如果团队希望共享，可以提交到 git）。

插件使用四层记忆，生命周期各不相同：

| 层 | 文件 | 范围 | 生命周期 |
|---|---|---|---|
| 工作记忆 | \`working/<session>.json\` | 单个会话 | 小时级（\`workingMemoryTtlHours\`） |
| 情景记忆 | \`short-term.jsonl\` | 项目 | 由显著度与上限约束 |
| 归档记忆 | \`short-term-archive.jsonl\` | 项目 | 更长，不会整体注入 |
| 语义记忆 | \`long-term.md\` | 项目 | 直到人或模型修改它 |

## 文件

- \`long-term.md\` —— 语义记忆：稳定、不轻易变化的项目共识（技术栈、目录、构建/验证命令、
  约定、重要决策）。文件内容就是当前状态；可以手工编辑，也可以用 \`memory_update_long_term\`。
- \`short-term.jsonl\` —— 情景记忆：一行一个开发轮次的 JSON 记录，描述该轮的**净变更集**。
  只追加；插件在轮末通过与轮开始快照比对得出内容后写入。
- \`short-term-archive.jsonl\` —— 离开活跃窗口的轮记录（默认归档而不是删除）。
  不会整体注入上下文，但仍可被检索。
- \`working/<session>.json\` —— 工作记忆：本会话的当前任务、下一步、待确认问题、临时笔记。
  注入在记忆块最前面，并按 TTL 和会话数自动清理。

## 短期记录格式

\`\`\`json
{"v":1,"id":"t_ab12cd","turn":12,"at":"2026-10-25T13:04:12.345Z","session":"…","cwd":"…",
 "type":"fix","subject":"可选的逻辑对象","summary":"改了什么、为什么",
 "files":[{"path":"src/a.py","added":3,"deleted":1}],
 "diff":[{"path":"src/a.py","text":"@@ …"}],
 "importance":0.7,"pinned":false,"hits":2,"lastHitAt":"2026-10-26T09:00:00.000Z",
 "origin":"snapshot+tracked","source":"agent"}
\`\`\`

- 记录单元是「轮」：a 改两次、b 改一次，记录同时列出 a 和 b，行数是该轮的净变化。
- 某文件的**当前状态**在读取时派生：取最近一条包含它的记录；同一轮改的两个文件共享该轮。
- \`at\` 是轮末时间（只用于展示与时间窗口）。先后顺序以文件追加顺序为准：后追加者权威。
- \`importance\`（0–1）与 \`pinned\` 是可选字段。重要度由变更类型、说明详细程度、涉及文件数、
  是否由模型主动说明推导；被固定的记录不会被插件遗忘。
- \`hits\`/\`lastHitAt\` 记录检索强化：反复被召回的历史记录衰减得更慢。

## 检索

提示词不会注入全部记忆。工作记忆、长期记忆文件、最近轮次时间线是直接渲染的；在此基础上，
插件用工作记忆中的任务与待办生成检索词，用 BM25（中文二元组 + 拉丁词）召回最相关的更早轮次，
并按重要度、固定状态、时间衰减加权。\`memory_search\` 用同一套排序按需检索活跃轮次、
归档轮次、长期记忆章节和工作记忆。

## 遗忘

短期记忆是有界、带显著度的窗口：每个文件的最新记录、被固定的记录，以及
「${config.recentRetentionHours} 小时 ×（0.5 + 重要度）」以内的记录。超过 ${config.maxAgeDays}
天的记录即使是最新也会被遗忘（固定记录除外）。活跃记录最多 ${config.maxShortTermRecords} 条，
超出部分会${forget}，优先淘汰最旧的低价值记录。比窗口更稳定的结论应写入 \`long-term.md\`。

## 工具

| 工具 | 用途 |
|---|---|
| \`memory_read\` | 读取记忆（scope：current、all、turns、long-term、archive、working、brief） |
| \`memory_record\` | 说明本轮改了什么，轮末写入记录 |
| \`memory_update_long_term\` | 追加或替换长期记忆的某个章节 |
| \`memory_search\` | 跨层相关性检索 |
| \`memory_work\` | 读取/更新/清空本会话的工作记忆 |
| \`memory_forget\` | 遗忘过时轮次（固定记录受保护） |
| \`memory_pin\` | 固定或取消固定记录，使其不被遗忘 |

## 命令

- \`/dreaming\` —— 固结：模型读取证据摘要，检索重复项，把稳定共识写进 \`long-term.md\`，
  固定关键决策，遗忘过时条目，关闭已完成的工作记忆线程，并汇报摘要。
`
}

/**
 * The user-role prompt queued by `/dreaming`.
 * @param {'zh' | 'en'} language prompt language
 * @param {{ project: string, root: string, focus?: string, maxFocus: number, counts: { turns: number }, brief?: string }} input
 * @returns {string} consolidation prompt
 */
export function dreamingPrompt(language, input) {
  const focus = String(input.focus ?? '').replace(/\s+/g, ' ').trim().slice(0, input.maxFocus)
  const brief = String(input.brief ?? '').trim()
  if (language === 'en') {
    return `[ /dreaming ] Consolidate this project's shared knowledge base (memory/).

Evidence computed by the plugin (may be incomplete):
${brief || '- (no evidence available)'}

1. Call memory_read with scope="current" first: short-term memory may have changed since this session started.
2. Promote facts that stay true over time into long-term memory with memory_update_long_term
   (tech stack, layout, build/verify commands, decisions). Do not duplicate what is already there.
3. Use memory_search before writing a fact that may already exist, so you merge instead of repeating it.
4. Use memory_pin on decisions later sessions must still find; pinning protects a record from forgetting.
5. Use memory_forget only for rows that are genuinely outdated, superseded, or already merged.
   Do not delete rows just to make the file tidy.
6. Close finished threads in the working memory with memory_work; keep still-open ones and update them.
7. Finish with one short paragraph: which long-term entries you added or updated, what you forgot, what you pinned, and what remains uncertain.

Constraints: do not modify project code; never record secrets, tokens, personal data, or one-off
temporary state in memory; leave uncertain conclusions in short-term memory marked as pending.
${focus ? `\nFocus for this pass: ${focus}` : ''}
Project: ${input.project} (${input.root}); live short-term turns: ${input.counts.turns}.`
  }
  return `〔/dreaming〕整理本项目的公共知识库（memory/）。

插件统计的证据（可能不完整）：
${brief || '- （暂无证据）'}

1. 先调用 memory_read（scope="current"）读取当前记忆；会话开始后短期记忆可能已经变化。
2. 把其中长期有效、不轻易变化的事实写入长期记忆（memory_update_long_term）：技术栈、目录约定、
   构建/验证命令、重要决策；长期记忆中已有的不要重复。
3. 写入前先用 memory_search 确认这条事实是否已经存在，存在就合并而不是重复添加。
4. 后续会话必须能找到的决策用 memory_pin 固定；被固定的记录不会被遗忘淘汰。
5. 对确实过时、被推翻或已被合并的短期记录，用 memory_forget 遗忘；不要为了整洁而无差别删除。
6. 工作记忆里已结束的事项用 memory_work 清理，仍在进行的保留并更新。
7. 结束时用一段话汇报：新增/更新了哪些长期共识、遗忘了什么、固定了什么、哪些还不确定。

约束：不要修改项目代码；不要往记忆里写密钥、令牌、个人数据或一次性临时状态；
不确定的内容留在短期记忆并标注待确认。
${focus ? `\n本轮关注：${focus}` : ''}
项目：${input.project}（${input.root}）；当前活跃短期记录 ${input.counts.turns} 条。`
}
