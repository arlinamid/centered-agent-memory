# Operations

How this runs unattended: scheduling, freshness, retention, backup.

The tool is worth something if it is current by morning on its own. This
section describes how it gets there on all four platforms, how you find out
when it has broken, and what to do about the fact that the database would
otherwise grow forever.

## The daily run

Three commands, in this order. Each is idempotent, and each can be run on its
own.

```bash
cam sync --quiet                # read the sources (incremental)
cam memory consolidate --quiet  # promotion from the recall trace
cam prune --quiet               # retention rule
```

`--quiet` means it **speaks on error, otherwise stays silent** — that is what
makes a scheduled task's log readable. What `--quiet` never swallows: the
command's answer (the output of `cam recall --json`, for example) and error
messages.

Exit code is the contract:

| code | what it means | what to do |
|---|---|---|
| `0` | ok | nothing |
| `1` | failure — a source could not be read, or the database is corrupt | look at `stderr`, then `cam doctor` |
| `2` | bad usage (mistyped flag) | fix the command line |

A crashed or killed run does not wedge the hub: the lock expires after an hour,
and of two concurrent `cam sync` runs the second exits `0`, because the other
one is doing the work.

How long it takes: on the reference machine a repeat sync of an unchanged
corpus is ~4.6 s, of which ~3.5 s is attribution. The first run on a new
machine is much longer than that.

## Scheduling

`cam install` registers all of this on its own, in the way the platform
expects — hourly sync, nightly maintenance — and `cam uninstall` takes it
down; see [`install.md`](install.md#scheduling). The recipes below describe
what it does, and how to set it up by hand if you want it differently.

### Windows — Task Scheduler

Hourly, as the logged-in user. We run it without a window, because a console
window flashing every hour becomes unbearable within half a day:

```powershell
# cam on the PATH is a .cmd shim that node cannot run as a script; the
# task has to be given the JS behind it. cam doctor prints the path.
$cam  = "$env:APPDATA\npm\node_modules\centered-agent-memory\dist\cli.js"
$node = (Get-Command node).Source
$action  = New-ScheduledTaskAction -Execute $node `
           -Argument "`"$cam`" sync --quiet"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
           -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
            -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
            -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "cam-sync" -Action $action -Trigger $trigger `
  -Settings $settings -Description "Centered Agent Memory: refresh the conversation index"
```

`-StartWhenAvailable` is the point: without it a sleeping machine's missed run
is simply lost. `-MultipleInstances IgnoreNew` does the same thing the hub
lock does, one layer up.

Check and log:

```powershell
Get-ScheduledTaskInfo -TaskName "cam-sync"   # LastRunTime, LastTaskResult (0 = ok)
Start-ScheduledTask   -TaskName "cam-sync"   # run it now
```

Daily maintenance as a separate task, for the small hours:

```powershell
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$cam`" prune --quiet"
Register-ScheduledTask -TaskName "cam-prune" -Action $action `
  -Trigger (New-ScheduledTaskTrigger -Daily -At 4am) -Settings $settings
```

### macOS — launchd

`~/Library/LaunchAgents/io.github.arlinamid.cam.sync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>                <string>io.github.arlinamid.cam.sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/cam</string>
    <string>sync</string>
    <string>--quiet</string>
  </array>
  <key>StartInterval</key>        <integer>3600</integer>
  <key>RunAtLoad</key>            <true/>
  <key>StandardErrorPath</key>    <string>/tmp/cam-sync.err</string>
  <key>ProcessType</key>          <string>Background</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.arlinamid.cam.sync.plist
launchctl kickstart -p gui/$(id -u)/io.github.arlinamid.cam.sync   # run it now
```

Write the full path of `cam` into it: a launchd environment has no shell
profile, so no `PATH` either. `which cam` says where it was installed.

### Linux — systemd timer

`~/.config/systemd/user/cam-sync.service`:

```ini
[Unit]
Description=Centered Agent Memory: refresh the conversation index

[Service]
Type=oneshot
ExecStart=%h/.local/bin/cam sync --quiet
```

`~/.config/systemd/user/cam-sync.timer`:

```ini
[Unit]
Description=cam sync hourly

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now cam-sync.timer
systemctl --user list-timers cam-sync.timer
journalctl --user -u cam-sync.service -n 50
```

`Persistent=true` is the equivalent of `-StartWhenAvailable`: a run missed
while the machine was off is made up on the next start.

If the machine does not stay logged in, `loginctl enable-linger $USER` is
needed, otherwise the user timers stop on logout.

### Anywhere — cron

```cron
# m  h  dom mon dow  command
  17 *  *   *   *    /home/me/.local/bin/cam sync --quiet
  40 4  *   *   *    /home/me/.local/bin/cam memory consolidate --quiet && /home/me/.local/bin/cam prune --quiet
  10 5  *   *   0    /home/me/.local/bin/cam backup --quiet
```

cron has a minimal `PATH`, so write a full path. Because of `--quiet` you only
get mail when something actually happened — that is the difference between
reading the cron mail and not.

## Freshness

The long-term risk is not that the index breaks, but that it stops silently,
and the agent answers questions weeks later from old data in the belief that
it is current.

That is why **the last line of every MCP response** carries the index's age:

```
— index: 2026-08-29 17:37 UTC (1 min ago) · 1643 session · 32054 turn
```

If the index is older than the threshold, the line says `STALE, run: cam sync`,
and the server's instructions tell the agent to report that to the user rather
than quote the old data as current. The same threshold drives the `cam_status`
tool and the `cam status` command.

```bash
cam status          # when it last ran, what it holds
cam status --json   # the same for a machine: ageMs, stale, errors, unfinished
```

The threshold is 24 hours by default, overridable in the config file:

```json
{ "staleAfterHours": 6 }
```

For a monitoring script this is enough:

```bash
cam status --json | node -e 'process.stdin.on("data",d=>process.exit(JSON.parse(d).stale?1:0))'
```

The age comes from the most recent **finished** run in the `sync_runs` table,
not the most recent row: a crashed run cannot make the index look fresh.
Interrupted runs are printed separately by `cam status` and `cam doctor`.

## Retention

Three things would grow without bound: the recall trace (`recall_events`,
several rows per search), the run log (`sync_runs`, forever), and the sessions
whose source has since vanished — the last of these would keep coming up as
`source missing` hits.

```bash
cam prune --dry-run     # what it would delete, no row is deleted
cam prune               # apply the retention rule
cam prune --vacuum      # and give the space back from the file as well
```

Defaults, overridable in the config file:

```json
{
  "retention": {
    "recallDays": 365,
    "keepRuns": 500,
    "missingDays": 0
  }
}
```

| setting | what it controls |
|---|---|
| `recallDays` | recall events older than this are deleted |
| `keepRuns` | this many most recent sync runs stay in the log |
| `missingDays` | delete sessions whose source has been missing this many days; `0` turns it off |

From the command line as well: `--recall-days`, `--keep-runs`, `--missing-days`.

**One rule overrides everything: the evidence behind a live promotion cannot be
deleted.** A promoted memory's claim is that it can show when and on which
questions it came up; if retention emptied that, the claim would become false.
So the trace of a chunk that appears in `memory_facts` stays regardless of age,
and only demotion (consolidation's job, not prune's) lets it go.

`missingDays` is `0` by default because a source may be missing because an
external drive is not mounted — a hasty delete would throw away an index that
would have come back on its own.

Giving the space back is a separate flag (`--vacuum`), because it rewrites the
whole file, and a nightly prune should not pay that every time.

### Forgetting a project or session

```bash
cam forget --project <key>
cam forget <tool:sessionId>       # as cam recall cites it
cam forget --project <key> --dry-run
```

This deletes from the **index**, not from history: the conversation files
belong to someone else, we do not touch them, so a later `cam sync` reindexes
them if they are still there. If you want them gone for good, you have to
delete the source itself (or take it out from under `roots`), and then
`cam forget`.

Forgetting a project takes its sessions, turns, chunks, text-index rows, and
the memories promoted from them.

## Backup and moving

```bash
cam backup                    # dated file next to the index, under backups/
cam backup /media/nas/hub.sqlite
cam backup --json             # { file, bytes, problems, caseFold }
```

Not `cp`: in WAL mode the newest writes live in a `-wal` side file, and a
naive copy leaves exactly those behind — with no error message. `cam backup`
uses the SQLite online backup API, then opens the copy, `quick_check`s it, and
checkpoints the WAL so the backup is **a single standalone file**. If the check
finds an error, the command exits `1` and does not call it a backup.

Restore: copy it into place (`cam doctor` prints where), or open it where it
is: `cam recall "question" --db /media/nas/hub.sqlite`.

**When moving to another machine, watch the case-fold.** On Windows and macOS
paths are stored lowercased, on Linux verbatim; a copied index would therefore
silently find nothing. The index stamps itself, and `cam doctor` and
`cam_status` compare that with the running system and say what to set:

```bash
CAM_CASE_FOLD=1 cam reattribute --db /media/nas/hub.sqlite
```

## If something broke

```bash
cam doctor        # integrity, schema, freshness, attribution drift, size
```

| what it prints | what to do |
|---|---|
| `corrupt database` | if only the text index: `cam rebuild`; if the data too: save the file, delete it, `cam sync` |
| `empty text index` | `cam rebuild` — rebuilds it from the sources |
| `N attribution(s) on an old rule version` | `cam reattribute` — without reading any store |
| `the index was written …` (case-fold) | `CAM_CASE_FOLD=…`, see above |
| `N interrupted run(s)` | `cam prune` cleans the log |
| `sync lock is held` | expires within an hour; if not, the process is actually running |

The sources are not damaged in any of these cases: every foreign store is
opened read-only, and the worst that can happen is that the index has to be
built from scratch.

## Cutting a release

The version lives in `package.json`. `package-lock.json` must show the same
root `version` — it is a copy, not the source. After CI is green on `main`,
Actions either tags the number you already wrote, or bumps it so a fix cannot
ship under yesterday's version.

- **You bumped** `package.json`, the lockfile, `SERVER_VERSION`, and moved
  `[Unreleased]` to `## [x.y.z]`: that number is tagged.
- **You did not:** if HEAD is ahead of the last release, the patch goes up
  (`0.5.0` → `0.5.1`). If `[Unreleased]` names a breaking change, the minor
  goes up (`0.5.0` → `0.6.0`). The job writes the files, commits
  `chore: release vX.Y.Z`, and tags.

The Release workflow then installs the tarball on three platforms before
publishing. A tag is still the promise.
