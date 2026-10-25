# Project Memory (`@local/dsh-project-memory`)

Per-project shared memory for DeepSeek Harness. Each project (DSH workspace)
gets a `memory/` knowledge base that every session reads, and each development
turn leaves one verifiable change record behind.

## What it creates

```
<project>/memory/
├── README.md                 # explanation of this folder (created once)
├── long-term.md              # stable project consensus (the current state)
├── short-term.jsonl          # one JSON record per development turn
└── short-term-archive.jsonl  # turns forgotten from the live window
```

`memory/` belongs to the project: edit `long-term.md` by hand, commit the folder
to git if the team wants to share it. The plugin never overwrites existing
files and never deletes user edits.

## Triggers

| Trigger | What happens |
|---|---|
| A project (workspace) is created | `memory/` skeleton is created |
| A session starts | skeleton ensured, retention compacted, prompt block frozen for that session |
| A development turn ends | the turn-start/turn-end snapshots are compared, one net-change record is written, retention is applied |
| The working directory changes | the prompt snapshot is dropped, the new project's memory is ensured |
| The user types `/dreaming` | one model turn is queued to consolidate short-term into long-term |
| `memory_forget` tool | matching short-term turns are forgotten |

## Short-term records

One line per turn, in append order:

```json
{"v":1,"id":"t_ab12cd","turn":12,"at":"2026-10-25T13:04:12.345Z",
 "session":"session-…","cwd":"/path/to/project","type":"fix",
 "subject":"optional logical subject","summary":"what changed and why",
 "files":[{"path":"src/a.py","added":3,"deleted":1}],
 "diff":[{"path":"src/a.py","text":"@@ …"}],
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
- `memory/` writes are always filtered out of records, so writing memory never
  looks like a project change.

## Forgetting

Short-term memory is a bounded window:

- the latest record for every file is kept;
- other records are kept for `recentRetentionHours` (default 24h);
- anything older than `maxAgeDays` (default 45d) is forgotten even if it is the
  latest for a file;
- the live file is capped at `maxShortTermRecords` (default 300), dropping the
  oldest non-current records first;
- forgotten turns go to `short-term-archive.jsonl` by default (`forgetMode:
  "archive"`), which is never injected; `forgetMode: "drop"` deletes them.

The injected prompt only contains the current state (at most
`injectCurrentFiles`) and a few recent turns (at most `injectRecentTurns`), so
context size does not grow with history. Stable conclusions older than the
window must be promoted to `long-term.md`.

## Tools

| Tool | Purpose |
|---|---|
| `memory_read` | Read long-term memory, per-file current state, recent turns, or the archive |
| `memory_record` | Describe the current turn in the model's words; merged with detected changes at turn end |
| `memory_update_long_term` | Append to or replace one long-term section |
| `memory_forget` | Forget turns by files, subject, or date |

## `/dreaming`

Typing `/dreaming` in the composer returns immediately and queues one model
turn. That turn calls `memory_read`, promotes stable consensus with
`memory_update_long_term`, forgets genuinely outdated rows with `memory_forget`,
and reports a summary. A per-project guard prevents overlapping consolidations.
An optional argument focuses the pass, for example `/dreaming 聚焦下载模块`.

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
```

| Key | Default | Meaning |
|---|---|---|
| `directoryName` | `memory` | memory folder name inside the project |
| `language` | `zh` | template and prompt language (`zh` / `en`) |
| `scaffoldExistingProjects` | `false` | backfill memory for projects that already exist |
| `injectPrompt` / `sectionOrder` | `true` / `10150` | prompt injection and its order |
| `enableTools` / `enableDreamingCommand` | `true` / `true` | tool and `/dreaming` switches |
| `autoRecord` / `recordToolNames` | `true` / `['write','edit']` | fallback file tracking |
| `changeWaitMs` | `800` | how long a turn waits for the `workspace/changes` event |
| `includeDiff` / `diffFiles` / `diffMaxChars` / `diffMaxLines` | `true` / `2` / `2048` / `40` | bounded diff excerpts |
| `maxFilesPerRecord` / `maxSummaryChars` | `50` / `200` | per-record limits |
| `recentRetentionHours` / `maxAgeDays` | `24` / `45` | retention window |
| `maxShortTermRecords` | `300` | live record cap |
| `forgetMode` | `archive` | `archive` (reversible) or `drop` (delete) |
| `archiveMaxRecords` / `archiveMaxAgeDays` | `2000` / `365` | archive bounds |
| `injectCurrentFiles` / `injectRecentTurns` | `10` / `3` | injected rows |
| `dreamingFocusMaxChars` / `dreamingCooldownMs` | `200` / `120000` | `/dreaming` limits |
| `maxInjectBytes` / `maxLongTermInjectBytes` / `maxShortTermInjectBytes` | `22528` / `16384` / `4096` | prompt caps |
| `maxLongTermBytes` / `maxSourceBytes` / `maxReadBytes` | `65536` / `1048576` / `65536` | write and read caps |

## Install

```text
plugin_manager list_plugins
plugin_manager install_bundle  →  target: /absolute/path/to/dsh-project-memory
```

Installing affects every session of the profile. Uninstall with
`plugin_manager remove_bundle`; the generated `memory/` folders stay.

## Limitations

- Shell or IDE edits are only visible when the project is a git repository
  (the harness snapshot requirement); file-tool edits are always captured.
- User edits made during a turn are attributed to that turn (harness behavior).
- Subagent file edits are merged into the parent turn through the plugin's own
  tracking, and a subagent's `memory_record` note is folded into that record's
  `detail` (visible through `memory_read`). Team teammates are currently treated
  the same way: their turns are folded into the Lead's turn record.
- Background subagent work that lands after the parent turn ends can be missed.
- Renames are not tracked: an old path stays until retention forgets it.
- The injected prompt is a session-start snapshot; call `memory_read` for fresh
  content, or run `/dreaming` to consolidate.
- Writing `memory/` inside a git working tree may appear on the harness
  changed-files card; consider adding it to `.git/info/exclude`.

## Development

```bash
node --check index.js
node test/smoke.mjs
```

The smoke test is dependency-free and covers parsing, merging, current-state
derivation, retention, long-term edits, prompt rendering/caps, and the
`/dreaming` handler.
