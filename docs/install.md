# Install

One command that wires the server into every agent tool it finds, puts the usage
instructions next to it, gives the dream phase a model, and sets the index to
refresh itself.

```bash
cam install
```

If `cam` is not on the PATH yet: `node dist/cli.js install`. The package has to
be installed globally first; the recipe is in the [README](../README.md#install),
and it deliberately does not work from `npx` — [below](#the-installer-writes-nothing-from-a-temporary-package-directory)
is why.

**Look at what it would do first.** This command writes into other people's
config files and registers a scheduler job, so everything has a rehearsal:

```bash
cam install --dry-run
```

The rehearsal prints the same plan the live run would execute — not an
approximation. No file is modified, no model is called.

## What happens

Four independent parts, each separately opt-out and separately reported:

| part | what it does | opt-out |
|---|---|---|
| MCP | registers the server in every client config it finds | `--no-mcp` |
| skill | puts the usage instructions where the tool reads them | `--no-skills` |
| dream | picks a model for the phase from an agent CLI already installed | `--no-dream` |
| scheduling | hourly sync, nightly maintenance | `--no-schedule` |

Each is idempotent: a second run reports that there was nothing to do.

**What is not installed, we do not install.** A client announces itself by its
own directory (`~/.codex`, `~/.cursor`, `~/.claude`); if it is missing, the
command skips it. Writing the config file of a tool that does not exist would
look like this: a `~/.codex` that no Codex ever wrote.

## Where the data lives

The installer **does not move or create an index** — it only wires up what `cam`
would use anyway. Which that is, the installer prints among its first lines
(`index: ...`), and `cam doctor` repeats it any time.

| | Windows | macOS / Linux |
|---|---|---|
| index | `%LOCALAPPDATA%\centered-agent-memory\hub.sqlite` | `$XDG_DATA_HOME/centered-agent-memory/hub.sqlite`, default `~/.local/share/...` |
| settings | `%APPDATA%\centered-agent-memory\config.json` | `$XDG_CONFIG_HOME/centered-agent-memory/config.json`, default `~/.config/...` |
| backups | next to the index, `backups/` | the same |

A user data directory, not the install directory: a global install would
otherwise write into `node_modules`, and an `npx` run would drop the index
between two calls.

**There is one exception, and it is deliberate:** if the checkout already has
`.data/hub.sqlite`, `cam` keeps using it instead of the user data directory.
Without this, a `git pull` would look as if the whole history had vanished,
because the default had moved in the meantime. Convenient while developing,
not for production: deleting or moving the checkout takes the index with it.
If you do not want that, move it once and say where it is:

```bash
cam backup "%LOCALAPPDATA%\centered-agent-memory\hub.sqlite"   # verified copy
```

Then delete the checkout's `.data/` folder, and the next run will find the user
data directory. Point at an arbitrary location with the `dbPath` field of
`config.json`, for one run with `--db`, or with the `CAM_DB` environment
variable.

Path decision order, first wins: `--db` → `CAM_DB` → `config.json` `dbPath` →
the checkout's `.data/hub.sqlite`, if it exists → user data directory.

## MCP wiring

| client | file | format |
|---|---|---|
| Claude Code | `~/.claude.json` | JSON |
| Claude Desktop / Cowork | `claude_desktop_config.json` in the app data directory | JSON |
| Codex | `~/.codex/config.toml` | TOML |
| Cursor | `~/.cursor/mcp.json` | JSON |

The server is registered as `cam`, always with an **absolute path** — even if
`cam-mcp` happens to be on the `PATH`. The client is not started by your shell:
a desktop app launched from a dock has no login `PATH`, so what the installer's
shell found says nothing about what the client will find. If the package moves,
run `cam install` again.

### The installer writes nothing from a temporary package directory

An `npx github:...` run unpacks into the npm cache (`_npx/<hash>`) and puts its
own `node_modules/.bin` on the `PATH` for the duration of the run. From there
both possible entries lie: the absolute path lives until the cache is collected,
and a bare `cam-mcp` lives until the process exits. The command therefore
detects this case, writes nothing, and says what is needed instead:

```bash
npm i -g centered-agent-memory && cam install
```

Existing content is left alone. JSON files are written back with their own
indentation; for TOML we replace our own table at the text level so comments
and formatting survive. Before the first change a backup is made next to the
file (`*.cam-backup-<timestamp>`).

**If a config file is corrupt, we do not overwrite it.** The command prints
which file and what is wrong, continues with the other clients, and exits `1`.
A broken JSON cannot be merged safely, and guessing is worse than the error
message.

### Project-scoped wiring

```bash
cam install --project
```

This writes into the repo: `.mcp.json` (Claude Code) and `.cursor/mcp.json`
(Cursor). Only these two, because only these two read per-repo configuration —
Codex configures its servers globally, and Claude Desktop has no notion of a
repo.

A single client: `--client claude_code|claude_desktop|codex|cursor`.

## Skill

MCP wiring still does not make the agent use the index: it uses it because it
knows when it is worth it. The skill describes that — when to reach for it, in
what order, how to read the confidence signals, and what not to do.

It is built from one body, rendered per client under
`~/.claude/skills/agent-memory/SKILL.md`, `~/.codex/skills/…`,
`~/.cursor/skills/…`. What differs per tool is a single section at the end:
whether there is a terminal as well, or only the MCP tools.

Claude Code Desktop reads the same `~/.claude/skills/` folder as the CLI. The
skill gets there with `cam install`, or with the [skills](https://skills.sh)
CLI:

```bash
npx skills add arlinamid/centered-agent-memory --skill agent-memory --agent claude-code -g -y
```

This command looks for `skills/agent-memory/SKILL.md` in the repo. The classic
Claude Desktop / Cowork app has no such folder — Cowork only registers through
the Customize → Skills uploader, not by file copy. There the server's own
instructions arrive, with every response.

## Dream model

The [dream phase](memory.md#the-dream-phase-optional) is the only part that needs a
model. The installer does not ask for an API key; it looks at which agent CLIs
are already on the machine and offers them:

```
dream model — which tool should write the summaries?
  1) Codex CLI          C:\...\codex.exe
  2) Claude Code        C:\...\claude.exe
  3) Gemini CLI         node C:\...\bundle\gemini.js
  0) none (the dream phase stays without a model)
```

Then you pick the model as well. The list comes from where it is authoritative:
Codex from its own `models_cache.json`, Antigravity from `agy models`, Cursor
from `--list-models`, Claude from its documented aliases (`sonnet`, `opus`,
`haiku`, `fable`). The Gemini CLI has no such command; there you can type a
name, or leave it empty and keep the tool's default — the latter is rarely a
bad choice, and never goes stale.

On a non-interactive run (script, pipe) it tries the tools it found until one
answers. Concretely: `--dream codex --model gpt-5.6-sol`.

**The choice only goes into the config if it answered.** The installer sends a
short prompt and waits for the reply. A template written with the wrong flag
looks exactly like a working one until the first nightly run fails into a log
nobody reads — these thirty seconds find that out now.

What the templates contain, and why:

- **No tool access** (`-s read-only`, `--tools ""`, `--mode ask`, `--approval-mode plan`).
  These are coding agents: left to themselves they start reading files to answer
  a question for which we just handed them the text.
- **No session persistence** (`--ephemeral`, `--no-session-persistence`) on the
  tools that `cam` itself indexes. Without this the next sync would read the
  dream prompts, the next dream would summarise them, and the index would
  slowly fill with its own reflection.
- **The prompt goes on stdin**, because an excerpt is thousands of characters,
  and the argument list is the wrong place for that on every platform.
- **The reply into a file**, where the tool can (`codex exec -o`), because
  stdout also has the banner and the token counter.

The model name is recorded next to every finished summary, so a dream can
always say who wrote it.

### The program, not the launcher

The installer does not pick by `first-on-the-PATH`. It walks the whole `PATH`
and the tools' own install locations, reads through the launchers — the last
line of a Windows `.cmd` shim says what it would run — and always lands on the
real program: either a native executable, or `node <script>`.

Two reasons. A tool can be installed twice, from npm and as a native release,
at different versions; `PATH` order is a bad tie-breaker (on this development
machine the npm version behind the shim was the broken one). The other: what
we write here is later run by a scheduled task that has no shell and no `PATH`
— there an absolute program is the only form that starts.

## Scheduling

The tool is worth something if it is current by morning on its own. The
installer registers that too:

| | hourly | daily at 4:00 |
|---|---|---|
| Windows | `cam-sync` task | `cam-maintenance` (consolidation, then retention) |
| macOS | `io.github.arlinamid.cam.sync` | `.consolidate` 4:00, `.prune` 4:10 |
| Linux | `cam-sync.timer` | `cam-maintenance.timer` |

All three platforms have catch-up for a missed run turned on
(`-StartWhenAvailable`, `Persistent=true`, `RunAtLoad`): a sleeping machine's
skipped sync would otherwise simply be lost.

Details, the manual version, and the check commands:
[`operations.md`](operations.md#scheduling).

On Linux a user timer stops when you log out, unless lingering is on — the
installer prints this when that is the case: `loginctl enable-linger $USER`.

### One package, one schedule

The job names are fixed, so two sync jobs cannot be created. What could be
created is worse: the second install would **take over** the existing one for
another copy, and the previous one would look installed while nothing runs on
its behalf. The installer therefore checks who the already-registered job
belongs to:

- **this same copy** — nothing to do, the second run writes nothing;
- **a different copy** — does not write, names the currently registered
  command and its own, and exits `1`. Takeover with `--force`, or first
  `cam uninstall` from the other copy.

This is where a development checkout and a global install would meet: both can
run `cam install`, and the difference only shows in which `cli.js` the machine
runs every hour.

**The background job gets an absolute path, with symlinks resolved.** A Node
version manager puts a moving link on both sides (`C:\nvm\current\node.exe` and
the global `node_modules` next to it), and an hourly task must not depend on
which version happens to be selected in a terminal. After a version change, run
`cam install` again.

## Verification

```bash
cam status          # is there an index, when did it last refresh
cam doctor          # integrity, schema, attribution, size
```

In the clients: restart the tool, and ask about something you did with another
one. If the server is registered, the last line of the reply will have the
index's age.

Checking the schedule, per platform:

```powershell
Get-ScheduledTaskInfo -TaskName "cam-sync"          # Windows
```

```bash
launchctl print gui/$(id -u)/io.github.arlinamid.cam.sync   # macOS
systemctl --user list-timers cam-sync.timer            # Linux
```

## Uninstall

```bash
cam uninstall --dry-run
cam uninstall
```

Removes the server entry from the configs (leaves the other entries alone),
deletes the skills, and takes down the scheduled jobs.

**It does not touch the index.** That is emptied selectively by `cam forget`,
or by deleting the file itself — `cam doctor` says where it is. This is
deliberate: uninstall undoes the wiring, not the collected knowledge.
