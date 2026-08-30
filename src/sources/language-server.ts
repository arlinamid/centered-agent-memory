import { spawnSync } from "node:child_process";
import { WINDSURF_CSRF_ENV, readProcessEnvVar } from "./process-env.js";

/**
 * Talking to a Codeium-lineage language server (Antigravity, Devin / Windsurf).
 *
 * Both keep conversations encrypted on disk (see `docs/sources.md`), and the
 * only component that can decrypt them is the daemon the application already
 * runs. It answers a Connect-RPC service over plain HTTP on localhost,
 * guarded by a CSRF token it was started with.
 *
 * Three things about it are measured rather than assumed, because each one
 * would otherwise be a plausible-looking bug:
 *
 *   - **The log is not the port.** `language_server.log` recorded 49361/49362
 *     while the live process was actually listening on 55026/55027, so the port
 *     comes from the process's own listening sockets, never from the log.
 *   - **There are two ports and only one is usable.** One is HTTPS/gRPC and
 *     answers "Client sent an HTTP request to an HTTPS server"; the other is
 *     the plain HTTP one this speaks to. The order is not stable (measured on
 *     Devin: either port can be the HTTP one), so the caller probes rather
 *     than trusting which is higher.
 *   - **Nothing here runs unless something changed.** Starting a daemon is
 *     expensive and it phones home on startup, so the caller decides — from the
 *     summaries database, which costs nothing — whether there is anything to
 *     ask about at all.
 */

export const SERVICE = "exa.language_server_pb.LanguageServerService";

/**
 * The header the daemon checks. Antigravity is a Codeium fork and kept the
 * vendor prefix, so the obvious `x-csrf-token` is silently not the one.
 */
export const CSRF_HEADER = "x-codeium-csrf-token";

export interface Daemon {
  pid: number;
  /** The plain-HTTP port. */
  port: number;
  csrfToken: string;
}

export type Runner = typeof spawnSync;

export interface ProcessInfo {
  pid: number;
  commandLine: string;
}

/** Live `language_server*` processes and the command lines they were given. */
export function listLanguageServers(opts: { run?: Runner } = {}): ProcessInfo[] {
  const run = opts.run ?? spawnSync;
  if (process.platform === "win32") {
    const r = run(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'language_server*' } | " +
          "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    return parseProcessLines(r.stdout ?? "");
  }
  const r = run("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  return parseProcessLines(r.stdout ?? "").filter((p) => /language_server/.test(p.commandLine));
}

export function parseProcessLines(stdout: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)[\t ]+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number.parseInt(m[1]!, 10);
    if (!Number.isFinite(pid)) continue;
    out.push({ pid, commandLine: m[2]! });
  }
  return out;
}

/**
 * The CSRF token the daemon was started with.
 *
 * `--csrf_token` guards the service this reads; `--extension_server_csrf_token`
 * guards a different one and is not interchangeable, so the flag is matched
 * exactly rather than by substring.
 */
export function csrfTokenOf(commandLine: string): string | null {
  const m = /(?:^|\s)--csrf_token[= ]+("[^"]+"|\S+)/.exec(commandLine);
  return m ? m[1]!.replace(/^"|"$/g, "") : null;
}

export type EnvLookup = (pid: number, name: string) => string | null;

export interface DiscoverOptions {
  run?: Runner;
  fetchImpl?: typeof globalThis.fetch;
  envOf?: EnvLookup;
}

/**
 * The token the daemon will accept, from whichever place this build put it.
 *
 * Antigravity writes `--csrf_token` on the command line. Devin / Windsurf
 * write `WINDSURF_CSRF_TOKEN` in the process environment and leave argv
 * without a token (measured, including after a restart). Argv wins when both
 * are present, because it is the one we can read without opening another
 * process's memory.
 */
export function csrfTokenFor(proc: ProcessInfo, opts: DiscoverOptions = {}): string | null {
  return csrfTokenOf(proc.commandLine) ?? readProcessEnvVar(proc.pid, WINDSURF_CSRF_ENV, opts);
}

/** One number per line: what PowerShell's `ForEach-Object { $_.LocalPort }` gives. */
export function parsePorts(stdout: string): number[] {
  const ports = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const n = Number.parseInt(line.trim(), 10);
    if (Number.isFinite(n) && n > 0) ports.add(n);
  }
  return [...ports].sort((a, b) => a - b);
}

/** `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` — macOS, and Linux where it exists. */
export function parseLsofPorts(stdout: string): number[] {
  const ports = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /:(\d+)\s*\(LISTEN\)/.exec(line);
    if (m) ports.add(Number.parseInt(m[1]!, 10));
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * `ss -ltnp` — the one that is actually present on a modern Linux.
 *
 * A row names every process holding the socket, so the pid has to be matched
 * inside `users:(("node",pid=1234,fd=20))` rather than assumed from the query:
 * `ss` filters by state, not by process.
 */
export function parseSsPorts(stdout: string, pid: number): number[] {
  const ports = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!new RegExp(`\\bpid=${pid}\\b`).test(line)) continue;
    // "127.0.0.1:55027" or "[::1]:55027", in the Local Address:Port column.
    const m = /\s(\S+):(\d+)\s+\S+:\S+/.exec(line);
    if (m) ports.add(Number.parseInt(m[2]!, 10));
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * The TCP ports a process is listening on, lowest first.
 *
 * Three platforms, three tools, and on Linux two of them: `ss` is what a
 * current distribution ships, `lsof` is what an older one has, and neither is
 * guaranteed. An empty answer means "could not tell", and the caller treats
 * that as "no daemon found" rather than as an error — the same outcome as
 * Antigravity not running, which is the honest reading.
 */
export function listeningPorts(pid: number, opts: { run?: Runner } = {}): number[] {
  const run = opts.run ?? spawnSync;

  if (process.platform === "win32") {
    const r = run(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -eq ${pid} } | ` +
          "ForEach-Object { $_.LocalPort }",
      ],
      { encoding: "utf8", windowsHide: true },
    );
    return parsePorts(r.stdout ?? "");
  }

  if (process.platform === "linux") {
    const ss = run("ss", ["-ltnp"], { encoding: "utf8" });
    if (!ss.error && ss.status === 0) {
      const ports = parseSsPorts(ss.stdout ?? "", pid);
      if (ports.length > 0) return ports;
    }
  }

  const lsof = run("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" });
  if (lsof.error) return [];
  return parseLsofPorts(lsof.stdout ?? "");
}

/**
 * Which of a daemon's ports speaks plain HTTP.
 *
 * Guessing wrong is cheap to detect — the HTTPS side answers with a plaintext
 * complaint rather than a response — so higher-first is only a heuristic. The
 * order is not stable across Codeium-lineage builds, and both ports are probed.
 */
export function httpPortCandidates(ports: ReadonlyArray<number>): number[] {
  return [...ports].sort((a, b) => b - a);
}

/**
 * We do not start the daemon, and cannot.
 *
 * Measured, with Antigravity closed: `agy agentapi` on its own only prints its
 * subcommand list, and `agy agentapi get-conversation-metadata <id>` exits 1
 * with `{"error":"ANTIGRAVITY_LS_ADDRESS is not set"}` — it is a client of a
 * daemon someone else started, not a way to start one.
 *
 * That leaves two ways to bring one up, and both are worse than not having the
 * feature. Running `language_server.exe` directly means inventing the whole
 * argument set of an undocumented vendor binary. Starting a real `agy` session
 * means making a billed model call in order to read local data. So the rule is
 * simply: use the daemon when the user already has Antigravity open, and say
 * plainly when they do not.
 */

export interface RpcResult {
  ok: boolean;
  status: number;
  body: unknown;
  detail: string;
}

/** One Connect-RPC call against the daemon. */
export async function callRpc(
  daemon: Pick<Daemon, "port" | "csrfToken">,
  method: string,
  payload: unknown,
  opts: { fetchImpl?: typeof globalThis.fetch; timeoutMs?: number } = {},
): Promise<RpcResult> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const url = `http://127.0.0.1:${daemon.port}/${SERVICE}/${method}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Codeium lineage shows through in the header name. Without it the
        // daemon answers {"code":"unauthenticated","message":"missing CSRF token"}.
        [CSRF_HEADER]: daemon.csrfToken,
      },
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* the HTTPS port answers with a plaintext complaint */
    }
    return { ok: res.ok, status: res.status, body, detail: res.ok ? "" : text.slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, body: null, detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every language server already running, without starting anything.
 *
 * Antigravity and Devin both answer the same RPC, and a daemon only knows its
 * own surface. Asking the first process we see can therefore be the wrong
 * one — so the caller tries each, and a missing token on argv is not a skip:
 * Devin keeps it in the process environment instead.
 *
 * An empty list is a normal state, not an error: the caller decides whether
 * that is worth starting one over.
 */
export async function findDaemons(opts: DiscoverOptions = {}): Promise<Daemon[]> {
  const found: Daemon[] = [];
  for (const proc of listLanguageServers(opts)) {
    const csrfToken = csrfTokenFor(proc, opts);
    if (!csrfToken) continue;
    for (const port of httpPortCandidates(listeningPorts(proc.pid, opts))) {
      // A probe, not a guess: the HTTPS port answers with a plaintext
      // complaint, and an unrelated port answers nothing at all.
      const probe = await callRpc({ port, csrfToken }, "GetAllCascadeTrajectories", {}, {
        fetchImpl: opts.fetchImpl,
        timeoutMs: 3000,
      });
      if (probe.status > 0 && typeof probe.body === "object") {
        found.push({ pid: proc.pid, port, csrfToken });
        break;
      }
    }
  }
  return found;
}

/** The first daemon that answers, or null when none is open. */
export async function findDaemon(opts: DiscoverOptions = {}): Promise<Daemon | null> {
  const all = await findDaemons(opts);
  return all[0] ?? null;
}

/**
 * How long a discovered daemon is trusted before looking again.
 *
 * Not a shutdown timer — we never start one, so we never stop one. It is a
 * cache lifetime: Antigravity picks fresh random ports every time it starts, so
 * an address learned ten minutes ago may now belong to nothing.
 */
export const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface SessionOptions extends DiscoverOptions {
  /** How long a discovered address is reused before it is looked up again. */
  ttlMs?: number;
  log?: (msg: string) => void;
  now?: () => number;
}

/**
 * A daemon address, found once and reused for a while.
 *
 * The MCP server answers one question at a time, seconds apart. Finding the
 * daemon means listing every process on the machine and probing its ports, so
 * doing it per question would cost more than the question is worth — and doing
 * it once forever would keep using an address that stops existing the moment
 * the user restarts Antigravity.
 */
export class DaemonSession {
  private daemons: Daemon[] | null = null;
  private foundAtMs = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: SessionOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** The first live daemon, or null when none is open. */
  async acquire(): Promise<Daemon | null> {
    const all = await this.acquireAll();
    return all[0] ?? null;
  }

  /**
   * Every live daemon. A conversation lives on one surface, and the first
   * process we see is not always that surface.
   */
  async acquireAll(): Promise<Daemon[]> {
    if (this.daemons && this.now() - this.foundAtMs < this.ttlMs) return this.daemons;

    const found = await findDaemons(this.opts);
    if (found.length === 0) {
      this.daemons = null;
      return [];
    }
    const ports = found.map((d) => d.port).join(",");
    const prev = this.daemons?.map((d) => d.port).join(",");
    if (prev !== ports) {
      this.opts.log?.(
        `language server: ${found.map((d) => `port ${d.port} (pid ${d.pid})`).join(", ")}`,
      );
    }
    this.daemons = found;
    this.foundAtMs = this.now();
    return this.daemons;
  }

  /** Forget the address, so the next call looks it up again. */
  release(): void {
    /* the TTL does this; kept so callers can be explicit */
  }

  close(): void {
    this.daemons = null;
    this.foundAtMs = 0;
  }
}
