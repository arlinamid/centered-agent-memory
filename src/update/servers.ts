import { spawnSync } from "node:child_process";
import { powershellArgv } from "../powershell.js";

/**
 * The MCP servers this package starts, found and stopped.
 *
 * An update replaces `dist/mcp/server.js` and the rest of the package while
 * editors may still be running it. Two things go wrong if nothing is done:
 * on Windows npm cannot overwrite a file a live process has open, so the
 * install fails halfway; and everywhere else a server keeps running the old
 * code against an index the new code has already migrated.
 *
 * These are our own processes — a stdio child an MCP client spawned — and the
 * client starts a fresh one on its next tool call, so stopping them is
 * recoverable. It is still announced before it happens.
 */

export interface RunningServer {
  pid: number;
  command: string;
}

/** Anything whose command line names this package's server entry point. */
const SERVER_MARKERS = ["cam-mcp", "dist/mcp/server.js", "dist\\mcp\\server.js"];

export type Runner = typeof spawnSync;

/**
 * List the live `cam-mcp` processes.
 *
 * Reading the process table is a per-platform business, and being unable to
 * read it is not the same as there being none: the caller is told which of the
 * two happened rather than being handed an empty list to misread.
 */
export function findRunningServers(
  opts: { run?: Runner; self?: number } = {},
): { servers: RunningServer[]; listed: boolean; detail: string } {
  const run = opts.run ?? spawnSync;
  const self = opts.self ?? process.pid;

  const r =
    process.platform === "win32"
      ? run(
          "powershell",
          powershellArgv(
            "-Command",
            "Get-CimInstance Win32_Process | " +
              "Select-Object -Property ProcessId, CommandLine | " +
              "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
          ),
          { encoding: "utf8", windowsHide: true },
        )
      : run("ps", ["-eo", "pid=,args="], { encoding: "utf8" });

  if (r.error) return { servers: [], listed: false, detail: r.error.message };
  if (r.status !== 0) return { servers: [], listed: false, detail: `process listing exited ${r.status}` };

  const servers: RunningServer[] = [];
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const text = line.trim();
    if (text === "") continue;
    const m = /^(\d+)[\t ]+(.*)$/.exec(text);
    if (!m) continue;
    const pid = Number.parseInt(m[1]!, 10);
    const command = m[2]!;
    // Never this process, and never the `cam update` that is doing the asking.
    if (pid === self || !Number.isFinite(pid)) continue;
    if (!SERVER_MARKERS.some((marker) => command.includes(marker))) continue;
    // The listing command itself mentions nothing of ours, but a shell that
    // was used to grep for one would.
    if (command.includes("Get-CimInstance") || command.includes("-eo pid=")) continue;
    servers.push({ pid, command });
  }
  return { servers, listed: true, detail: `${servers.length} running` };
}

export interface StopResult {
  pid: number;
  stopped: boolean;
  detail: string;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Ask each server to stop, and wait until it is actually gone.
 *
 * SIGTERM first, so the server can close its database handle. On Windows that
 * signal is TerminateProcess and still returns before the handle is released,
 * so we wait — and if it is still there, `taskkill /T /F` takes the process
 * tree. A pid that is already gone (ESRCH) counts as stopped.
 *
 * When `kill` is injected the wait is skipped: the test suite never owns a
 * real process.
 */
export function stopServers(
  servers: ReadonlyArray<RunningServer>,
  opts: {
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    alive?: (pid: number) => boolean;
    run?: Runner;
    waitMs?: number;
  } = {},
): StopResult[] {
  const kill = opts.kill ?? ((pid, signal) => process.kill(pid, signal));
  const alive = opts.alive ?? pidAlive;
  const run = opts.run ?? spawnSync;
  const waitMs = opts.waitMs ?? 3000;
  const realWait = opts.alive !== undefined || opts.kill === undefined;

  return servers.map((s) => {
    try {
      kill(s.pid, "SIGTERM");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return { pid: s.pid, stopped: true, detail: "already gone" };
      return { pid: s.pid, stopped: false, detail: (err as Error).message };
    }

    if (!realWait) return { pid: s.pid, stopped: true, detail: "stopped" };

    const deadline = Date.now() + waitMs;
    while (alive(s.pid) && Date.now() < deadline) sleepMs(50);
    if (!alive(s.pid)) return { pid: s.pid, stopped: true, detail: "stopped" };

    if (process.platform === "win32") {
      run("taskkill", ["/F", "/T", "/PID", String(s.pid)], { encoding: "utf8", windowsHide: true });
      const forceUntil = Date.now() + waitMs;
      while (alive(s.pid) && Date.now() < forceUntil) sleepMs(50);
      if (!alive(s.pid)) return { pid: s.pid, stopped: true, detail: "taskkill" };
    }
    return { pid: s.pid, stopped: false, detail: "still running" };
  });
}
