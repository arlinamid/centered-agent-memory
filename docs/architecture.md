# Architecture

```
sources (read-only)           →  collectors  →  index (SQLite)  →  query      →  CLI / MCP
~/.claude/projects/*.jsonl       claude-code      sources            recall
~/.codex/state_5.sqlite          codex            sessions           timeline
<appdata>/Cursor/state.vscdb     cursor           turns (locator)    dossier
<appdata>/Claude/…               cowork           chunks + FTS5
                                 claude-desktop   path_evidence
                                 cursor-history   attribution
                                 artifacts        artifacts
```

## The three rules

**Reference, not a copy.** A `turns` row stores *where* the text is: file + byte
offset + length + a JSON pointer (`message.content[*].text`), or for Cursor the
`state.vscdb` key. `chunks_fts` is contentless (`content=''`), so the inverted
index exists and the text does not. At query time the `Hydrator` reads it back
from the source.

One exception: **volatile** material. The `%TEMP%/claude/**` scratchpad the OS
may delete at any time, Cowork outputs that depend on the app's cleanup — these
go in as `inline_text` (up to 256 KB).

**No guessing.** If a session's project cannot be determined, it stays
`unattributed`. Every verdict carries the method and the confidence, and
`recall` hides weak hits by default.

**Never writes to the sources.** Every foreign store is opened with
`openSourceReadonly` (`readonly: true`, `fileMustExist: true`). `immutable` is
deliberately not turned on: with a live WAL we would read torn pages.

## Incrementality

The `sources` table is the ledger. For an append-only file:

| state | decision |
|---|---|
| same size **and** mtime | `skip` — zero reads |
| grew, and the fixed-window prefix-hash matches | `append` from `bytes_indexed` |
| the prefix-hash differs, or it shrank | `full` — `status='rotated'`, full re-read |
| the file vanished | `missing` |

The prefix-hash uses a **fixed window** (`min(4096, bytes_indexed)` bytes). If
we hashed up to the file's current size, every append would cover a different
window, and every sync would be a full re-read.

Cursor is not a file but a key-value store, so there `ext_version` = the
conversation's `lastUpdatedAt`. Those with no timestamp use the sha256 of
`composerData` as the signal — but **only then**, because editing a bubble's
text does not change `composerData` (it is only a list of identifiers).

## Project recognition

There is no hard-wired root list. `ProjectResolver` walks the path upwards:

1. **Learned root** (`projects.root_path`) — survives the project being moved or deleted.
2. **Workspace root** (`workspace_roots`) — the walk stops here, and the folder
   under it is the project. `detectWorkspaceRoots` learns these from the corpus:
   a folder is a collector if at least three **different sessions** have a cwd
   among its children.
3. **Marker** — `.git`, `package.json`, `pyproject.toml`, `go.mod`,
   `CMakeLists.txt`, `CLAUDE.md`, … Generic names (`src`, `backend`, `dist`)
   are skipped.

Step 2 is needed because a collector folder can itself be a git repo, with
twenty projects in its belly — the markers would all return the collector
folder's name, once per project. A filesystem heuristic cannot separate them:
a large project fails the other way, no marker of its own, many marked
subfolders. So it is not the disk that decides, but how many different sessions
worked under it.

Generated names (UUID, ≥16-digit hex, `job-…-20260826-212306`, `codex-runs`,
`worktrees`) are never project names; the walk continues upwards, so
`codex-runs/<uuid>` lands with its project.

## Attribution cascade

The evidence (`path_evidence`) is separate from the verdict (`attribution`).
Producing evidence is expensive — a store has to be read for it; the verdict is
cheap, a pure function of the evidence. That is why `cam reattribute` finishes
in a second, and adding an alias is an interactive operation.

| step | source | weight | confidence |
|---|---|---|---|
| `manual` | `cam attribute` | 1000 | strong |
| `cwd`, `user_selected_folders` | the session's working directory / selected folders | 3 | strong |
| `ofs_key` | Cursor `ofsContent` keys (open files) | 2 | strong |
| `bubble_scan`, `msg_request_ctx` | paths mentioned in the conversation | 1 | strong |
| `time_correlation` | Cursor file history ±30 min, ≥3 events and ≥50% share | 1 | medium |
| `time_correlation_weak` | the same, with less evidence | 1 | weak |

`runner_up_key` is always written: a thread that voted 6:5 is a different
animal from 6:0.

`manual` and `time_correlation*` evidence **carries the verdict itself**: their
`raw_path` is a mark (`~manual:<key>`, `~time:9/10`), not a path, so
recalculation does not resolve them again. Without this a manual decision would
be lost on every `cam reattribute` — `rule_version` 2 is the point that marks
this.

## Search

FTS5 with the `unicode61 remove_diacritics 2` tokenizer, so `arvizturo` finds
`árvíztűrő`. There is no stemmer anywhere, and Hungarian is agglutinative, so
tokens longer than 5 characters go as a **prefix** (`projekt*` → `projektben`,
`projektet`).

`snippet()` returns NULL on a contentless table, so the excerpt and the
highlight are built from rehydration. Diacritic folding is
**length-preserving**, otherwise the mark would slip after every accent.

## File layout

```
src/
  paths.ts, config.ts        platform-dependent locations, markers, excluded areas
  db/{schema,open}.ts        schema, hub and source openers, SQLite capability check
  index/
    jsonl.ts                 offset-tracking reader, pointer resolution
    chunker.ts               windowed splitting on turn boundaries
    indexer.ts               session/turn/chunk write, FTS
    hydrate.ts               read-back: ok / stale / missing
    watermarks.ts            skip / append / full decision
  attribution/
    projkey.ts               marker + root based project recognition
    roots.ts                 workspace-root learning
    evidence.ts              path extraction, evidence write
    resolve.ts               cascade, time correlation, recalculation
  collectors/                one per tool, shared interface
  memory/                    consolidation, scoring, promoted memories, dream
  ops/
    freshness.ts             how fresh the index is (sync_runs)
    prune.ts                 retention, forget, vacuum
    backup.ts                verified online backup
  db/portability.ts          case-fold stamp: a copied index does not silently find nothing
  log.ts                     --quiet / --verbose; the answer never disappears
  search/keywords.ts         HU/EN query analysis, highlighting
  query/                     recall, timeline, dossier, shared rendering
  install/
    clients.ts               which client keeps its config and skills where
    mcp.ts                   JSON merge and TOML table replace, with backup
    skills.ts                rendering the shared skill body per client
    locate.ts                finding the real program behind the launchers
    dream.ts                 agent CLIs as a model: discovery, models, probe
    schedule.ts              Task Scheduler / launchd / systemd — plan and apply
    prompt.ts                the two questions the installer may ask
  mcp/server.ts              seven read-only tools, each response carrying the index's age
  cli.ts
assets/skill-body.md         the skill body; {{SURFACE}} is replaced with the client
skills/agent-memory/SKILL.md the public, discoverable skill (`npx skills add`)
```

`install/` is deliberately split into **plan and apply**: every part first
computes what it would do, and only then writes. That is why `--dry-run` is not
an approximation but the same plan, and why the three platforms' scheduler
recipes can be tested from a single machine.
