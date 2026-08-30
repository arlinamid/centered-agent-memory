import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Installing the periodic run that `docs/operations.md` describes.
 *
 * Split deliberately in two: `schedulePlan` is a pure function that returns the
 * files and commands a platform needs, and `applySchedule` runs them. The plan
 * is therefore testable on any machine, which matters because three of the four
 * platforms cannot be exercised on the fourth.
 *
 * Two jobs, not one. The sync is hourly because an index that is an hour old is
 * still useful and one that is a day old is not; the maintenance pass
 * (consolidate, then prune) is nightly because neither is urgent and both cost
 * more than a sync.
 */

export type Platform = "win32" | "darwin" | "linux";

export interface ScheduleFile {
  path: string;
  contents: string;
}

export interface ScheduleStep {
  /** Shown by --dry-run, verbatim. */
  describe: string;
  argv: string[];
}

export interface SchedulePlan {
  platform: Platform;
  /** How the jobs are registered, for the report. */
  mechanism: string;
  /** What the jobs are called here — a launchd label is not a task name. */
  jobs: string[];
  /** The CLI these jobs would run. Identifies which copy of the package owns them. */
  cli: string;
  files: ScheduleFile[];
  install: ScheduleStep[];
  remove: ScheduleStep[];
  /** Non-fatal: what the user still has to do by hand, if anything. */
  notes: string[];
}

export const SYNC_JOB = "cam-sync";
export const MAINTENANCE_JOB = "cam-maintenance";

export interface ScheduleOptions {
  /** Absolute path to the node binary that will run the CLI. */
  node: string;
  /** Absolute path to the CLI entry point. */
  cli: string;
  home?: string;
  platform?: Platform;
  /** Minute of the hour for the sync, so several machines do not all wake at :00. */
  minute?: number;
}

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function windowsPlan(o: Required<Pick<ScheduleOptions, "node" | "cli" | "minute">>): SchedulePlan {
  // Register-ScheduledTask rather than schtasks: -StartWhenAvailable has no
  // schtasks equivalent, and without it every run missed by a sleeping machine
  // is simply lost.
  const settings =
    "$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries " +
    "-AllowStartIfOnBatteries -MultipleInstances IgnoreNew";

  const sync =
    `${settings}; ` +
    `$a = New-ScheduledTaskAction -Execute ${q(o.node)} -Argument ${q(`"${o.cli}" sync --quiet`)}; ` +
    `$t = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(${o.minute}) ` +
    `-RepetitionInterval (New-TimeSpan -Hours 1); ` +
    `Register-ScheduledTask -TaskName ${q(SYNC_JOB)} -Action $a -Trigger $t -Settings $s -Force ` +
    `-Description 'Centered Agent Memory: refresh the conversation index' | Out-Null`;

  const maintenance =
    `${settings}; ` +
    `$a = New-ScheduledTaskAction -Execute ${q(o.node)} -Argument ${q(`"${o.cli}" memory consolidate --quiet`)}; ` +
    `$b = New-ScheduledTaskAction -Execute ${q(o.node)} -Argument ${q(`"${o.cli}" prune --quiet`)}; ` +
    `$t = New-ScheduledTaskTrigger -Daily -At 4am; ` +
    `Register-ScheduledTask -TaskName ${q(MAINTENANCE_JOB)} -Action @($a, $b) -Trigger $t -Settings $s -Force ` +
    `-Description 'Centered Agent Memory: consolidate and prune' | Out-Null`;

  const ps = (script: string): string[] => ["powershell", "-NoProfile", "-NonInteractive", "-Command", script];

  return {
    platform: "win32",
    mechanism: "Task Scheduler",
    jobs: [SYNC_JOB, MAINTENANCE_JOB],
    cli: o.cli,
    files: [],
    install: [
      { describe: `Task Scheduler: ${SYNC_JOB} (hourly, :${String(o.minute).padStart(2, "0")})`, argv: ps(sync) },
      { describe: `Task Scheduler: ${MAINTENANCE_JOB} (daily at 04:00)`, argv: ps(maintenance) },
    ],
    remove: [
      {
        describe: `Task Scheduler: remove ${SYNC_JOB}`,
        argv: ps(`Unregister-ScheduledTask -TaskName ${q(SYNC_JOB)} -Confirm:$false -ErrorAction SilentlyContinue`),
      },
      {
        describe: `Task Scheduler: remove ${MAINTENANCE_JOB}`,
        argv: ps(
          `Unregister-ScheduledTask -TaskName ${q(MAINTENANCE_JOB)} -Confirm:$false -ErrorAction SilentlyContinue`,
        ),
      },
    ],
    notes: [],
  };
}

const LABEL = "io.github.arlinamid.cam";

function plist(label: string, args: string[], interval: number | null, hour: number | null, minute = 0): string {
  const schedule =
    interval !== null
      ? `  <key>StartInterval</key>        <integer>${interval}</integer>\n  <key>RunAtLoad</key>            <true/>`
      : `  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key><integer>${hour}</integer>\n    <key>Minute</key><integer>${minute}</integer>\n  </dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>                <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
${schedule}
  <key>StandardErrorPath</key>    <string>/tmp/${label}.err</string>
  <key>ProcessType</key>          <string>Background</string>
</dict>
</plist>
`;
}

function darwinPlan(o: Required<Pick<ScheduleOptions, "node" | "cli" | "home">>): SchedulePlan {
  // Deliberately not `path`: a plan can be built on one platform for another —
  // the tests do exactly that — and the host's separator has no business in a
  // launchd path.
  const dir = path.posix.join(o.home, "Library", "LaunchAgents");
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;

  // A launchd agent runs one program, so the nightly pass that is a single
  // task elsewhere is two agents here — ten minutes apart, consolidation
  // first, because pruning is what enforces the retention policy on what it
  // leaves behind.
  const agents = [
    { name: "sync", argv: ["sync", "--quiet"], interval: 3600, hour: null, minute: 0 },
    { name: "consolidate", argv: ["memory", "consolidate", "--quiet"], interval: null, hour: 4, minute: 0 },
    { name: "prune", argv: ["prune", "--quiet"], interval: null, hour: 4, minute: 10 },
  ];

  const built = agents.map((a) => {
    const label = `${LABEL}.${a.name}`;
    return {
      label,
      file: path.posix.join(dir, `${label}.plist`),
      contents: plist(label, [o.node, o.cli, ...a.argv], a.interval, a.hour, a.minute),
    };
  });

  return {
    platform: "darwin",
    mechanism: "launchd",
    jobs: built.map((b) => b.label),
    cli: o.cli,
    files: built.map((b) => ({ path: b.file, contents: b.contents })),
    install: built.map((b) => ({
      describe: `launchd: load ${b.label}`,
      argv: ["launchctl", "bootstrap", `gui/${uid}`, b.file],
    })),
    remove: built.map((b) => ({
      describe: `launchd: unload ${b.label}`,
      argv: ["launchctl", "bootout", `gui/${uid}/${b.label}`],
    })),
    notes: [],
  };
}

function linuxPlan(o: Required<Pick<ScheduleOptions, "node" | "cli" | "home">>): SchedulePlan {
  const dir = path.posix.join(o.home, ".config", "systemd", "user");
  const unit = (desc: string, exec: string): string =>
    `[Unit]\nDescription=${desc}\n\n[Service]\nType=oneshot\nExecStart=${exec}\n`;
  const timer = (desc: string, spec: string): string =>
    `[Unit]\nDescription=${desc}\n\n[Timer]\n${spec}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`;

  return {
    platform: "linux",
    mechanism: "systemd user timer",
    jobs: [`${SYNC_JOB}.timer`, `${MAINTENANCE_JOB}.timer`],
    cli: o.cli,
    files: [
      {
        path: path.posix.join(dir, `${SYNC_JOB}.service`),
        contents: unit("Centered Agent Memory: refresh the conversation index", `${o.node} ${o.cli} sync --quiet`),
      },
      {
        path: path.posix.join(dir, `${SYNC_JOB}.timer`),
        contents: timer("cam sync hourly", "OnBootSec=5min\nOnUnitActiveSec=1h"),
      },
      {
        path: path.posix.join(dir, `${MAINTENANCE_JOB}.service`),
        contents: unit(
          "Centered Agent Memory: consolidate and prune",
          `${o.node} ${o.cli} memory consolidate --quiet\nExecStart=${o.node} ${o.cli} prune --quiet`,
        ),
      },
      {
        path: path.posix.join(dir, `${MAINTENANCE_JOB}.timer`),
        contents: timer("cam maintenance daily", "OnCalendar=*-*-* 04:00:00"),
      },
    ],
    install: [
      { describe: "systemd: daemon-reload", argv: ["systemctl", "--user", "daemon-reload"] },
      { describe: `systemd: start ${SYNC_JOB}.timer`, argv: ["systemctl", "--user", "enable", "--now", `${SYNC_JOB}.timer`] },
      {
        describe: `systemd: start ${MAINTENANCE_JOB}.timer`,
        argv: ["systemctl", "--user", "enable", "--now", `${MAINTENANCE_JOB}.timer`],
      },
    ],
    remove: [
      { describe: `systemd: stop ${SYNC_JOB}.timer`, argv: ["systemctl", "--user", "disable", "--now", `${SYNC_JOB}.timer`] },
      {
        describe: `systemd: stop ${MAINTENANCE_JOB}.timer`,
        argv: ["systemctl", "--user", "disable", "--now", `${MAINTENANCE_JOB}.timer`],
      },
    ],
    // A user timer stops when the last session ends unless lingering is on,
    // which is exactly the machine that most needs the catch-up run.
    notes: ["if the machine does not stay logged in: loginctl enable-linger $USER"],
  };
}

export function schedulePlan(opts: ScheduleOptions): SchedulePlan {
  const platform = opts.platform ?? (process.platform as Platform);
  const home = opts.home ?? os.homedir();
  const minute = opts.minute ?? 17;

  switch (platform) {
    case "win32":
      return windowsPlan({ node: opts.node, cli: opts.cli, minute });
    case "darwin":
      return darwinPlan({ node: opts.node, cli: opts.cli, home });
    case "linux":
      return linuxPlan({ node: opts.node, cli: opts.cli, home });
    default: {
      const never: never = platform;
      throw new Error(`unknown platform: ${String(never)}`);
    }
  }
}

export interface StepResult {
  describe: string;
  ok: boolean;
  detail: string;
}

function run(step: ScheduleStep): StepResult {
  const [cmd, ...args] = step.argv;
  const r = spawnSync(cmd!, args, { encoding: "utf8", windowsHide: true, shell: false });
  if (r.error) return { describe: step.describe, ok: false, detail: r.error.message };
  const ok = r.status === 0;
  const detail = ok ? "" : `${r.status}: ${(r.stderr || r.stdout || "").trim().split("\n")[0] ?? ""}`;
  return { describe: step.describe, ok, detail };
}

export function applySchedule(plan: SchedulePlan, remove = false): StepResult[] {
  const out: StepResult[] = [];
  if (!remove) {
    for (const f of plan.files) {
      fs.mkdirSync(path.dirname(f.path), { recursive: true });
      fs.writeFileSync(f.path, f.contents, "utf8");
      out.push({ describe: `wrote: ${f.path}`, ok: true, detail: "" });
    }
  }
  for (const step of remove ? plan.remove : plan.install) out.push(run(step));
  if (remove) {
    for (const f of plan.files) {
      if (fs.existsSync(f.path)) {
        fs.rmSync(f.path);
        out.push({ describe: `removed: ${f.path}`, ok: true, detail: "" });
      }
    }
  }
  return out;
}

export interface ScheduleState {
  /** `same` means this very copy of the package already owns the jobs. */
  state: "absent" | "same" | "different";
  /** What is registered now, for the report. Empty when absent. */
  current: string;
}

/** Two paths to the same file, as the operating system would see them. */
const samePath = (a: string, b: string): boolean => {
  const norm = (s: string): string => s.replace(/\\/g, "/").replace(/^"|"$/g, "");
  return process.platform === "win32"
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
};

/**
 * Is the job already registered, and is it ours?
 *
 * The job names are fixed, so a second install cannot leave two sync jobs
 * behind — but it can silently repoint the existing one at a different copy of
 * the package. That is the failure worth catching: a scheduled task still runs
 * every hour, still exits zero, and updates an index nobody is reading, because
 * it belongs to a checkout that has since been deleted or moved.
 */
export function scheduleState(plan: SchedulePlan): ScheduleState {
  switch (plan.platform) {
    case "win32": {
      // Get-ScheduledTask rather than schtasks: the /XML output is UTF-16 and
      // would arrive as mojibake through a pipe.
      const r = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$t = Get-ScheduledTask -TaskName '${SYNC_JOB}' -ErrorAction SilentlyContinue; ` +
            "if ($null -eq $t) { exit 1 }; " +
            "$t.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments }",
        ],
        { encoding: "utf8", windowsHide: true },
      );
      if (r.status !== 0) return { state: "absent", current: "" };
      const current = (r.stdout ?? "").trim();
      if (current === "") return { state: "absent", current: "" };
      const cited = /"([^"]+)"/.exec(current)?.[1] ?? "";
      return { state: samePath(cited, plan.cli) ? "same" : "different", current };
    }
    case "darwin":
    case "linux": {
      const present = plan.files.filter((f) => fs.existsSync(f.path));
      if (present.length === 0) return { state: "absent", current: "" };
      // The unit and plist files carry the full command, so their own text is
      // the comparison — no need to ask the scheduler what it loaded.
      const same = present.length === plan.files.length &&
        plan.files.every((f) => fs.readFileSync(f.path, "utf8") === f.contents);
      const current = present.map((f) => f.path).join(", ");
      return { state: same ? "same" : "different", current };
    }
    default: {
      const never: never = plan.platform;
      throw new Error(`unknown platform: ${String(never)}`);
    }
  }
}
