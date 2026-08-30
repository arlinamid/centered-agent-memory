import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * Reading one environment variable out of another process on this machine.
 *
 * Three platforms, three tools — the same shape as `listeningPorts`:
 *
 *   - Linux: `/proc/<pid>/environ` (null-separated `KEY=VALUE`)
 *   - macOS: `sysctl -b kern.procargs2.<pid>`, then `ps eww` if sysctl is empty
 *   - Windows: the PEB, via `assets/read-process-env.ps1`
 *
 * Devin's language server is given `WINDSURF_CSRF_TOKEN` in its environment
 * rather than on the command line (measured). That is the same class of
 * process metadata as Antigravity's `--csrf_token` flag. We do not open the
 * parent pipe, and we do not write the value down.
 */

export type EnvRunner = typeof spawnSync;

export const WINDSURF_CSRF_ENV = "WINDSURF_CSRF_TOKEN";

/** Null-separated `KEY=VALUE` block, as `/proc/<pid>/environ` uses. */
export function parseEnvironBlock(data: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of data.split("\0")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
}

/**
 * `sysctl -b kern.procargs2.<pid>` — argc, exec path, argv, then env.
 *
 * The padding between the exec path and argv[0] is zeros; skipping them is
 * what keeps a short argv from swallowing the environment.
 */
export function parseKernProcargs2(buf: Buffer): Map<string, string> {
  if (buf.length < 5) return new Map();
  const argc = buf.readInt32LE(0);
  if (argc < 0 || argc > 4096) return new Map();
  let off = 4;
  const pathEnd = buf.indexOf(0, off);
  if (pathEnd < 0) return new Map();
  off = pathEnd + 1;
  for (let i = 0; i < argc; i++) {
    while (off < buf.length && buf[off] === 0) off++;
    const n = buf.indexOf(0, off);
    if (n < 0) return new Map();
    off = n + 1;
  }
  while (off < buf.length && buf[off] === 0) off++;
  return parseEnvironBlock(buf.slice(off).toString("utf8"));
}

/**
 * `ps eww -p <pid> -o command=` — the command, then `KEY=value` words.
 *
 * Values with spaces are not recovered; the CSRF token is a GUID and does
 * not have them. A fallback, not a parser of arbitrary environment values.
 */
export function parsePsEwwEnv(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of stdout.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g)) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

function windowsReader(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "read-process-env.ps1");
}

/**
 * One variable from a live process, or null when it is not there or cannot
 * be read. Overridable so the test suite never opens a real process.
 *
 * An empty answer means "could not tell", and the caller treats that as
 * "no token" — the same outcome as the daemon not running.
 */
export function readProcessEnvVar(
  pid: number,
  name: string,
  opts: { run?: EnvRunner; envOf?: (pid: number, name: string) => string | null } = {},
): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  if (opts.envOf) return opts.envOf(pid, name);

  const run = opts.run ?? spawnSync;

  if (process.platform === "linux") {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/environ`);
      return parseEnvironBlock(raw.toString("utf8")).get(name) ?? null;
    } catch {
      return null;
    }
  }

  if (process.platform === "darwin") {
    const sysctl = run("sysctl", ["-b", `kern.procargs2.${pid}`]);
    if (!sysctl.error && sysctl.status === 0 && sysctl.stdout && sysctl.stdout.length > 0) {
      const raw = Buffer.isBuffer(sysctl.stdout) ? sysctl.stdout : Buffer.from(sysctl.stdout);
      const found = parseKernProcargs2(raw).get(name);
      if (found) return found;
    }
    const ps = run("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
    if (ps.error || ps.status !== 0) return null;
    return parsePsEwwEnv(ps.stdout ?? "").get(name) ?? null;
  }

  if (process.platform === "win32") {
    const r = run(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-File", windowsReader(), "-ProcessId", String(pid), "-Name", name],
      { encoding: "utf8", windowsHide: true },
    );
    if (r.error || r.status !== 0) return null;
    const v = (r.stdout ?? "").replace(/\r?\n$/, "");
    return v.length > 0 ? v : null;
  }

  return null;
}
