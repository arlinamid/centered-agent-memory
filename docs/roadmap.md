# Plan

What the project has to contain, in what order, and what we will not do.

The order of the milestones is a commitment: each one closes the previous, and
each one says **when it is done** — with a checkable condition, not a feeling.
The "Further directions" section, by contrast, is not a commitment; that is
where the tool may go if it becomes worth it.

We refer to files by name (module and function), not by line number — a line
number goes stale in weeks, a name does not.

## Where it stands

Measured state on the reference machine, 2026-08-29:

| | |
|---|---|
| session | 1,643 |
| turn | 32,054 |
| chunk | 16,448 |
| artifact | 451 |
| project | 133 |
| attributed to a project | 1,387 / 1,643 (84%) |
| database | 57.6 MB |
| test | 454 green |
| repeat sync — collectors | ~330 ms |
| repeat sync — end to end (with attribution) | ~4.6 s |

That snapshot is the last full census. Since then Gemini CLI, Devin CLI and
Antigravity are in the index, Cascade bodies are fetched on demand, and the
suite is 606 tests. Details: [`CHANGELOG.md`](../CHANGELOG.md). Architecture:
[`architecture.md`](architecture.md). Operations:
[`operations.md`](operations.md).

**Done (M1–M6, then the extra sources):** the collectors above, eighteen CLI
commands, seven MCP tools, an incremental index, project recognition with
autodetect, an attribution cascade, full-text search with Hungarian handling,
an installable package, the deterministic memory layer, unattended operation
(scheduling, freshness signal, retention, backup), wiring with a single
command into every agent tool found, a public release with CI checked on
three platforms, and on-demand Cascade fetch from a live language server. On
top of that, a single optional, off-by-default step uses a model: the dream
phase.

---

## Principles that will not change

**Reference, not a copy.** A turn stores *where* its text is (file + byte
offset + JSON pointer, or an SQLite key); `chunks_fts` is contentless. Hit
text is read back from the source at query time, and if the source has since
changed or vanished, the response says so.

**No guessing.** A session whose project cannot be determined stays
`unattributed`. Every verdict carries the method and the confidence; weak hits
are filtered out by default.

**Never writes to the sources.** Every foreign store is opened read-only. This
is not a matter of discipline, but a structural guarantee
(`openSourceReadonly`).

### Deliberately dormant parts

These are **not gaps** — do not "fix" them:

- **`chunk_embeddings`** — the table exists, empty. It waits for semantic
  search (see Further directions). Until there is an embedding, it should be
  neither filled nor read.
- ~~**`recall_events`**~~ — no longer dormant: the M3 memory layer promotes
  from it ([`memory.md`](memory.md)). It was right that it collected from the
  first day.

---

## M1.5 — Consolidation ✅

**The goal was:** what exists today should be true, tested, and operationally
sound.

Closed. The itemised list is in the [`CHANGELOG.md`](../CHANGELOG.md) M1.5
section; what remains here is only what the milestone required:

- `cam recall --json "question"` and `cam timeline --subagents <project>`
  work — argument parsing knows per command which flags take a value
  (`src/args.ts`), and a mistyped flag is an error.
- `--limit` is live on all four query commands.
- Exit code: `0` / `1` (failure) / `2` (bad usage). A scheduled `cam sync`
  notices when something broke.
- Of two concurrent `cam sync` runs the second exits; delete-then-reload is
  in a transaction everywhere.
- On a corrupt database `cam doctor` runs, diagnoses, and suggests
  `cam rebuild`. `cam rebuild` rebuilds the contentless text index from the
  sources.
- The claims in the README and `architecture.md` match the code;
  `turns.inline_text` and the two unused locator kinds are marked reserved
  in both the type and the schema.
- 255 tests green, including the blind spots the plan named: CLI, argument
  parser, lock, attribution cascade, Cursor file history, migration, chunker,
  the confidence asymmetry of `recall`, the `stale` path.
- Path folding (`CAM_CASE_FOLD`) pinned in the test suite, POSIX path
  extraction fixed, the disappearance of a versioned store name warned.

**What of this is still open:** the CI (`.github/workflows/ci.yml`) is
written, but the Linux and macOS runs can only be confirmed after the first
push. Until they have run green, portability is a claim, not a fact.

---

## M2 — Release ✅

**The goal was:** installable on someone else's machine, a standalone tool.
Details in the [`CHANGELOG.md`](../CHANGELOG.md) M2 section.

The milestone conditions, measured:

- Installed from a packed tarball into an empty project, `cam` starts and
  prints the help; `cam-mcp` answers the `initialize` request.
- Two successive runs see the same index: the default location is the user
  data directory (`LOCALAPPDATA`, or `XDG_DATA_HOME`), not the install
  directory.
- `npm pack`: 62 files, 157.5 kB — dist JS, `docs/`, `assets/skill.md`,
  README(s), CHANGELOG, LICENSE. No source, no test, no source map. (At M2:
  41 files, 76 kB; the difference is M4 and M5.)
- The documentation has no machine-specific path to copy. Since M5 this is
  stronger: the absolute path is not copied in by the user, but written by
  `cam install`, from the machine it runs on. No file in the repo contains a
  real username, machine-specific folder, or project name — the test fixtures
  work with invented paths.

**One deliberate departure from the plan:** `private: true` **stays**, even
after the repo became public. The plan prescribed removing the field, but that
was about the public **npm registry**, not repo visibility. The release
channel is still the GitHub release and the tarball; the field thus does
exactly one thing, and does it well: it prevents an accidental `npm publish`.
If it ever actually goes on the registry, that is the one line to delete.

---

## M3 — Memory layer ✅

**The goal was:** the hub should not only find the past, but learn from it —
without a model.

Done, with the structure the plan specified: short term (`recall_events` +
`memory_queries`), consolidation (Light → REM → Deep), a promotion score with
the given weights and gates, long term with a character budget, `cam memory`
commands and a `cam_memory` MCP tool. How it works:
[`memory.md`](memory.md).

The milestone conditions:

- **A promoted fact can be displayed together with its evidence.**
  `cam memory show <id>` prints all six components of the score, and row by
  row which question recalled it how many times and from when to when.
- **The pipeline runs end to end without a network.** Nothing in it
  networks; 7–19 ms on the real index.
- **Running twice from the same database produces the same promotion.**
  Tested; for this the age of a promotion comes from the trace, not from the
  clock — without that a dropped, then re-promoted memory would jump to the
  front of the queue, and the two runs would differ.

Two things that came out along the way:

- **`recall_events` only stored the question hash**, and "on which questions
  it came up" cannot be shown with a hash. So a new table (`memory_queries`)
  keeps the question text and the words parsed out of it. This expands what
  is in the database — see the Privacy section — and can be turned off
  (`logQuery: false`), the hash stays.
- **The 0.8 gate is stricter than it looks.** The smallest passing trace is
  three questions on three days, with a good hit score (0.834). On a small
  corpus bm25 does not spread, so the tests work with the 0.90–0.93
  relevance measured on the reference machine, not one measured on a
  fixture.

---

## M4 — Operations ✅

**The goal was:** remain usable unattended. How to operate it:
[`operations.md`](operations.md). Itemised list in the
[`CHANGELOG.md`](../CHANGELOG.md) M4 section.

The milestone conditions, measured:

- **Sync runs unattended, and reports a failure with a non-zero exit code.**
  A scheduling recipe for all four platforms
  ([`operations.md`](operations.md)), and `--quiet`, which speaks on error
  and otherwise stays silent. `--quiet` does not swallow the command's
  *answer* — a `cam recall --json --quiet` that printed nothing would be a
  trap.
- **Every MCP response contains the index's age.** Not as a matter of
  discipline: tool registration goes through a wrapper, so there is no way
  to register a tool that omits it. It is on the error responses too.
  Checked with a real stdio client on all seven tools
  (`scripts/mcp-smoke.ts`).
- **The database size is bounded: the retention rule measurably bites.**
  `cam prune` on the trace, the run log, and sessions whose source vanished,
  `cam prune --vacuum` for the space, `cam forget` for a project or session.
  `--dry-run` gives the same numbers as the live run.

Five things that came out along the way:

- **`cam recall` citations could not be opened from the CLI.** The
  `cam_get` MCP tool existed, its CLI counterpart did not — half of search
  from a terminal was a dead end, and this only came out on real data, on a
  "what did we last say about this" question, because the tests exercised
  both surfaces separately and nobody looked at the asymmetry between them.
  `cam get` fills this; the citation parser and the turn renderer moved into
  the query layer so the two surfaces cannot diverge.

- **`resolveFileEvents` was slow not because of resolution, but because of
  writing.** The suspicion was the re-resolution of 6,064 paths; the reality
  was that the old code issued 6,064 separate `UPDATE`s against the
  `file_events` table, which had no index on the `resource` column — 6,064
  full table scans over 34,567 rows. Measured on the reference machine's
  index: **14,982 ms → 228 ms**. The index does most of it, the `path_keys`
  cache the rest (804 ms → 128 ms for the whole phase). Repeat sync went
  from ~26 s to ~4.6 s, of which ~3.5 s is attribution — the next bottleneck
  is there, not here.
- **Retention cannot delete everything that is old.** A promoted memory's
  claim is that it can show when and on which questions it came up. If prune
  emptied its `recall_events`, the claim would become false while the memory
  stayed. So the evidence behind a live promotion stays regardless of age;
  only demotion can let it go.
- **A missing source is not enough reason to delete.** An unmounted external
  drive looks exactly like a source that is gone for good. `missingDays` is
  therefore `0` by default: off.
- **`sync_runs.sources_synced` never counted sources, it counted sessions.**
  The freshness report brought it out. The column stays (we do not delete
  and do not rename), new runs write into `sessions_seen`.

**One deliberate extension beyond the plan:** the case-fold stamp from
Further directions went in. Without it `cam backup` produces a copy that
silently finds nothing on another platform, and that is exactly the failure
the appearance of the backup feature introduces.

---

## M5 — Wiring ✅

**The goal was:** four clients' four kinds of configuration should not be on
the user. How: [`install.md`](install.md). Itemised list in the
[`CHANGELOG.md`](../CHANGELOG.md) Install section.

This milestone was not in the plan, and its place is obvious anyway: M2
achieved that the package is **installable** on someone else's machine, not
that it actually gets used there. Between the two there are four config files
to edit by hand, and that is exactly where an otherwise finished tool stops.

The milestone conditions, measured:

- **One command, and the server is in all four clients.** `--dry-run` prints
  the same plan the live run would execute — from the same function, not a
  separate branch. A second run prints `unchanged`, and does not make another
  backup.
- **Foreign configuration is not damaged.** Measured on a real Cursor
  config: 10 servers → 11, the existing ones and the tokens in them
  unchanged, a backup before the operation. In the Codex TOML the replace is
  at the text level, so comments and formatting survive. A corrupt config is
  not overwritten: the command names it, continues with the others, and
  exits `1`.
- **The wired command actually starts.** Checked with a real stdio client,
  with the command line written into the config, on all seven tools
  (`scripts/mcp-smoke.ts`).
- **The schedule is not only registered, it also runs, and writes the right
  index.** Registered from a global install, started by hand:
  `LastTaskResult: 0`, and the run wrote 205 new turns into the user data
  directory's index. The second `cam install` says `nothing to do`; run from
  another copy it does not take the job over, but names the current owner
  and exits. `cam uninstall` takes it down without a trace.
- **The dream model only goes into the config if it answered.** The
  installer sends a short prompt, and leaves the setting empty naming the
  error if no reply came.

Five things that came out along the way:

- **The globally installed CLI did nothing, and exited zero.** The entry-
  point check compared `import.meta.url` raw against `process.argv[1]`, but
  Node returns the first with symlinks resolved. A Node version manager puts
  a link exactly there (`C:\nvm\current` → `…\nvm\v22.21.1`), so the two
  values never matched. From the checkout everything worked, the installed
  copy was a silent no-op — and because the exit code was zero, as a
  scheduled task this looked like a successful hourly run, with an empty
  result. This bug came into use exactly with the install, and exactly on
  the surface the test suite could not exercise: every test imports from
  source, where there is no symlink in the path.

- **Install from `npx` cannot be fixed, only refused.** The plan's entry
  point was `npx github:...`, and both possible entries from there are a
  lie: `npx` unpacks into the npm cache, which npm later collects, and puts
  its own `node_modules/.bin` on the `PATH` for the duration of the run.
  Measured: under `npm exec` the `_npx/<hash>/node_modules/.bin` really is
  on the `PATH`, so a " `cam-mcp` is available, write it that way" decision
  would pick exactly the worst option. This kind of failure does not show
  up at install time, but weeks later, silently. The installer therefore
  detects the temporary package directory, writes nothing, and suggests
  `npm i -g`. The same argument also killed the bare `cam-mcp` entry for
  durable installs: the client is not started by the installer's shell.

- **`PATH` order is a bad tie-breaker.** A tool can be installed twice —
  from npm and as a native release, at different versions — and on the
  development machine the Codex behind the npm shim that stood in front was
  the broken one. On Windows, moreover, an npm CLI is three files (`tool`,
  `tool.cmd`, `tool.ps1`), and none of them is the program: since Node
  18.20 it will not even start them without a shell. The search therefore
  walks the whole `PATH`, reads through the launchers, and lands on either
  a native executable or `node <script>`. Not cosmetics: what we write here
  is later run by a scheduled task that has no shell and no `PATH`.
- **The dream could feed itself back.** Codex and Claude Code write a
  session file by default, which `cam` itself indexes — without this the
  next sync would read the dream prompts, the next dream would summarise
  them, and the index would slowly fill with its own reflection. Hence
  `--ephemeral` and `--no-session-persistence` in every template where
  `cam` has a collector for the tool. The same reason requires turning off
  tool access: these are coding agents, and left to themselves they start
  reading files for a question to which we just handed them the text.
- **`appSupportDir` used the environment variable instead of the given
  profile.** `APPDATA` and `XDG_CONFIG_HOME` describe the running process's
  profile; called with another home they silently redirected back here. A
  fixture-directed install would thus have written into the real Claude
  Desktop config — the test brought it out, seeing Claude Desktop as
  installed even in an empty temporary home.

---

## The dream phase — outside the plan, on purpose ✅

The plan said a generative summary can only be an explicit opt-in. This is
that.

M3 explained why a model does not decide what goes into long-term memory: the
measured failure mode is that an LLM-dependent pipeline simply stops
producing (Codex's own failed on this machine on 17 of 58 jobs, and has been
stopped since July). That argument is about the **decision**, not the
description. What determinism cannot give is a sentence about what a recalled
excerpt is about — `cam memory dream` writes that, and does nothing else: it
does not promote, does not demote, writes no evidence table. How:
[`memory.md`](memory.md#the-dream-phase-optional).

What keeps this from contradicting the reasoning above:

- **The core does not depend on it.** If you never run it, nothing is
  missing; if it fails, nothing stops. Every error is recorded per memory,
  the command exits non-zero, and it can be retried tomorrow.
- **The model is configuration, not code.** Any command that reads a prompt
  and writes text will do, so changing models is not a compile — and there
  is no built-in provider it would connect to by default.
- **The privacy claim did not get weaker, only more precise.** The command
  prints before sending how many characters go out and where, even with
  `--quiet`; `--dry-run` shows the exact prompt and starts nothing.
- **Generated text is always labelled.** The model name is next to the dream
  sentence in the output of `cam memory list`, `cam memory show`, and
  `cam_memory`. Derived text, which can be wrong, and droppable at any time:
  `cam memory dream forget`.

---

## M6 — Going public ✅

**Done, because:** the repo is public, CI is green on all three platforms, and
the `v0.5.0` release tarball installed on all three before it was created.

This milestone was not in the plan, because the project was built for a single
machine. Going public demands only two things, but both strictly: that
nothing leave the author's machine, and that what we release we do not merely
hope works.

**Checkable condition:**

- There is no real username, machine-specific path, project name, or data
  file in the repo. Not by eye: `check-privacy.mjs` checks every CI run, and
  fails if it finds one.
- The tarball behind the tag installs on all three platforms, and the
  installed copy **answers** (does not merely start).
- The package has no source, test, or source map.
- The version is the same in `package.json`, `SERVER_VERSION`, and the
  changelog.
- Install does not require a C++ compiler on any platform.

**What we learned along the way:**

- **The denylist writes itself out.** The first privacy check grepped for
  the author's name and the real project names. In a public file that
  publishes exactly the strings it wants to exclude. The usable version is
  structural: every home-directory name has to **look like a placeholder**.
  It does not list the bad cases, it describes the shape of the good case —
  so it does not go stale, and does not leak.
- **Cleaning the working tree is not enough.** The diffs of old commits
  carry the same traces, and a `git grep $(git rev-list --all)` brings them
  all up. At eight commits the cheapest and only complete solution is a new
  public history that starts from a single commit.
- **`cam --help` proves nothing.** The silent no-op found in M5 (the
  entry-point check compared a resolved path to an unresolved one) would
  have let the help through too. CI therefore requires that `cam status`
  **print something** — a command that exits zero and stays silent can only
  be caught that way.
- **`npm link` is not an install.** The global test installs from a tarball,
  because both `link` and `install -g .` link back to the checkout; such an
  "install" says nothing about whether the package stands on its own.
- **The first run found three bugs, and all three were on a platform I
  could not run during development.** A Node 24 native crash in
  `better-sqlite3` (11 → 13, N-API), a test that looked at the platform
  instead of the setting, and a fixture that worked with an unresolved temp
  directory where `/var` is a symlink. None of these would have come out of
  "it works on my machine" — that is the whole justification of the matrix,
  in a single run.
- **A green step that proved nothing.** I put a second test run into CI
  with path-folding reversed, and it was green — because the `env` of
  `vitest.config.ts` overrode the shell's, so the same thing ran twice.
  When after fixing the override it finally actually ran, 32 tests failed,
  and none of them was a product bug: the suite deliberately pins the fold
  so it is platform-independent, so it asserts literally lowercased paths.
  I took the step out, I did not force it green — the fold is covered where
  it makes sense (`normalizePath` with a parameter, both values).
- **The second run found a bug that would have hit users too.** The native
  dependency ships a prebuild for every platform, yet npm still runs the
  built-in `node-gyp rebuild` on it; and node-gyp on Windows looks for
  Visual Studio even when `binding.gyp` would produce an empty project. On
  a machine without a compiler this fails the install on a compile that is
  not needed. CI and the README both install with `--ignore-scripts` —
  this would never have shown up on the local machine, because npm 11
  blocks install scripts by default anyway.

---

## More sources — after M6 ✅

**The goal was:** the tools this machine actually uses should be in the
index, without pretending we can read what we cannot.

Closed as 0.7.0 (Gemini CLI, Devin CLI, Antigravity metadata + on-demand
bodies) and 0.8.0 (Devin Cascade `get`). Itemised list:
[`CHANGELOG.md`](../CHANGELOG.md). Formats and traps:
[`sources.md`](sources.md).

The conditions:

- **A source we cannot decrypt is not half-indexed as empty.** Antigravity
  and Devin desktop keep conversations encrypted. `cam sync` records that
  they exist. The body arrives only when someone asks (`cam get` /
  `cam_get`), from the language server the app already runs. A closed app
  is a normal answer, not a failure, and nothing here starts a daemon.
- **The same RPC module serves both surfaces.** Antigravity puts
  `--csrf_token` on argv; Devin puts `WINDSURF_CSRF_TOKEN` in the process
  environment. Port discovery and env reading are the same shape on
  Windows, Linux and macOS. Every live daemon is asked, because the first
  one may be the other app.
- **A Devin CLI session is not overwritten.** That store is readable
  SQLite. Citations stay `devin:<id>`; the Cascade path no-ops when the
  session already has a `sqlite_row` source.
- **`cam install` writes Gemini, Antigravity and Devin** without adding a
  second skill copy Devin would list twice.

---

## Further directions

**These are not commitments.** They come up if daily use demands them.

- **Semantic search.** `chunk_embeddings` is waiting for this. Rank fusion
  next to FTS; the research says an FTS and vector hybrid is cheap and fast
  (~21 ms at 50 thousand chunks), while graph-based memory is expensive and
  slow. A local model or a service — the latter contradicts the "nothing
  leaves the machine" principle, so only as an explicit opt-in.
- **Sync across machines.** The case-fold stamp went in with M4
  (`meta.path_case_fold`), so a copied database no longer returns a silent
  empty result: `cam doctor` and `cam_status` say what is wrong. What is
  missing is the actual merge between two machines' indexes — that is not
  a copy, but conflict handling.
- **Further tools**: Zed. Gemini CLI, Antigravity, Devin CLI and Devin
  desktop / Windsurf Cascade are now sources rather than directions —
  Gemini CLI is both a model (dream phase) and a source. Cascade bodies
  stay encrypted on disk and are fetched on demand from the live language
  server; see [`sources.md`](sources.md#cascade-bodies-on-demand).
- **Bringing artifacts into search.** `artifacts.inline_text` today holds
  264 rows of copied scratchpad and Cowork content that **nothing reads** —
  `cam recall` does not find into it.

---

## What we will not do

- Not a chat client: the hub does not start and does not continue a conversation.
- Never writes to the source stores.
- Conversation content does not go to the cloud.
- No telemetry.

---

## Privacy and retention

This tool indexes the user's **entire conversation history**, so it is worth
knowing exactly what goes into the database.

**What is in it:** locators (file and offset, or an SQLite key), the full-text
index (contentless FTS — an inverted index, without the text), metadata
(titles, timestamps, working directories), project evidence (file paths), an
inline copy of the volatile artifacts, **Cascade speech fetched on demand**
(`turns.inline_text` — there is no file to point at), and **the text of your
own search queries** (`memory_queries`) — since M3, because the evidence
behind a promotion has to be showable. The last of these can be turned off:
`recall` with `logQuery: false` writes only the question hash.

**What is not in it:** the text of the conversations that still live in a
readable source. That stays there; the hub only finds it. The Cascade
exception is still local: it never leaves this machine.

**What leaves the machine:** by default nothing; the core does not network.
There are exactly two exceptions, and both are explicit opt-ins.

1. `cam memory dream` sends the promoted excerpts to the configured model.
   There is no default model, `consolidate` never calls it, and the command
   prints **before sending** how many characters go out and where — even with
   `--quiet`. Details: [`memory.md`](memory.md#the-dream-phase-optional).
2. `cam update` asks GitHub whether there is a newer release. It is off until
   the config file says `{"update": {"enabled": true}}`, it prints the URL it
   is about to contact **before** contacting it — again even with `--quiet` —
   and the request carries nothing about this machine: no identifier, no
   version ping, no telemetry. `cam update --dry-run` answers "what would you
   contact?" without contacting it at all.

Until you turn one of those on, "nothing leaves this machine" is true as
written.

**Deletion:** the whole index can be dropped (`.data/hub.sqlite`), this does
not touch the sources. Granularly: `cam forget --project <key>` or
`cam forget <tool:sessionId>` forgets a project or a session, and `cam prune`
takes the old search trace and the run log. Both delete only from the index —
the conversation files belong to someone else, and a later `cam sync`
reindexes them if they are still there. Details:
[`operations.md`](operations.md).

---

## Wiring another tool

1. Implement the `Collector` interface (`src/collectors/types.ts`). Every
   path, database opener, and clock arrives through `CollectorCtx` — the
   collector never calls `os.homedir()` directly.
2. Watermark: `classifyFile` for a file-based source, `ext_version` for a
   version-based one. The goal is that an unchanged source costs zero reads.
3. Locator, not a copy: the turn stores the text's location, and the
   `Hydrator` has to be able to read it back. `inline` is only for a source
   with no readable file (volatile artifacts, Cascade RPC). An encrypted
   store is not a collector of bodies — metadata in `cam sync`, fetch on
   `cam get`, in `src/sources/`.
4. Evidence: if the source has a working directory, that is the `cwd`; if
   not, paths from the content (`replaceEvidence`).
5. Fixture: build the store **at runtime** from the real DDL (see
   `test/helpers/`), do not commit a binary sample — so the fixture cannot
   drift from the reader code.
6. Document the format and its traps in [`sources.md`](sources.md).

---

## Versioning and migration

- **SemVer.** The schema and the CLI surface are the contract.
- **Schema:** every DDL is a conditional create, so a new table, index, and
  trigger appear on their own. A column can only be added by
  `src/db/migrate.ts` — additively and idempotently. We **do not delete** a
  column and do not rename one; if needed, we add a new one.
- **Attribution:** `rule_version` signals when the cascade rules have
  changed. `cam doctor` prints the drift, and `cam reattribute` fixes it —
  without reading any store.
- **A full reindex** is needed if and only if a locator's meaning changes.
  Then `cam sync --repair` is the designated path, and it has to be said
  separately in the CHANGELOG.
