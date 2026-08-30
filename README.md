# centered-agent-memory

One searchable index over the conversations of **every** AI coding tool on your machine — Claude Code,
Claude Desktop / Cowork, Codex and Cursor — organised by project. Usable as a CLI and as an MCP server,
so any agent can look up what the others already did.

Magyar leírás: [`README.hu.md`](README.hu.md). A `docs/` mappa magyarul van.

## Principles

**No duplication.** The index stores *where* a conversation lives (file + byte offset, or an SQLite
key), never its text. Result snippets are read back from the source at query time. The one exception is
volatile material — OS-temp scratchpads and Cowork outputs the system may delete — which is copied into
the `artifacts` table. Conversation turns are always references, without exception.

**No guessing.** A session whose project cannot be determined stays `unattributed`. Every attribution
carries the signal it came from and how confident it is.

**Never writes to the sources.** Every foreign store is opened read-only. That is a structural
guarantee (`openSourceReadonly`), not a matter of discipline.

**Nothing leaves the machine.** The core does no networking and there is no telemetry. One optional
command can call a model you configure — `cam memory dream` — and it is off until you configure one,
prints what it would send before sending it, and is never called by anything else.

**Fast where it matters.** Unchanged sources drop out on a single `stat` call: the check round of all
seven collectors is ~330 ms on the reference machine (1,643 sessions, 32,054 turns). Queries are cheap
too — `cam recall` 55 ms, `cam dossier` 8 ms. A repeat `cam sync` end to end is ~4.6 s, most of it the
attribution pass; see the [CHANGELOG](CHANGELOG.md) measurements.

**Says how old it is.** Every MCP response ends with the index's age, so an agent cannot quote a
six-week-old answer as current. Unattended operation — scheduling, freshness, retention, backup — is
in [`docs/operations.md`](docs/operations.md) (Hungarian).

## Install

Node 24 or newer is required — the active LTS line. The package is not on the npm registry, so
install it from a checkout:

```bash
git clone https://github.com/arlinamid/centered-agent-memory.git
cd centered-agent-memory
npm ci --ignore-scripts                       # the prepare script builds
npm pack                                      # a self-contained copy
npm install -g --ignore-scripts ./centered-agent-memory-*.tgz
cam install                                   # wire it into the agent tools
```

The tarball step is not ceremony: `npm link` and `npm install -g .` both link back to the checkout
instead of copying it, so moving or deleting the checkout would break every client you just wired
up. Install from the tarball and the checkout becomes disposable.

Nor is `--ignore-scripts`: **nothing in this dependency tree needs an install script.** The SQLite
binding ships a prebuilt binary for every platform it supports, yet npm would still run its
implicit `node-gyp rebuild` on it — which on Windows goes looking for Visual Studio in order to
produce an empty project. On a machine without a compiler that fails, for a build that was never
needed.

`cam install` registers the server with every agent tool it finds (Claude Code, Claude Desktop,
Codex, Cursor), writes a skill telling that agent when to consult the index, gives the optional
dream phase a model taken from an agent CLI already on the machine, and schedules the hourly
refresh. Run it with `--dry-run` first to see the plan; details and opt-outs in
[`docs/install.md`](docs/install.md) (Hungarian).

**It deliberately cannot be installed through `npx`.** `npx` unpacks into the npm cache, which npm
later collects, so an entry written from there would break silently. The installer detects this,
writes nothing, and points at `npm i -g` instead. `npx` is fine for a one-off query — the index
lives in a user data directory and survives — just not for the wiring.

The index lives in a user data directory — `%LOCALAPPDATA%\centered-agent-memory\hub.sqlite` on
Windows, `$XDG_DATA_HOME/centered-agent-memory/hub.sqlite` (or `~/.local/share/...`) elsewhere — so a
global install and repeated `npx` runs share one index. A checkout that already has `.data/hub.sqlite`
keeps using it. `cam doctor` prints the paths actually in use.

Override the location with `--db <path>`, the `CAM_DB` environment variable, or a config file:

```json
{
  "dbPath": "D:/index/hub.sqlite",
  "roots": { "codexStateDb": "D:/codex/state_5.sqlite" }
}
```

The config file lives at `%APPDATA%\centered-agent-memory\config.json` (Windows) or
`$XDG_CONFIG_HOME/centered-agent-memory/config.json`, and `CAM_CONFIG` moves it. Any of the ten store
locations can be overridden under `roots`.

## Usage

```bash
cam sync                       # read the sources (incremental)
cam sync --repair              # full re-read
cam projects [--unattributed]  # projects, or the sessions with no project
cam timeline <project>         # timeline across every tool
cam dossier <project>          # everything known about one project
cam recall "<question>"        # full-text search across the conversations
cam get <tool:id[#seqN-M]>     # the full text behind a citation recall printed
cam alias <folder> <project>   # merge two folders into one project
cam attribute <tool:id> <proj> # manual attribution (beats every other signal)
cam reattribute                # recompute without reading any store
cam rebuild                    # rebuild the text index from the sources
cam memory <subcommand>        # long-term memory, see below
cam status                     # when the index last synced, and what it holds
cam doctor                     # status report
cam prune [--vacuum]           # retention: old trace, run log, vanished sources
cam forget --project <p>       # forget one project or one session
cam backup [<file>]            # a verified copy of the index
cam install [--dry-run]        # wire it into the agent tools; cam uninstall undoes it
```

Shared flags: `--json`, `--since` / `--until`, `--tool <tool>`, `--subagents`, `--include-weak`,
`--limit N`, `--db <path>`, `--quiet`, `--verbose`. `cam sync` can be narrowed to one source:
`--tool claude_code`.

Exit codes: `0` success, `1` failure (this is how a scheduled `cam sync` learns that a source could not
be read), `2` bad usage. Of two concurrent `cam sync` runs the second one steps back.

`--quiet` makes a command speak only when something went wrong, which is what an unattended run needs.
It never suppresses the command's own answer: `cam recall --json --quiet` still prints the JSON.

If the database is damaged, `cam doctor` says what is wrong with it. `cam rebuild` reconstructs the
**text index** from the sources — `cam sync --repair` cannot, because it only re-reads what is not yet
indexed, and a contentless FTS index cannot be rebuilt from within the database.

## Running it unattended

```bash
cam sync --quiet                # hourly
cam memory consolidate --quiet  # nightly
cam prune --quiet               # nightly
```

`cam install` sets these three up for you; this section describes what it sets up.

Scheduler recipes for Task Scheduler, launchd, systemd timers and cron, plus retention settings,
backup and restore, and what to do when `cam doctor` complains:
[`docs/operations.md`](docs/operations.md) (Hungarian).

Retention removes the old recall trace, the surplus run log, and — only if you ask — the sessions of
sources that vanished. One rule overrides all of it: **the evidence behind a live promotion is never
pruned**, because a promoted memory has to be able to show which questions brought it back.

`cam forget` removes something from the *index*, not from history: the conversation files belong to
another tool and are never touched, so the next sync indexes them again unless the source is gone too.

## Memory

The hub also learns from what you look up — without a model. A memory becomes long-term not because it
looks important, but because it came back **several times, on several days, to several different
questions**. Every search leaves a trace; consolidation folds that trace, finds the recurring terms, and
promotes what clears the gates (at least 3 recalls, at least 3 distinct questions, score ≥ 0.8).

```bash
cam memory consolidate         # fold the trace, promote what earned it
cam memory list                # the promoted memories
cam memory show <id>           # one memory with the evidence behind it
cam memory topics              # terms that keep coming back
cam memory status              # how much trace has been collected
cam memory dream [--dry-run]   # optional: a sentence per memory, written by a model
```

Deterministic and offline: the same database consolidated twice promotes the same set. A promoted
memory stores no text either — it references a chunk and is rehydrated on read, so the no-duplication
rule survives the memory layer. Details: [`docs/memory.md`](docs/memory.md) (Hungarian).

One optional step does use a model: `cam memory dream` asks a configured command to write a sentence
about each promoted excerpt. It is off by default, never runs from `consolidate`, prints what would
leave the machine before it leaves, and labels every generated sentence with the model that wrote it.
`cam memory dream --dry-run` shows the exact prompt and sends nothing.

## As an MCP server

```bash
cam install    # register it with every client on the machine
cam-mcp        # or start it by hand: stdio, JSON-RPC on stdout
```

Seven read-only tools: `cam_dossier`, `cam_timeline`, `cam_recall`, `cam_get`, `cam_projects`,
`cam_memory`, `cam_status`. Client configuration in [`docs/mcp.md`](docs/mcp.md).

Every response — including error responses — ends with a line saying how old the index is:

```
— index: 2026-08-29 17:37 UTC (1 perce) · 1643 session · 32054 turn
```

Past the staleness threshold (24 hours by default, `staleAfterHours` in the config) the line says so
outright, and the server's instructions tell the agent to report that rather than quote stale data as
current. This is wired into tool registration rather than into each handler, so a tool added later
cannot omit it.

## What it reads

| Tool | Source | Project key |
|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/*.jsonl` + `<id>/subagents/*.jsonl` | `cwd` in the records |
| Codex | `~/.codex/state_5.sqlite` + the rollout files | `threads.cwd` / `session_meta.cwd` |
| Cursor | `<appdata>/Cursor/User/globalStorage/state.vscdb` | file paths from the conversation |
| Cowork | `<appdata>/Claude/local-agent-mode-sessions/**` | `userSelectedFolders` |
| Claude Desktop | `<appdata>/Claude/claude-code-sessions/**` | index + title |
| Cursor history | `<appdata>/Cursor/User/History/*/entries.json` | input of the time correlation |

Formats and their traps: [`docs/sources.md`](docs/sources.md). Design and schema:
[`docs/architecture.md`](docs/architecture.md).

## Privacy

The database holds locators, a contentless full-text index (an inverted index without the text),
metadata (titles, timestamps, working directories), project evidence (file paths), an inline copy of
volatile artifacts, and — since the memory layer — **the text of your own search queries**, because a
promotion has to be able to show which questions brought a memory up (pass `logQuery: false` to keep
only the hash). It does **not** hold the text of your conversations — that stays in the sources.
Nothing is sent anywhere. Dropping `hub.sqlite` removes the whole index and touches no source.

## Development

```bash
npm test          # vitest; no test reads a real store
npx tsc --noEmit  # type check
```

Tests build their fixtures at runtime (Cursor `state.vscdb`, Codex `state_5.sqlite`) from the real DDL,
so a fixture cannot drift away from the code that reads it. The same assertions hold on Windows, macOS
and Linux: path folding is pinned with `CAM_CASE_FOLD` in `vitest.config.ts`, and CI runs on all three
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Status and plan

What is done: [`CHANGELOG.md`](CHANGELOG.md). What the project still has to contain, in order, and what
it deliberately will not do: [`docs/roadmap.md`](docs/roadmap.md) (Hungarian).

MIT licensed — see [`LICENSE`](LICENSE).
