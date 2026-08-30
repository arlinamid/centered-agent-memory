# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/), versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [0.6.0] — 2026-08-30

> **Breaking change:** the supported Node floor rose from 22 to **24**. Anyone running Node 22
> has to upgrade before switching to the next release.

### CLI, MCP, skill and docs speak English

**Where it came from:** the product UI, MCP tool titles and descriptions, the skill body, the
freshness footer, installer messages, the public docs, CI job names and GitHub script errors were
Hungarian. A user who does not speak Hungarian would hit those first.

- **They are now English.** The CLI answers, the MCP titles and descriptions, the skill, the
  freshness line, the installer, the public docs, the CI job names and the GitHub script errors.
  Installing, wiring and querying no longer requires translating the product first.
- **`README.hu.md` and `docs/*.hu.md` remain the Hungarian pair.** The English `README.md` and
  `docs/*.md` are the default; the `.hu.md` files stay for readers who want them.
- **The README is a screening surface, not an essay.** First screen: one sentence, a real
  `cam dossier` / `cam recall` transcript, the measured numbers, a mermaid of the four
  sources into one index. Install is six copy-paste lines; the tarball / `npx` / config
  caveats sit in `<details>` and GitHub alerts. The command dump and the privacy inventory
  fold away. Same skeleton in `README.hu.md`.
- **Search still matches Hungarian corpus text.** Accent folding, Hungarian stopwords, keywords
  like `projekt` / `kód` / `fájl`, and relative dates like `tegnapelőtt` are unchanged. The corpus
  is what people actually said.
- **Fixture conversation text in tests stays Hungarian.** That is what the collectors index;
  translating it would test a corpus that does not exist.
- **`[Nem kiadott]` is now `[Unreleased]`.** The heading follows Keep a Changelog.

### A new package.json version becomes a GitHub release

**Where it came from:** a push to `main` does not publish; a `v*` tag does. That is still
the promise. What was missing is the step that turns a bumped version into that tag
without a local `git tag`.

- **Source of the version is `package.json`.** `package-lock.json` only has to agree — its
  root `version` is a copy npm writes when you bump the package. Versioning from the lockfile
  would version the dependency graph, not the tool.
- **CI green, then tag.** `Cut release tag` runs after the CI workflow succeeds on `main`.
  If `v$version` is already a release or a tag, it exits quietly. If the changelog still
  says `[Unreleased]` and not `## [x.y.z]`, it fails — the notes script reads that section.
- **The Release workflow is unchanged.** The tag still has to install on Windows, macOS and
  Linux before `gh release create` runs.
- **A fix does not sit on `main` under yesterday's number.** If `package.json` still names a
  released version and HEAD is ahead of that tag, the same job bumps the patch — or the
  minor, when `[Unreleased]` contains a breaking note — writes the lockfile,
  `SERVER_VERSION` and the changelog section, commits, and tags. An explicit bump still
  wins when the number is already new.
- **The version has to be in every reader-facing place.** `check-version.mjs` requires
  `package.json`, the lockfile, `SERVER_VERSION`, `## [x.y.z]` in the changelog, and a
  `cam-vX.Y.Z` badge in both READMEs. CI fails, and the tag is not pushed, if one is
  missing. The bump rewrites the badge with the new number.

### The skill can also be installed with `npx skills add`

**Where it came from:** Claude Code Desktop reads `~/.claude/skills/`, and the [skills](https://skills.sh)
CLI installs there: `npx skills add <repo> --skill <name> --agent claude-code`. Our skill, though,
was `assets/skill.md`, with a placeholder — the CLI does not find that.

- **`skills/agent-memory/SKILL.md`** is the discoverable, frontmattered, finished skill. That is what makes this work:

  ```
  npx skills add arlinamid/centered-agent-memory --skill agent-memory --agent claude-code -g -y
  ```

- **Classic Desktop / Cowork still does not get a skill from this.** There is no `claude-desktop` agent in
  the skills CLI, and Cowork does not pick up a file copied into the folder — only the Customize UI
  uploader. `cam install` still only wires MCP there.
- **`cam install` does not call `npx`.** That is the public, networked path. Our own installer
  is offline, and writes to the same place.
- **The body was renamed to `assets/skill-body.md`.** On Windows `skill.md` is the same as
  `SKILL.md`, so the skills CLI treated the template as a skill too, and skipped it with a warning.

### Node 24 is the floor, and CI finally starts on a runtime that is not EOL

**Where it came from:** every CI job warned that the actions target Node 20. It turned out
we were not one major behind, but three.

- **`actions/checkout` and `actions/setup-node` v4 → v7.** The v4 runtime is Node 20, which has been EOL
  since April 2026, and GitHub was already forcing it onto 24. The intervening majors' breaking
  changes do not affect us: v5 brought node24 and automatic package-manager caching (we
  set `cache: npm` explicitly, so for us it is a no-op), v6 narrowed that to npm, and v7
  switched to ESM and blocks fork-PR checkout on `pull_request_target`/`workflow_run` —
  CI runs on plain `pull_request`.
- **Test matrix 22+24 → 24+26.** Node 26 has been Current since May, and becomes Active LTS on
  October 28. Testing the next LTS while it is still Current is exactly the step that would have
  caught the `better-sqlite3` Node 24 crash weeks earlier — that bug caught me by surprise
  because it showed up on a runtime I could not run locally.
- **The install job also runs on both majors, on three OSes.** This is not for symmetry: the only
  bug that ever reached this job was a native binding that installed fine on one Node major
  and aborted with `SIGABRT` on the next. That is an install-time fault, so this is where
  both majors have to be exercised.
- **`engines.node` `>=22` → `>=24`, `@types/node` `^22` → `^24`.** The two move together on
  purpose: the types are pinned to the **lowest** supported runtime, because that is what
  stops us from compiling in an API that does not exist on a machine our own `engines` field
  claims to support. If the types ran ahead of the floor, the compiler would silently let it through.
- **What the floor does not solve.** `>=24` also satisfies an odd, EOL release (e.g. 25.x), so
  npm will not complain. The floor is a lower bound, not a policy: "run on a supported LTS"
  cannot be expressed in an `engines` field.

### An unreadable store is not the same as a missing one

**Where it came from:** the question was whether MCP can break if one of the source tools is not
installed. The answer is no — the server only reads the SQLite index, the collectors start with
`existsSync`, and sync wraps every collector in its own `try/catch`. The review, though, found
two places where the answer was only almost true.

- **Two unguarded `readdirSync` calls patched.** The `cursor-history` and `artifacts` plan branch
  listed the folder bare after `existsSync`. If the folder **exists but is not readable**
  (permissions), the collector threw. Sync caught it, so there was no crash — but a
  permission error still produced exit code 1, with no test.
- **The return value is `null`, not an empty list — and that is the point.** `cursor-history` mirrors
  the folder: it wipes the whole `file_events` table and writes back what it just read. If a read
  error had returned an empty list, it would wipe the attribution input collected by the previous
  sync because of a permission error. That is why `readDirOrNull` distinguishes the two: an empty
  list means "wipe what you have", `null` means "you learned nothing, leave it alone".
- **The error counts; it does not disappear.** "Not installed" is silent and zero; "present but
  unreadable" is `errors++` and a named log line. Only the first earns silence — otherwise the
  second becomes "you have no plan files at all", and nobody finds out it is actually a
  permission problem.
- **Six new tests, including the one that backs the README claim.** Until now not a single test
  ran a full sync with **none** of the tools installed, even though that is exactly what we promise.
  Now all seven collectors run, all report zero, and the run lands in `sync_runs` with zero errors.
  That also required pinning the roots in the config: `CAM_HOME` moves the profile-based stores,
  but the Claude notepad lives in the OS temp folder, so without this the test would have read
  the developer's real machine. The missing-root branch was already handled for the claude-code,
  claude-desktop and cowork collectors, but not proven.
- **One stale comment fixed.** The `cli.test.ts` header still said that a fake home does not
  move the Desktop and Cursor stores. That has not been true since the 0.5.0 `appSupportDir`
  fix, and the new test is built on the opposite.

## [0.5.0] — 2026-08-29

### Public repository — CI, release, and scrubbing the machine-specific traces

**The goal was:** the project had lived on a single machine, and it showed. A tool that indexes
somebody's entire conversation history cannot go public while pointing at paths and real project
names from the author's machine — least of all as test fixtures, where nobody is looking.

- **Every machine-specific trace replaced.** The real project names in the test fixtures, the
  collection-folder path, the Node version-manager install location, and the last name built into
  the launchd label (it became `io.github.arlinamid.cam`) all got invented counterparts. Two
  tests failed from this, and both were right: one expected an underscored name back, the other
  checked alphabetical order of hits. What the swap blurred, I restored by hand; I did not
  adjust the expectation to the output.
- **The ban is structural, not a name list.** `check-privacy.mjs` does not look for whether the
  author's name appears — such a list would publish exactly what it exists to keep out. It
  checks that every home-directory name **looks like a placeholder** (`me`, `dev`, `user`, a
  single letter), and that no data file landed in the repository. The rule stays true for every
  future contributor too.
- **The public history starts from a single commit.** The old 8-commit diff would have carried
  the same traces up, and a `git grep` of the history would find them all. The changelog already
  keeps the development path in more detail than the commit messages; the original history
  stayed local, in a bundle.
- **CI on all three platforms** (`.github/workflows/ci.yml`): type check, tests on Node 22 and
  24, then — and this is the new part — **actually installing the built package** from a tarball,
  and checking that the installed copy *answers too*. `cam --help` also lets a silent no-op
  through, so the step demands that `cam status` prints something; that is exactly the bug
  that happened in production. The MCP server is started separately with `initialize`, on an
  empty index.
- **The test runner limited to two workers on CI.** Most of the suite starts the CLI as a real
  subprocess, so one worker costs much more than usual here; on the slowest runner this once
  starved vitest's own main thread ("Timeout calling onTaskUpdate"), while all
  454 tests still passed. It costs nothing: wall-clock time measured the same, contention
  dropped (115 s → 55 s test time).
- **`vitest.config.ts` no longer silently overrides the caller.** `test.env` is stronger than the
  shell environment variable, so the baked-in `CAM_CASE_FOLD: "1"` quietly discarded a request
  for the other folding. Now it is a default (`process.env.CAM_CASE_FOLD ?? "1"`), not a command.
- **There is no second, inverted-folding full test run — and that is deliberate.** I wrote one,
  then found that because of the override above it never actually ran; when it finally did, 32
  tests failed. None of them were product bugs: the suite deliberately **pins** the folding so
  the same expectation holds on all three platforms, so its assertions spell out lowercase
  paths literally. Run inverted they would only prove they were written for the other setting.
  Making them green would mean rewriting a third of the assertions as derived — that would
  compare the code to itself. Folding is covered where it belongs: `normalizePath` takes it
  as an argument, and `test/projkey.test.ts` calls it with both values.
- **Package contents are checked:** if source, tests or a source map would land in the tarball,
  CI fails. The version appears in three places (`package.json`, `SERVER_VERSION`, changelog
  section), and CI requires that they agree.
- **Release on a tag** (`.github/workflows/release.yml`): the tarball is not built and hoped
  for — it is first installed and started on all three platforms, and the release is only
  created if all three were fine. Release notes are lifted from the changelog, because two
  prose accounts of the same release eventually start disagreeing.
- **`private: true` stays**, even though the repository is public. The release channel is the
  GitHub release and the tarball, not the npm registry — so the field does exactly one thing:
  catch an accidental `npm publish`.
- **The install recipe is more precise:** both `npm link` and `npm install -g .` **link** to
  the checkout instead of copying, so moving the checkout would take the wired clients with
  it. The README now recommends a tarball, and says why.

**What the first CI run found — three bugs, all on a platform I could not run during
development:**

- **`better-sqlite3` 11 → 13.** On Node 24 the process aborted with `SIGABRT` at shutdown
  (`RemoveEnvironmentCleanupHook ... Assertion failed: (env) != nullptr`), from the `Statement`
  destructor. Releases 12 and below are built on the raw V8 `node::ObjectWrap`, which Node
  24.19 gave a cleanup hook; removing the hook fails on an `Environment` that is already gone.
  13.0.0 switched to N-API, so this class of bug was not fixed but **eliminated**. For us that
  is a win beyond CI going green: an N-API build is not tied to a Node ABI, and this tool is
  installed globally under whatever Node version is there.
- **The freshness-warning test looked at the platform, not the setting.** The "index written
  with the other path-folding" case was produced by writing `0` on Windows and `1` elsewhere —
  except macOS folds too, like Windows, so there it did not write the opposite, and the warning
  correctly stayed away. Now it writes the opposite of the actual `CASE_INSENSITIVE_FS`, which
  stays correct in an inverted `CAM_CASE_FOLD` run as well.
- **The installer-test fixture used an unresolved temp directory.** On macOS `/var` points at
  `/private/var`, and `locate` — correctly — returns a resolved path. I did not adjust the
  expectation to the output: the fixture root became resolved, because the installer also
  deliberately writes a resolved path (a scheduled task pointing at a symlink breaks on the
  day the link moves).
- **`--ignore-scripts` at install, and this is not a CI workaround.** `better-sqlite3` 13 ships
  a prebuilt binary for every supported platform in the package, yet npm still runs the
  built-in `node-gyp rebuild` on it. `binding.gyp` then turns itself into a no-op — except
  node-gyp on Windows looks for Visual Studio *first*, in order to generate an empty project.
  On the runner that failed (it did not recognise VS 18), even though nothing needed compiling.
  On a machine without a compiler the same thing would reach the user, so the README and
  `docs/install.md` also install with `--ignore-scripts`. Verified: after a clean
  `npm ci --ignore-scripts` no `build/` folder is created, the binding loads from the prebuild,
  and all 454 tests are green.

---

### Install — one command that wires itself in everywhere

**The goal was:** manual wiring in four clients, in four formats, plus scheduling — that is the
step where nobody starts using an otherwise finished tool. How:
[`docs/install.md`](docs/install.md).

- **`cam install` / `cam uninstall`**, with `--dry-run` and per-part opt-out
  (`--no-mcp`, `--no-skills`, `--no-dream`, `--no-schedule`), globally or with `--project` into
  the repo. The installer also prints **which index** the wired server will use — the
  path is not obvious, and every other part reads this file.
- **We do not install from `npx`, because it cannot last.** `npx` unpacks into the npm cache
  (`_npx/<hash>`) and puts its own `node_modules/.bin` on `PATH` for the duration of the run —
  so the absolute path lives until the cache is collected, and a bare `cam-mcp` only until the
  process exits. Both produce a configuration that looks fine today and later fails to start
  silently. The installer detects the temporary package folder, writes nothing, and suggests
  `npm i -g`.
- **The server always goes into the configuration with an absolute path**, even if `cam-mcp` is
  on `PATH`. Until now we wrote the bare command in that case, even though the client is not
  started by the installer's shell: a desktop app launched from the dock has no login `PATH`.
  The documentation already claimed this — now the code does it too.
- **One package, one schedule.** Task names are fixed, so they could not be duplicated —
  but they could be taken over: a second install would silently point the existing task at
  its own copy, and the previous one would look installed while nothing ran in its name.
  The installer now checks whose registered task it is: same instance, nothing to do;
  another one, it writes nothing, names both commands, and exits `1`. Takeover: `--force`.
  (`scheduleInstalled` already existed, nobody had ever called it.)
- **The background task and the MCP command are written with resolved symlinks.** A Node
  version manager puts a moving link on both the Node binary and the global `node_modules`;
  a task that runs hourly must not change because someone switched versions in a terminal.

### Fixed

- **The globally installed CLI did nothing and exited zero.** The entry-point check compared
  `import.meta.url` to `process.argv[1]` raw, but Node gives the first with resolved
  symlinks and the second the way the shell wrote it. A Node version manager puts a link
  exactly here (`C:\nvm\current` → `…\nvm\v22.21.1`), so the two values never matched: `cam`
  started, ran nothing, and reported success. As a scheduled task that is an hourly green
  run with an empty result. The comparison now happens on resolved paths.
- **Client configurations stay intact.** JSON files are written back with their own
  indentation, in Codex TOML we replace our own table at text level (comments survive), and
  a backup is made before the first change. We **do not overwrite a broken configuration**:
  the command says which one, continues with the rest, and exits `1`.
- **What is not installed, we do not install.** A client announces itself by its own
  directory; without that the command skips it, instead of writing a configuration for a
  tool that is never used.
- **Skill per client**, from a shared body (`assets/skill.md`). MCP wiring alone does not
  make the agent use the index — it uses it when it knows when to. What differs per tool is
  one section: whether there is a terminal, or only the MCP tools.
- **The dream phase gets a model from agent CLIs already on the machine** (Codex, Claude Code,
  Cursor Agent, Gemini, Antigravity, Ollama), and the user picks the model too — Codex
  supplies the list from its own `models_cache.json`, Antigravity from `agy models`, Cursor
  from `--list-models`. **It only goes into the configuration if it answered a live prompt:**
  a template written with a bad flag looks exactly like a working one, until the first
  nightly run.
- **The templates do not let the model touch the disk** (`-s read-only`, `--tools ""`,
  `--mode ask`), and **turn off session saving** where `cam` itself also indexes
  (`--ephemeral`, `--no-session-persistence`) — without that the next sync would ingest the
  dream prompts, and the index would slowly fill with its own reflection.
- **Schedule install** on all three platforms: Task Scheduler, launchd, systemd user timer,
  with hourly sync and nightly maintenance, catch-up enabled everywhere. The planner is a
  pure function, so all three recipes can be tested from a single machine.

#### Fixed

- **The real program behind the `.cmd` shim.** On Windows an npm CLI is three files, and
  none of them is the program; since Node 18.20 it will not even start them without a shell.
  The search now walks the whole `PATH`, reads through the launchers, and lands on either a
  native executable or `node <script>`. This is not cosmetics: `PATH` order is a bad
  tie-breaker when a tool is installed twice (on the development machine it was the npm
  version behind the shim that was broken), and the command written down is later run by a
  scheduled task that has no shell and no `PATH`.
- **`appSupportDir` uses the given profile, not the environment variable.** `APPDATA` and
  `XDG_CONFIG_HOME` describe the running process's profile; called with another home they
  silently pointed back here — that is how a fixture-directed install would have written
  into the real Claude Desktop config.
- **`cam memory dream` takes the reply from a file instead of `stdout`, where the tool can**
  (`codex exec -o`), because `stdout` also has the banner and the token counter.

---

## [0.4.0] — 2026-08-29

### Dream phase — the only place a model works

**The goal was:** determinism cannot say in one sentence what a recalled excerpt is about.
That was the one missing thing, and only this comes near a model. How it works:
[`docs/memory.md`](docs/memory.md#the-dream-phase-optional).

- **`cam memory dream [--dry-run] [--force] [--project p] [--model m]`** and
  **`cam memory dream forget`** (`src/memory/dream.ts`, `memory_dreams` table). It does not promote,
  it does not revoke, it writes no evidence table.
- **Off by default, and `consolidate` never calls it.** Without a model the command sends
  nothing; it says what to configure, and exits `2`.
- **The model is configuration, not code:** any command that reads a prompt and writes text is
  fine (`"memory": { "dream": { "provider": "command", … } }`), so swapping a model is not a
  compile.
- **What goes out, the command says before it goes out** — how many memories, how many
  characters, to which model. This line appears even with `--quiet`: it is not a progress
  indicator, it is a disclosure. `--dry-run` also prints the first prompt verbatim, and starts
  nothing.
- **The output is cached with the input hash**, tagged with the model name, stored apart from
  the sources — you do not pay twice for the same thing, and `dream forget` can drop it any
  time.
- **A crashing model does not take the run with it:** the error is recorded per memory, the
  command exits non-zero, and tomorrow it can be retried. Timeouts belong here too.
- **The generated sentence is never presented as a source:** `cam memory list`, `cam memory show`
  and `cam_memory` all print it together with the model name.

### M4 — Operations

**The goal was:** it should stay usable unattended. How to operate it:
[`docs/operations.md`](docs/operations.md).

#### Added

- **Freshness signal** (`src/ops/freshness.ts`). We have written the `sync_runs` table since the
  first version, and until now nobody read it — which is the same as not having it. From now on
  **every MCP response's last line** says when the index last synced, what it contains, whether
  it is stale, and whether the last run failed. Age comes from the latest **completed** run, not
  the latest row: a crashed run must not make the index look fresh.
- **`cam status`** and the seventh MCP tool, **`cam_status`**: the same report on its own, with
  `--json` too. `cam doctor` also prints it, next to size and the case-folding warning.
- **`cam get <tool:id[#seqN-M]>`** — the CLI counterpart of the `cam_get` MCP tool, which had
  been missing. `cam recall` printed citations (`cursor:217d5d40…#seq16-23`) that nothing in the
  terminal could open: half of search from the CLI was a dead end. The citation parser and the
  turn renderer moved into the query layer with this (`parseCitation` into `recall.ts`,
  `formatTurns` into `format.ts`), so the two surfaces give the same text and the same error
  cases. An unparseable citation exits `2`, a session that does not exist exits `1`.
- **`cam prune`** — retention for old recall evidence, the run log, and sessions whose source
  has gone missing. `--dry-run` gives the same numbers as a live run; `--vacuum` also gives the
  space back. Configurable in the config (`retention`) and with flags (`--recall-days`,
  `--keep-runs`, `--missing-days`).
- **`cam forget --project <key> | <tool:sessionId>`** — forget a project or a session from the
  index, together with its promoted memories. It does not touch the source files.
- **`cam backup [<file>]`** — a checked, standalone copy via the SQLite online backup API, with
  `--json` output. Afterwards it opens the copy, `quick_check`s it, and folds the WAL; if the
  check finds an error it exits `1` and does not call it a backup.
- **`--quiet` and `--verbose`** on every command (`src/log.ts`). `--quiet` talks on error,
  otherwise stays silent; it never swallows the command's *answer* — a `cam recall --json --quiet`
  that printed nothing would be a trap. `--verbose` gives per-phase timing for sync.
- **Scheduling sample for all four platforms**: Task Scheduler, launchd, systemd timer, cron —
  [`docs/operations.md`](docs/operations.md).
- **Case-fold stamp** (`src/db/portability.ts`, `meta.path_case_fold`). An index written on
  Windows stores lowercase paths; opened on Linux it finds **nothing**, silently. `cam backup`
  brought this failure mode in, so the index marks itself, and `cam doctor` and `cam_status`
  compare it with the running system and say what to set.
- **`npm run smoke`** (`scripts/mcp-smoke.ts`) — drives the released MCP server as a real stdio
  subprocess against the real index, and checks that all seven tool replies carry the index
  age, error replies included. It asks the server for the tool list, so an untested tool is
  caught too.

#### Fixed

- **`resolveFileEvents` was slow because of the writes, not the resolving.** The plan suspected
  re-resolving 6 064 paths; the reality was that the old code issued 6 064 separate `UPDATE`s
  against `file_events`, which had no index on the `resource` column — 6 064 full table scans
  over 34 567 rows. With the new `idx_fe_resource` index and a single set-based `UPDATE`,
  measured on the reference machine's index: **14 982 ms → 228 ms**. The `path_keys` cache
  takes the rest (the whole phase 804 ms → 128 ms), and survives the daily reload of the
  Cursor file history, which until now zeroed the computed `project_key`. `cam reattribute`
  asks for a full recalculation, because a new alias changes what a path resolves to.
- **`sync_runs.sources_synced` never counted sources; it counted sessions.** The freshness
  report brought this out. The column stays with its historical values (we do not drop or
  rename a column); new runs write into `sessions_seen`. Schema version 3 → 4.

#### What retention does not do

- **Live promotion evidence cannot be deleted.** A promoted memory's claim is that it can show
  when and on which questions it came up; if prune emptied its `recall_events`, the claim would
  become false while the memory stayed. So a chunk that appears in `memory_facts` keeps its
  evidence regardless of age, and only a revoke lets it go.
- **A missing source is not, by default, a reason to delete** (`missingDays: 0`). An unmounted
  external drive looks exactly like a source that is gone for good.
- **`cam forget` deletes from the index, not from history.** The conversation files belong to
  someone else; a later `cam sync` reindexes them if they are still there.

#### Measurements (reference machine, 2026-08-29, after M4)

1 643 session · 32 054 turn · 16 448 chunk · 451 artifact · 57,6 MB.

| phase | M3 | M4 |
|---|---|---|
| collectors (all seven) | ~320 ms | ~330 ms |
| `resolveFileEvents` | ~20 s | 128 ms |
| `reattribute` | ~4,2 s | ~3,5 s |
| **`cam sync` end to end** | **~26 s** | **~4,6 s** |

The bottleneck is now in `reattribute`, not in the file paths.

**404 tests green** (293 → 404), `tsc --noEmit` clean, `npm run build` OK. New test files:
`test/ops.test.ts` (freshness, retention, forget, vacuum, backup, portability) and
`test/dream.test.ts` (configuration, disclosure, cache, crashing and stuck model, forget).

Coverage **maintains itself** at two points: `test/cli.test.ts` drives every command, and its
list is bound to `SPECS`, so a command added later fails the test until it is driven; and
`test/mcp.test.ts` lists the tool list fetched from the server, so a tool registered later
automatically falls into the index-age check. The dream CLI side (what it refuses without a
model, what it discloses before sending, what it does with `--quiet`) is in
`test/cli.test.ts`; the phase itself is in `test/dream.test.ts`.

## [0.3.0] — 2026-08-29

M1 (first usable state), M1.5 (hardening), M2 (installable package) and M3
(memory layer) together.

### Added

- **Skeleton and database.** TypeScript/Node ESM project (`better-sqlite3`, `vitest`), full schema:
  `sources`, `sessions`, `turns`, `chunks`, `chunks_fts`, `path_evidence`, `attribution`,
  `file_events`, `artifacts`, `recall_events`, `sync_runs`. `chunks_fts` is **contentless**
  (`content=''`, `contentless_delete=1`, `unicode61 remove_diacritics 2`), so the inverted index
  exists and the text does not — that is what makes the "we do not duplicate" rule real.
- **Platform- and profile-independent store locations.** `appSupportDir()` resolves under
  Windows / macOS / Linux; every path comes from `os.homedir()` and `os.tmpdir()`.
- **Project recognition with autodetect.** Marker-based walk (`.git`, `package.json`, `pyproject.toml`,
  `go.mod`, `CMakeLists.txt`, …) skipping generic folder names; workspace roots are learned from
  the corpus (`detectWorkspaceRoots`); `projects.root_path` survives a project move; alias table
  for the user's decisions. No hardcoded path or profile name.
- **Incremental index.** `sources` watermark table: same size+mtime → zero reads; growing file →
  read from `bytes_indexed`; a fixed-window `prefixHash` distinguishes append from rewrite.
- **Citation, not a copy.** `turns` stores a locator (file+offset, or an SQLite key); `Hydrator`
  reads the text back and writes an `ok` / `stale` / `missing` status.
- **Claude Code collector.** Main and subagent transcripts, only `text` blocks indexed, title from
  `ai-title` / `custom-title` records.
- **Codex collector.** `state_5.sqlite` (`threads`, `thread_spawn_edges`) + rollout files;
  seconds→milliseconds conversion, length-gated title handling, identification by `payload.id`.
- **Cursor collector.** `state.vscdb` with half-open range queries; project evidence from
  `ofsContent` keys and from bubble contents.
- **Cursor file-history collector.** `User/History/*/entries.json` → `file_events`, the input to
  attribution time-correlation.
- **CLI:** `cam sync`, `cam projects`, `cam timeline`, `cam doctor`.

### Fixed

- `prefixHash` uses a fixed window. Previously it hashed up to the file's current size, so every
  append of a short, append-only transcript would have been flagged as a rewrite ("rotated") —
  meaning every sync would have been a full reread.
- Claude Code subagent transcripts carry the **parent** `sessionId` in every record; the
  identifier therefore comes from the filename, otherwise the subagent melts into the parent
  session.
- Project recognition never accepts generated folder names (UUID, ≥16-digit hex, timestamped
  job names, `codex-runs`, `worktrees`) as a project name, and walks further up in that case.
  Without this, 41 junk projects were born from `codex-runs/<hash>` folders.
- Learned workspace roots pass through the excluded-prefix filter (OS temp, agent dotfiles).
- Cursor: conversations without `lastUpdatedAt` (background/cloud threads) were reread on every
  run; now the sha256 of `composerData` is the change signal — but **only if there is no
  timestamp at all**, because editing a bubble's text does not change `composerData`.
- The path extractor "swallowed" the next word (a Windows path name can contain a space), so the
  same path voted twice.

- **Cowork collector.** `local-agent-mode-sessions` meta + transcript; the project comes from
  `userSelectedFolders`; the sandbox `cwd` is recorded as weightless evidence.
- **Claude Desktop enrichment.** Gives a title to untitled Claude Code sessions via
  `cliSessionId`; entries without a local transcript stay as empty sessions.
- **Artifact collector.** Temp scratchpads and Cowork outputs (ephemeral → copy), `~/.claude/plans`
  plan documents (stable → reference, bound to the session by the filename slug).
- **Time-correlation attribution.** Medium/weak-confidence assignment from Cursor file history
  (`file_events`) for threads that mention no path at all.
- **Search layer.** HU/EN stopwords, prefix matching because of agglutination, date words
  (`ma`, `tegnap`), length-preserving accent folding, own highlighter (contentless FTS
  `snippet()` is NULL).
- **Queries:** `recall`, `timeline`, `dossier`, `getTurns` — with shared rendering between CLI
  and MCP. `recall` logs hits (`recall_events`) so the later memory layer has something to
  promote from.
- **MCP server.** Five read-only tools (`cam_dossier`, `cam_timeline`, `cam_recall`, `cam_get`,
  `cam_projects`) on the SDK's `StdioServerTransport`, tested with `InMemoryTransport`.
- **Full CLI:** `sync`, `projects`, `timeline`, `dossier`, `recall`, `alias`, `attribute`,
  `reattribute`, `doctor`.
- **Documentation:** `docs/architecture.md`, `docs/sources.md`, `docs/mcp.md`.
- **Plan** (`docs/roadmap.md`): what the project must contain, broken into milestones, each
  with a checkable "done when" condition. Includes the then-known gaps (M1.5), the release
  conditions (M2), the memory layer (M3), operations (M4), the privacy stance, and which
  parts are asleep on purpose.

### Fixed (continued)

- Highlighting slipped after every accent: NFD-based accent stripping changes the text
  length, so positions found in the folded string did not match the original. Comparison is
  now **length-preserving** (one character per character).
- Cursor bubbles carry no timestamp, so every Cursor turn's `ts_ms` was null, and `--since`
  filtering did not work on them. The hub does not invent a per-turn time: the chunk timestamp
  falls back to the session start.
- Codex sessions run repeatedly from the same prompt filled the dossier "recent topics" list
  eight times; the list is now deduplicated by title.

### Fixed (from a code review)

Five of a review agent's seven findings were real, silent bug classes — each got a regression
test (`test/regressions.test.ts`):

- **A file rewritten to the same size was lost.** The "unchanged" fast path only looked at size
  and mtime; a file rewritten to the same length within mtime granularity would have been
  skipped **permanently and silently**. The prefix-window hash is now checked on the skip path
  too (one 4 KiB read).
- **A shrinking file slipped behind the watermark.** If the file got smaller between the
  watermark check and the read, `readJsonlFrom` reported "no new content", the watermark moved
  to the smaller size, and the rewritten content was never read again. Now it is flagged as
  rotation, and the watermark is zeroed.
- **Indexing and reread did not filter the same thing.** At index time only `type: "text"`
  blocks counted; at reread the `content[*].text` pointer took every one. The pointer now
  carries the filter itself (`content[*type=text].text`), so the two cannot disagree — otherwise
  every such turn would look permanently "stale".
- **The artifact collector reread everything on every run**, and for each plan walked every
  known transcript (O(plans × transcripts) full file reads, growing without bound). Now it
  skips the unchanged by size+mtime, and looks up a plan's owner only once.
  Measured: 8,1 s → 87 ms.
- **Orphan FTS rows.** `chunks_fts` is contentless and has no foreign key; a `delete from
  sessions` would have cascaded to `chunks` inside SQLite, bypassing the FTS rows. A trigger
  enforces this at schema level.
- Smaller: the `artifacts.tool` field is now written (we passed it, but it was stored
  nowhere); `cam sync` closes the database on the error path too; the `claude-desktop`
  collector does not report already-known sessions as new.

### Added (continued)

- **Migration** (`src/db/migrate.ts`): additive, idempotent column add, so a database created
  with an earlier version still updates. DDL is `IF NOT EXISTS`, so a new table/index/trigger
  appears on its own; only this can add a column.

### M1.5 — hardening

After the first usable state, the [plan](docs/roadmap.md) M1.5 milestone: the existing behaviour
should be true, tested and operationally sound.

**Fixed**

- **The CLI no longer swallows the positional argument.** The old parser consumed the next
  token after every `--flag`, so `cam recall --json "question"` saw zero positionals and
  printed help; same for `cam timeline --subagents <project>`. The new parser (`src/args.ts`)
  knows per command which flag expects a value, handles `--flag=value` and `--`, and reports
  a mistyped flag as an **error** instead of silently dropping it.
- **`--limit` is live everywhere**, not only in `recall`: `timeline` no longer silently cuts at
  200, and `projects` and `dossier` honour it too. A non-number or a zero/negative value is an
  error.
- **Exit codes.** `0` ok, `1` error, `2` bad usage. `cam sync` signals with a non-zero code if
  a source was unreadable — without that a scheduled run could not notice it had broken.
  An unknown subcommand also gives a non-zero code.
- **Manual assignment survives recalculation.** `reattribute` tried to resolve the `manual`
  evidence `raw_path` (`~manual:<key>`) as a path, and it resolved to nothing — so every
  `cam attribute` decision was lost on the next sync. `manual` now — like
  `time_correlation` — carries the verdict itself. `rule_version` 1 → **2**, so
  `cam doctor` reports a mismatch, and `cam reattribute` fixes it.
- **Schema-update order.** `initSchema` migrated *after* the conditional DDL, even though
  `CREATE INDEX IF NOT EXISTS` on a missing column fails even if the index is conditional.
  Migration now runs before the DDL (and after it too), and tolerates a table that does not
  exist yet at all.
- **No leaking database handle.** On a corrupt file `new Database()` still succeeds, the first
  pragma fails — the handle used to stay open and hold the file (on Windows it could not even
  be deleted). Both `openHub` and `openSourceReadonly` close the handle before rethrowing.
- **Portability.** POSIX path extraction also recognises a `file:///home/...` URI (until now
  it required a drive letter, so on Linux Cursor attribution silently fell back to
  time-correlation), and it knows more roots (`/mnt`, `/media`, `/data`, `/projects`, …).

**Added**

- **`cam rebuild`:** rebuild the contentless text index from the sources. `sync --repair`
  cannot do this — it only rereads what is not yet indexed — and a contentless FTS index
  cannot be rebuilt from a content table. A chunk whose source is missing is left out of the
  index and reported; a partially readable chunk goes in, without marking the missing turns.
- **Concurrency protection.** `sync` and `rebuild` take an advisory lock in the `meta` table
  (pid, machine, time). The second run exits politely, it does not corrupt the first; an
  orphaned lock can be taken over after an hour or when the process is gone. Wipe-then-reload
  is in a transaction at all four sites (`file_events`, `path_evidence` by origin,
  `workspace_roots`, `collectCwdEvidence`), so a query arriving in between never sees an empty
  table.
- **`cam doctor` still runs on a corrupt database.** It does an integrity check (`quick_check`)
  and says what to do: text-index error → `cam rebuild`, unreadable file → backup and resync.
  It also prints the indexed chunk count and the live sync lock.
- **Versioned store-name warning.** If `~/.codex` exists but `state_5.sqlite` does not (or the
  Cursor `User` folder is there but `state.vscdb` is not), the collector warns instead of
  reporting zero sessions.
- **`CAM_HOME` and `CAM_CASE_FOLD`.** The former overrides the profile directory (so the CLI
  can be run end to end on a fixture profile); the latter lowercases paths — a
  platform-dependent decision that every stored path's shape depends on.
- **CI** (`.github/workflows/ci.yml`): Ubuntu, macOS and Windows, Node 22, type check, test,
  build, and a `node dist/cli.js --help` smoke test.

**Tests** — 163 → **255 green**, six new files for the blind spots the plan named:

- `test/cli.test.ts` — the CLI through `run()`, including exit code: flag parsing, `--limit`,
  unknown command, lock, `doctor` on a corrupt file, `rebuild`.
- `test/args.test.ts` — the argument parser on its own.
- `test/lock.test.ts` — lock, taking over an orphaned lock, foreign machine, garbage value.
- `test/attribution.test.ts` — every step of the cascade, survival of a manual decision, the
  medium/weak time-correlation path, the window edge, learned roots.
- `test/collector-cursor-history.test.ts` — the file-history collector (until now zero tests),
  together with the watermark and the transactional reload.
- `test/migrate.test.ts` — updating an old database, without data loss, run twice.
- `test/chunker.test.ts` — the infinite-loop guard on an oversized turn, overlap, coverage.
- Extended: `test/query.test.ts` with `recall`'s confidence asymmetry (without a project filter
  an unattributed hit goes through, a weak one does not) and the `stale` path end to end;
  `test/collector-cursor.test.ts` with POSIX paths; `test/projkey.test.ts` with folding pinned.

### M2 — Releasable package

**The goal was:** installable on someone else's machine, as a standalone tool.

- **Licence:** MIT, as a `LICENSE` file and as a `license` field.
- **Packaging:** `files` (dist JS + documentation + README/CHANGELOG/LICENSE, nothing else — 41
  files, 76 kB), `prepare` script (`dist/` is gitignored, without this a git install would give
  an empty package), `repository`, `author`, `keywords`, `engines`. **`private: true` stays on
  purpose**: the repo was private, the release channel is git/tarball install, not the public
  registry — the field only guards against an accidental `npm publish`; it does not block
  `npm pack` or install.
- **`cam-mcp` entry point:** `docs/mcp.md` gives the same machine-independent command for all
  four clients (`{"command": "cam-mcp"}`), without copying absolute paths around.
- **The database's default place is the user data directory** — `LOCALAPPDATA` on Windows,
  `XDG_DATA_HOME` (or `~/.local/share`) elsewhere. Until now it would have written under the
  install folder, so a global install would have put it in `node_modules`, and with `npx` the
  index would have been thrown away between two calls. A checkout that already has
  `.data/hub.sqlite` keeps using it.
- **`--db <path>` flag** on every command, and a **config file** (`CAM_CONFIG`, by default under
  `APPDATA` / `XDG_CONFIG_HOME`). From the file, `dbPath`, `maxInlineBytes` and all **ten store
  locations** can be overridden — until now `loadConfig` accepted an override, but no caller
  gave it one. Order: flag > environment variable > config file > default. A bad config file
  is a warning, not a fatal error.
- **The MCP entry-point heuristic was fixed:** instead of a filename match, an exact comparison
  of the file URL of `process.argv[1]`, so importing a module named `server.js` does not
  accidentally start a stdio server. `cam-mcp` also accepts a `--db` flag.
- **English `README.md`**, Hungarian moved into `README.hu.md`; `docs/` stayed Hungarian.
- The MCP server version cannot drift from `package.json`: a test ties the two together.

**Verified in a clean environment** (packed tarball, installed into an empty project): `cam`
and `cam-mcp` land on PATH, `cam --help` runs, `cam-mcp` answers the `initialize` request, and
two runs in a row see **the same** index in the user data directory.

**Tests:** 255 → **266** (`test/config.test.ts` for path resolution and precedence, `--db` in
the CLI tests, version agreement in the MCP tests).

### M3 — Memory layer

**The goal was:** the hub should not only find the past, it should also learn from it — without
a model and without a network. How it works: [`docs/memory.md`](docs/memory.md).

- **Consolidation in three passes** (`src/memory/consolidate.ts`): **Light** folds the recall
  evidence per chunk (how many times, on how many questions, on how many separate days, at
  what average hit score); **REM** extracts the words that return in *different* questions —
  the deterministic counterpart of a "recurring theme", with no summary and no invention;
  **Deep** scores, gates, promotes and budgets.
- **Promotion score** (`src/memory/score.ts`) with the weights given in the plan: 0.30 relevance +
  0.24 frequency + 0.15 diversity + 0.15 freshness + 0.10 consolidation + 0.06 conceptual.
  Counters saturate logarithmically, freshness half-life is 14 days. Gates: at least 3 recalls,
  at least 3 **different** questions, 0.8 score. A high score cannot buy the gate.
- **Forgetting from two directions:** freshness fades (promotion is revoked, but the evidence
  stays — one more recall brings it back), and the character budget (200 000 by default) drops
  the oldest promotions.
- **A promoted memory stores no text either.** Chunk reference, rehydrated at read time; if the
  source is gone, the memory says so. The "citation, not a copy" invariant does not break on
  the memory layer either.
- **`cam memory consolidate | list | show <id> | topics | status`** and the sixth MCP tool,
  **`cam_memory`**. `cam doctor` also reports memory state.
- **`recall_events` is now also for reading** — until now it was deliberately only collected.

**A new table for the questions.** `recall_events` only stored the question hash, and "on which
questions it came up" cannot be shown with a hash. `memory_queries` keeps the question text and
the words parsed from it. This **widens what goes into the database** (with the text of your
own search questions), and it can be turned off: with `recall(..., { logQuery: false })` only
the hash remains. The README and the plan's privacy section were updated accordingly. Schema
version 1 → 2.

**Determinism.** A promotion's age comes from the evidence (when you first recalled it), not
from the clock. Without that, a memory dropped by the budget and then promoted again would
jump to the front of the queue, and every run would give a different result — this way, run
twice from the same database, the same thing comes out. Tested.

**Measurement on the real index:** full consolidation on 18 recall events and 16 428 chunks is
7–19 ms. There is no promotion yet: the evidence is three questions, from a single day — the
gates filter exactly that.

**Tests:** 266 → **293** (`test/memory.test.ts` for scoring, the three passes, promotion,
revoke, budget and determinism; `test/cli.test.ts` for the `cam memory` commands).

### Measurements (reference machine, 2026-08-29)

A single table, measured on the final state. First-sync time is a run starting from an empty
database.

| | session | turn | first sync | repeat sync |
|---|---|---|---|---|
| codex | 917 | 15 511 | 37 s | 167 ms |
| cursor | 465 | 9 622 | 42 s | 110 ms |
| claude_code | 54 | 5 987 | 4,2 s | 42 ms |
| claude_desktop | 133 | — (index, no turns) | 0,4 s | 0,4 s |
| cowork | 67 | 785 | 5,8 s | 142 ms |
| **total** | **1 636** | **31 922** | | **~320 ms** |

Chunk: 16 414. Artifact: 446 files. Project: 133. Bound to a project: 1 381 / 1 636 (84%).

The "repeat sync" column is the **collectors**' time. Full `cam sync` time is much more,
because attribution comes after the read; measured per phase, on unchanged sources:

| phase | time |
|---|---|
| collectors (all seven) | ~320 ms |
| `collectCwdEvidence` + `learnRoots` + `correlateTime` | ~60 ms |
| `resolveFileEvents` (resolving 6 064 distinct file paths) | ~20 s |
| `reattribute` | ~4,2 s |
| **`cam sync` end to end** | **~26 s** |

So the earlier "repeat full sync: ~320 ms" claim is true of the collectors, not of the
command. `resolveFileEvents` re-resolves every file path on every run, because the Cursor
file-history collector reloads the `file_events` table daily — speeding that up is the M4
item.

MCP on live data, measured as a subprocess: `cam_projects` 8 ms, `cam_dossier` 8 ms,
`cam_recall` 55 ms, `cam_get` 5 ms, `cam_timeline` 2 ms.

**293 tests green**, `tsc --noEmit` clean, `npm run build` OK.
