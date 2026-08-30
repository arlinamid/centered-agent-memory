# Architecture

```
sources (read-only)                 →  collectors / get  →  index (SQLite)  →  query      →  CLI / MCP
~/.claude/projects/*.jsonl              claude-code          sources            recall
~/.codex/state_5.sqlite                 codex                sessions           timeline
<appdata>/Cursor/state.vscdb            cursor               turns (locator     dossier
<appdata>/Claude/…                      cowork, desktop            or inline)
~/.gemini/tmp/…                         gemini-cli           chunks + FTS5
~/.gemini/antigravity*/                 antigravity          path_evidence
<appdata>/devin/cli/sessions.db         devin-cli            attribution
~/.codeium/windsurf/cascade/*.pb        devin-cascade        artifacts
                                        + RPC on `cam get`
```

## The three rules

**Reference, not a copy.** A `turns` row stores *where* the text is: file + byte
offset + length + a JSON pointer (`message.content[*].text`), or for Cursor the
`state.vscdb` key. `chunks_fts` is contentless (`content=''`), so the inverted
index exists and the text does not. At query time the `Hydrator` reads it back
from the source.

Two exceptions, both `inline`, both still on this machine:

- **Volatile** material. The `%TEMP%/claude/**` scratchpad the OS may delete
  at any time, Cowork outputs that depend on the app's cleanup — these go in
  as `artifacts.inline_text` (up to 256 KB).
- **Encrypted Cascade bodies.** Antigravity and Devin desktop keep the
  conversation on disk in a form we cannot read. `cam get` asks the live
  language server and stores the speech as `turns.inline_text`, because there
  is no file and byte offset to record. This is not part of `cam sync`. See
  [`sources.md`](sources.md#cascade-bodies-on-demand).

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

A store that is not an append-only file uses `ext_version` the same way:
unchanged version is skip. Cursor is `lastUpdatedAt` (or the sha256 of
`composerData` when there is no timestamp — **only then**, because editing a
bubble does not change `composerData`). Codex and Devin CLI use a version
the store itself publishes. Antigravity summaries use
`last_modified_time + step_count`. A Cascade `.pb` uses mtime + size, and
the collector never opens the bytes.

## On-demand fetch

A collector that ran against an encrypted file would have to start a vendor
daemon on an hourly schedule and decrypt hundreds of conversations nobody
asked for. So `cam sync` records that the conversation exists, and `cam get`
/ `cam_get` is the only moment that talks to the language server.

That path lives in `src/sources/`, not under `collectors/`. It finds every
live `language_server*` process, reads the CSRF token from argv or from the
process environment (Linux `/proc`, macOS `sysctl` then `ps`, Windows PEB),
probes both listening ports, and asks each daemon — a daemon only knows its
own surface. It does not start one. A closed app is a normal answer.

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
| `cwd`, `user_selected_folders`, `workspace_dirs`, `workspace_uris` | the session's working directory / selected folders (three names for the same fact; Antigravity has no cwd column at all) | 3 | strong |
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
this. `rule_version` 3 is the same for `workspace_dirs` and `workspace_uris`:
without them in the `cwd` step every Antigravity conversation would stay
unattributed.

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
  collectors/                one per store, shared interface (metadata only
                             for encrypted Cascade)
  sources/
    language-server.ts       find live Codeium-lineage daemons (ports, CSRF)
    process-env.ts           one env var from another process (Linux / macOS / Windows)
    cascade-rpc.ts           GetCascadeTrajectory against every daemon
    antigravity-trajectory.ts speech-field whitelist
    antigravity-fetch.ts     `cam get antigravity:…`
    devin-fetch.ts           `cam get devin:…` (not CLI sessions)
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
assets/read-process-env.ps1  Windows PEB reader for `WINDSURF_CSRF_TOKEN`
skills/agent-memory/SKILL.md the public, discoverable skill (`npx skills add`)
```

`install/` is deliberately split into **plan and apply**: every part first
computes what it would do, and only then writes. That is why `--dry-run` is not
an approximation but the same plan, and why the three platforms' scheduler
recipes can be tested from a single machine.
