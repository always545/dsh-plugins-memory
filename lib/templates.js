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

## Files

- \`long-term.md\` — long-term memory: the stable project consensus
  (stack, layout, build/verify commands, conventions, decisions). Content is
  the current state; edit it by hand or through \`memory_update_long_term\`.
- \`short-term.jsonl\` — short-term memory: one JSON object per development turn,
  describing that turn's **net** change set. Append-only; the plugin writes it
  after a turn ends by comparing the turn-start and turn-end snapshots.
- \`short-term-archive.jsonl\` — turns that were forgotten from the live window
  (default: archived rather than deleted). Never injected into model context.

## Short-term record shape

\`\`\`json
{"v":1,"id":"t_ab12cd","turn":12,"at":"2026-10-25T13:04:12.345Z","session":"…","cwd":"…",
 "type":"fix","subject":"optional logical subject","summary":"what changed and why",
 "files":[{"path":"src/a.py","added":3,"deleted":1}],
 "diff":[{"path":"src/a.py","text":"@@ …"}],
 "origin":"snapshot+tracked","source":"agent"}
\`\`\`

- A turn is the unit: if \`a\` changed twice and \`b\` once, the record lists both
  files with the turn's net line counts.
- The **current state of a file** is derived at read time as the latest record
  that touched it, so two files changed in one turn share that turn.
- \`at\` is the turn-end timestamp (display and retention only). Ordering is the
  file order: the later appended record is authoritative.

## Forgetting

Short-term memory is a bounded window: the latest record of each file, plus
other records younger than ${config.recentRetentionHours}h. Records older than
${config.maxAgeDays} days are forgotten even if they are the latest for a file.
At most ${config.maxShortTermRecords} live records are kept; overflow is
${forget}. Stable conclusions older than that window belong in \`long-term.md\`.

## Commands

- \`/dreaming\` — consolidate: the model reads short-term memory, promotes stable
  consensus into \`long-term.md\`, forgets outdated rows, and reports a summary.
`
  }
  return `# 项目记忆

本目录是这个项目的公共知识库，由 DeepSeek Harness 的 \`project-memory\` 插件创建和维护。
它供所有在本项目中工作的会话读取（如果团队希望共享，可以提交到 git）。

## 文件

- \`long-term.md\` —— 长期记忆：稳定、不轻易变化的项目共识（技术栈、目录、构建/验证命令、
  约定、重要决策）。文件内容就是当前状态；可以手工编辑，也可以用 \`memory_update_long_term\`。
- \`short-term.jsonl\` —— 短期记忆：一行一个开发轮次的 JSON 记录，描述该轮的**净变更集**。
  只追加；插件在轮末通过与轮开始快照比对得出内容后写入。
- \`short-term-archive.jsonl\` —— 被遗忘出活跃窗口的轮记录（默认归档而不是删除），
  永远不会注入模型上下文。

## 短期记录格式

\`\`\`json
{"v":1,"id":"t_ab12cd","turn":12,"at":"2026-10-25T13:04:12.345Z","session":"…","cwd":"…",
 "type":"fix","subject":"可选的逻辑对象","summary":"改了什么、为什么",
 "files":[{"path":"src/a.py","added":3,"deleted":1}],
 "diff":[{"path":"src/a.py","text":"@@ …"}],
 "origin":"snapshot+tracked","source":"agent"}
\`\`\`

- 记录单元是「轮」：a 改两次、b 改一次，记录同时列出 a 和 b，行数是该轮的净变化。
- 某文件的**当前状态**在读取时派生：取最近一条包含它的记录；同一轮改的两个文件共享该轮。
- \`at\` 是轮末时间（只用于展示与时间窗口）。先后顺序以文件追加顺序为准：后追加者权威。

## 遗忘

短期记忆是有界窗口：每个文件的最新记录，加上 ${config.recentRetentionHours} 小时内
的其它记录。超过 ${config.maxAgeDays} 天的记录即使是最新也会被遗忘。活跃记录最多
${config.maxShortTermRecords} 条，超出部分会${forget}。比窗口更稳定的结论应写入
\`long-term.md\`。

## 命令

- \`/dreaming\` —— 固结：模型读取短期记忆，把稳定的共识写进 \`long-term.md\`，遗忘过时条目，
  并汇报摘要。
`
}

/**
 * The user-role prompt queued by `/dreaming`.
 * @param {'zh' | 'en'} language prompt language
 * @param {{ project: string, root: string, focus?: string, maxFocus: number, counts: { turns: number } }} input
 * @returns {string} consolidation prompt
 */
export function dreamingPrompt(language, input) {
  const focus = String(input.focus ?? '').replace(/\s+/g, ' ').trim().slice(0, input.maxFocus)
  if (language === 'en') {
    return `[ /dreaming ] Consolidate this project's shared knowledge base (memory/).

1. Call memory_read with scope="current" first: short-term memory may have changed since this session started.
2. Promote facts that stay true over time into long-term memory with memory_update_long_term
   (tech stack, layout, build/verify commands, decisions). Do not duplicate what is already there.
3. Use memory_forget only for rows that are genuinely outdated, superseded, or already merged.
   Do not delete rows just to make the file tidy.
4. Finish with one short paragraph: which long-term entries you added or updated, what you forgot, and what remains uncertain.

Constraints: do not modify project code; never record secrets, tokens, personal data, or one-off
temporary state in memory; leave uncertain conclusions in short-term memory marked as pending.
${focus ? `\nFocus for this pass: ${focus}` : ''}
Project: ${input.project} (${input.root}); live short-term turns: ${input.counts.turns}.`
  }
  return `〔/dreaming〕整理本项目的公共知识库（memory/）。

1. 先调用 memory_read（scope="current"）读取当前记忆；会话开始后短期记忆可能已经变化。
2. 把其中长期有效、不轻易变化的事实写入长期记忆（memory_update_long_term）：技术栈、目录约定、
   构建/验证命令、重要决策；长期记忆中已有的不要重复。
3. 对确实过时、被推翻或已被合并的短期记录，用 memory_forget 遗忘；不要为了整洁而无差别删除。
4. 结束时用一段话汇报：新增/更新了哪些长期共识、遗忘了什么、哪些还不确定。

约束：不要修改项目代码；不要往记忆里写密钥、令牌、个人数据或一次性临时状态；
不确定的内容留在短期记忆并标注待确认。
${focus ? `\n本轮关注：${focus}` : ''}
项目：${input.project}（${input.root}）；当前活跃短期记录 ${input.counts.turns} 条。`
}
