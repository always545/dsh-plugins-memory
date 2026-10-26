# Project Memory (`@local/dsh-project-memory`)

Per-project shared memory for DeepSeek Harness. Each project (DSH workspace)
gets a `memory/` knowledge base that every session reads, and each development
turn leaves one verifiable change record behind.

The plugin does not just stack files. It keeps four layers with different
lifetimes, retrieves from them with a lexical index instead of dumping
everything into context, forgets by salience instead of age alone, and hands
`/dreaming` a computed evidence brief instead of a blank "please tidy up".

## What it creates

```
<project>/memory/
├── README.md                 # explanation of this folder (created once)
├── long-term.md              # semantic memory: stable project consensus
├── short-term.jsonl          # episodic memory: one JSON record per turn
├── short-term-archive.jsonl  # turns forgotten from the live window
└── working/                  # working memory: one JSON file per session
    └── <session>.json
```

`memory/` belongs to the project: edit `long-term.md` by hand, commit the folder
to git if the team wants to share it. The plugin never overwrites existing
files and never deletes user edits.

## Layers

| Layer | File | Scope | Lifetime | In the prompt |
|---|---|---|---|---|
| Working | `working/<session>.json` | one session | hours (`workingMemoryTtlHours`) | yes, first |
| Episodic | `short-term.jsonl` | project | salience-bounded | recent + relevant |
| Archival | `short-term-archive.jsonl` | project | longer | only through retrieval |
| Semantic | `long-term.md` | project | explicit edits | yes, whole |

## Triggers

| Trigger | What happens |
|---|---|
| A project (workspace) is created | `memory/` skeleton is created |
| A session starts | skeleton ensured, retention compacted, working memory pruned, prompt block assembled |
| A development turn ends | the turn-start/turn-end snapshots are compared, one net-change record with derived importance is written, retention is applied |
| The working directory changes | the prompt snapshot is dropped, the new project's memory is ensured |
| A new turn starts (`promptRefresh: "turn"`) | the prompt snapshot is dropped so the next model call sees fresh memory |
| The user types `/dreaming` | one model turn is queued with a computed consolidation brief |
| A memory tool runs | `memory_search` reinforces recalled records, `memory_work` updates the scratchpad, `memory_pin` protects records |

## Short-term records

One line per turn, in append order:

```json
{"v":1,"id":"t_ab12cd","turn":12,"at":"2026-10-25T13:04:12.345Z",
 "session":"session-…","cwd":"/path/to/project","type":"fix",
 "subject":"optional logical subject","summary":"what changed and why",
 "files":[{"path":"src/a.py","added":3,"deleted":1}],
 "diff":[{"path":"src/a.py","text":"@@ …"}],
 "importance":0.72,"pinned":false,"hits":2,"lastHitAt":"2026-10-26T09:00:00.000Z",
 "origin":"snapshot+tracked","source":"agent"}
```

- **The turn is the unit.** If `a` changed twice and `b` once in one turn, the
  record lists both files with the turn's net line counts. This is why the
  plugin consumes the harness **workspace-changes** comparison (git working-tree
  snapshots when available, whole-file captures around file tools otherwise)
  instead of guessing from individual tool calls.
- **Current state per file is derived at read time**: the latest record that
  touched the file. Two files changed in one turn share that turn; if only one
  is changed later, the other keeps pointing at the earlier turn.
- **Ordering is file order**, not timestamp order: the later appended record is
  authoritative, so clock skew cannot invert the answer. `at` is for display and
  retention only.
- **Importance is derived once** from the change type, the model's explanation,
  the file count, and the source; a model can raise it indirectly by writing a
  `subject`/`detail`, and `memory_pin` always means "never forget".
- **`hits`/`lastHitAt` are retrieval reinforcement**: each recall of an older
  record slows its decay, so knowledge that keeps being useful stays reachable.
- `memory/` writes are always filtered out of records, so writing memory never
  looks like a project change.

## Retrieval

The prompt is assembled, not dumped:

1. **Working memory** — current task, next steps, open questions, notes.
2. **Long-term memory** — the whole semantic layer, byte-capped.
3. **Relevant recall** — older turns ranked with BM25 against a query derived
   from the working focus (falling back to the latest turns). Chinese text is
   tokenized into bigrams, Latin text into lowercase words; ranking adds
   importance, pin, recency, and kind weights. Turns already shown in the recent
   timeline are excluded.
4. **Recent timeline** — per-file current state and the last few turns.

The index is cached per project and rebuilt only when the memory files or the
session's working memory change (`store.signature`). `memory_search` runs the
same ranking on demand across live turns, archived turns, long-term sections,
and working memory, and reinforces the records it returns.

## Forgetting

Short-term memory is a bounded, salience-aware window:

- pinned records are kept regardless of age (up to `maxPinnedRecords`);
- the latest record for every file is kept;
- other records are kept for `recentRetentionHours × (0.5 + importance)`, so a
  feature/fix stays longer than a chore;
- anything older than `maxAgeDays` (default 45d) is forgotten unless pinned;
- the live file is capped at `maxShortTermRecords` (default 300), dropping the
  oldest non-current records first, then the oldest non-pinned, and only then
  pinned records beyond the pin budget;
- forgotten turns go to `short-term-archive.jsonl` by default
  (`forgetMode: "archive"`), which is never injected wholesale; `forgetMode:
  "drop"` deletes them.

Stable conclusions older than the window must be promoted to `long-term.md`
(that is what `/dreaming` is for).

## Tools

| Tool | Purpose |
|---|---|
| `memory_read` | Read memory by scope: `current`, `all`, `turns`, `long-term`, `archive`, `working`, `brief` |
| `memory_record` | Describe the current turn in the model's words; merged with detected changes at turn end |
| `memory_update_long_term` | Append to or replace one long-term section |
| `memory_search` | Relevance search over turns, archive, long-term sections, and working memory |
| `memory_work` | Read/update/clear this session's working memory (task, next, questions, notes) |
| `memory_forget` | Forget turns by files, subject, or date; pinned records are protected |
| `memory_pin` | Pin or unpin records by id, subject, files, or date |

## `/dreaming`

Typing `/dreaming` in the composer returns immediately and queues one model
turn. Before queueing, the plugin computes a **consolidation brief**: live turn
counts, subjects that repeat (promotion candidates), near-duplicate records,
stale pins, old low-salience forget candidates, long-term section sizes, and the
session's open working threads. The queued prompt carries that brief, then asks
the model to read current memory, **search before writing** so facts are merged
rather than duplicated, promote stable consensus, pin decisions, forget what is
genuinely outdated, close finished working threads, and report a summary.

A per-project guard prevents overlapping consolidations. An optional argument
focuses the pass, for example `/dreaming 聚焦下载模块`.

## Configuration

No loader schema is exported (a profile bundle cannot resolve the harness's
schema package); unknown keys are ignored and invalid values fall back to the
documented default. Override the row in
`~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: project-memory
  name: '@local/dsh-project-memory'
  config:
    language: zh
    maxShortTermRecords: 200
    injectRecentTurns: 2
    injectRelevantTurns: 6
```

| Key | Default | Meaning |
|---|---|---|
| `directoryName` | `memory` | memory folder name inside the project |
| `language` | `zh` | template and prompt language (`zh` / `en`) |
| `scaffoldExistingProjects` | `false` | backfill memory for projects that already exist |
| `injectPrompt` / `sectionOrder` | `true` / `10150` | prompt injection and its order |
| `promptRefresh` | `session` | `session` keeps a stable prefix (cache-friendly); `turn` re-renders every turn |
| `enableTools` / `enableDreamingCommand` | `true` / `true` | tool and `/dreaming` switches |
| `autoRecord` / `recordToolNames` | `true` / `['write','edit']` | fallback file tracking |
| `changeWaitMs` | `800` | how long a turn waits for the `workspace/changes` event |
| `includeDiff` / `diffFiles` / `diffMaxChars` / `diffMaxLines` | `true` / `2` / `2048` / `40` | bounded diff excerpts |
| `maxFilesPerRecord` / `maxSummaryChars` | `50` / `200` | per-record limits |
| `recentRetentionHours` / `maxAgeDays` | `24` / `45` | retention window |
| `maxShortTermRecords` / `maxPinnedRecords` | `300` / `300` | live record cap and pin budget |
| `importanceHalfLifeDays` | `21` | salience decay half-life |
| `forgetMode` | `archive` | `archive` (reversible) or `drop` (delete) |
| `archiveMaxRecords` / `archiveMaxAgeDays` | `2000` / `365` | archive bounds |
| `injectCurrentFiles` / `injectRecentTurns` / `injectRelevantTurns` | `10` / `3` / `4` | injected rows |
| `enableSearch` / `searchMaxResults` / `searchMaxBytes` | `true` / `8` / `6144` | retrieval tool |
| `archiveSearchLimit` | `200` | archived records considered by recall |
| `reinforceHits` | `true` | count recalled records as reinforcement |
| `enableWorkingMemory` | `true` | working-memory layer switch |
| `workingMemoryTtlHours` / `workingMemoryMaxSessions` / `workingMemoryMaxBytes` | `72` / `20` / `4096` | working-memory bounds |
| `budgetWorkingBytes` / `budgetRecallBytes` | `3072` / `4096` | prompt budget per new layer |
| `dreamingFocusMaxChars` / `dreamingCooldownMs` / `consolidateBriefBytes` | `200` / `120000` / `3072` | `/dreaming` limits |
| `maxInjectBytes` / `maxLongTermInjectBytes` / `maxShortTermInjectBytes` | `22528` / `16384` / `4096` | prompt caps |
| `maxLongTermBytes` / `maxSourceBytes` / `maxReadBytes` | `65536` / `1048576` / `65536` | write and read caps |

When the prompt exceeds `maxInjectBytes`, sections shrink in reverse priority:
recent timeline, then relevant recall, then long-term memory, then working
memory.

## Install

```text
plugin_manager list_plugins
plugin_manager install_bundle  →  target: /absolute/path/to/dsh-project-memory
```

Installing affects every session of the profile. Uninstall with
`plugin_manager remove_bundle`; the generated `memory/` folders stay.

## Limitations

- Retrieval is lexical (BM25), not semantic: a paraphrase that shares no words
  with a record will not be recalled. `memory_search` with different wording is
  the fallback; embeddings would need a model dependency this bundle cannot ship.
- Chinese/Mixed text relies on bigram tokenization, so single-character queries
  are weak by design.
- Shell or IDE edits are only visible when the project is a git repository
  (the harness snapshot requirement); file-tool edits are always captured.
- User edits made during a turn are attributed to that turn (harness behavior).
- Subagent file edits are merged into the parent turn through the plugin's own
  tracking, and a subagent's `memory_record` note is folded into that record's
  `detail` (visible through `memory_read`). Team teammates are treated the same
  way: their turns are folded into the Lead's turn record.
- Background subagent work that lands after the parent turn ends can be missed.
- Renames are not tracked: an old path stays until retention forgets it.
- The injected prompt is a snapshot by default (`promptRefresh: "session"`);
  call `memory_read`/`memory_search` for fresh content, or switch to
  `promptRefresh: "turn"` and accept the prefix-cache cost.
- Writing `memory/` inside a git working tree may appear on the harness
  changed-files card; consider adding it to `.git/info/exclude`.

## Development

```bash
node --check index.js
node test/smoke.mjs        # 40 dependency-free unit tests
node test/integration.mjs  # apply() wiring against a fake cordis context
```

The smoke test covers parsing, merging, current-state derivation, salience and
retention, working memory, tokenization and BM25 ranking, recall, prompt
assembly and caps, consolidation evidence, and the memory tools. The integration
test drives the real `apply()`: prompt section, seven tool registrations, a turn
record with derived importance, and `memory_read`/`/dreaming` paths.
