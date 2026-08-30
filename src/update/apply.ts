import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Release } from "./check.js";

/**
 * Installing a release that has already been found.
 *
 * Split from the check on purpose: `cam update --check` never reaches this
 * file, so "tell me whether I am behind" and "change what is installed" are
 * two different decisions, taken separately.
 */

export interface DownloadResult {
  file: string;
  bytes: number;
}

/** Fetch the release tarball into a temporary directory. */
export async function downloadRelease(
  release: Release,
  opts: { fetchImpl?: typeof globalThis.fetch; dir?: string } = {},
): Promise<DownloadResult> {
  if (!release.assetUrl || !release.assetName) {
    throw new Error(`release ${release.tag} has no packed tarball attached`);
  }
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const res = await doFetch(release.assetUrl, {
    headers: { accept: "application/octet-stream", "user-agent": "centered-agent-memory" },
  });
  if (!res.ok) throw new Error(`downloading ${release.assetName}: HTTP ${res.status}`);

  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "cam-update-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, release.assetName);
  const body = Buffer.from(await res.arrayBuffer());
  // A truncated download must not be handed to npm as if it were a package.
  if (body.length === 0) throw new Error(`${release.assetName} came back empty`);
  fs.writeFileSync(file, body);
  return { file, bytes: body.length };
}

/** Where npm keeps global packages, or null when it will not say. */
export function npmInvocation(explicit?: string): { cmd: string; prefix: string[] } {
  if (explicit) return { cmd: explicit, prefix: [] };
  if (process.platform !== "win32") return { cmd: "npm", prefix: [] };
  // Node 20+ refuses to spawn a .cmd without `shell: true` (EINVAL). The
  // CLI next to this node is an ordinary JS file and does not flash a console.
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(cli)) return { cmd: process.execPath, prefix: [cli] };
  return { cmd: process.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", "npm"] };
}

export function globalRoot(opts: { npm?: string; run?: typeof spawnSync } = {}): string | null {
  const { cmd, prefix } = npmInvocation(opts.npm);
  const run = opts.run ?? spawnSync;
  const r = run(cmd, [...prefix, "root", "-g"], { encoding: "utf8", windowsHide: true, shell: false });
  if (r.error || r.status !== 0) return null;
  const out = (r.stdout ?? "").trim();
  return out === "" ? null : out;
}

/** The package directory the running code was loaded from. */
export function runningRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const within = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/**
 * Is the copy that is running the copy npm is about to overwrite?
 *
 * If it is, installing in-process is a program replacing its own files while
 * they are open — which on Windows npm simply cannot do, and which everywhere
 * leaves a process running code that no longer matches what is on disk. A
 * checkout run with `node dist/cli.js` is a different directory from the
 * global one, and has no such problem.
 */
export function isSelfReplacing(opts: { npm?: string; run?: typeof spawnSync; self?: string } = {}): boolean {
  const root = globalRoot(opts);
  if (!root) return false;
  try {
    return within(fs.realpathSync(root), fs.realpathSync(opts.self ?? runningRoot()));
  } catch {
    return false;
  }
}

export interface InstallResult {
  ok: boolean;
  command: string;
  detail: string;
}

/**
 * Hand the tarball to npm.
 *
 * `npm install -g <file>` is the whole mechanism. The package is not on a
 * registry, so there is no version to resolve and nothing to look up: npm is
 * being used as an unpacker that knows where global binaries go on this
 * platform.
 */
export function installTarball(file: string, opts: { npm?: string; run?: typeof spawnSync } = {}): InstallResult {
  const { cmd, prefix } = npmInvocation(opts.npm);
  const args = [...prefix, "install", "-g", file];
  const run = opts.run ?? spawnSync;
  const r = run(cmd, args, { encoding: "utf8", windowsHide: true, shell: false });

  const command = `${cmd} ${args.join(" ")}`;
  if (r.error) return { ok: false, command, detail: r.error.message };
  if (r.status !== 0) {
    const text = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().split("\n").filter(Boolean);
    return { ok: false, command, detail: `exit ${r.status}: ${text[text.length - 1] ?? "no output"}` };
  }
  return { ok: true, command, detail: (r.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "" };
}

/**
 * The script that performs a self-replacing update, from outside the package.
 *
 * It is written to a temporary directory and imports nothing but Node built-ins
 * — every file it could have imported is one npm is about to overwrite. It
 * waits for the process that spawned it to exit, then installs, then opens the
 * index with the newly installed binary so the migration happens now rather
 * than in the next unattended job. Everything it does goes to a log file,
 * because by then nobody is watching its output.
 */
export function updaterScript(): string {
  return `import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [tarball, parentPid, logFile, dbPath, npm] = process.argv.slice(2);
const say = (line) => fs.appendFileSync(logFile, line + "\\n", "utf8");

const gone = (pid) => {
  try {
    process.kill(Number(pid), 0);
    return false;
  } catch {
    return true;
  }
};

const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const runNpm = (args) =>
  fs.existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...args], { encoding: "utf8", windowsHide: true })
    : spawnSync(npm, args, { encoding: "utf8", windowsHide: true });

// Wait for the caller to let go of its own files before replacing them.
const deadline = Date.now() + 30000;
while (!gone(parentPid) && Date.now() < deadline) {
  spawnSync(process.execPath, ["-e", "setTimeout(()=>{},200)"]);
}
say(gone(parentPid) ? "parent exited" : "parent still running after 30s - continuing anyway");

if (process.platform === "win32") {
  spawnSync("powershell", [
    "-NoProfile", "-WindowStyle", "Hidden", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'cam-mcp|dist[\\\\/]mcp[\\\\/]server\\\\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ], { windowsHide: true });
}

const install = runNpm(["install", "-g", tarball]);
if (install.error || install.status !== 0) {
  say("FAILED: " + (install.error ? install.error.message : (install.stderr || install.stdout || "").trim()));
  say("The previous version is still installed.");
  process.exit(1);
}
say("installed: " + tarball);

const root = runNpm(["root", "-g"]);
const cli = path.join((root.stdout || "").trim(), "centered-agent-memory", "dist", "cli.js");
const migrate = spawnSync(process.execPath, [cli, "status", "--db", dbPath, "--quiet"], {
  encoding: "utf8",
  windowsHide: true,
});
if (migrate.error) say("index migrates on first use (could not run " + cli + ": " + migrate.error.message + ")");
else if (migrate.status !== 0) say("MIGRATION FAILED: " + (migrate.stderr || migrate.stdout || "").trim());
else say("index migrated and readable by the new version");

say("done");
`;
}

export interface StagedUpdate {
  script: string;
  logFile: string;
  pid: number | null;
}

/**
 * Write the updater out and start it detached, so it outlives this process.
 *
 * `process.execPath` rather than `node`: the copy of Node that is running this
 * is known to exist and known to be new enough, and PATH in a scheduled job is
 * not the PATH in a terminal.
 */
export function stageUpdater(opts: {
  tarball: string;
  dbPath: string;
  dir?: string;
  npm?: string;
  cam?: string;
  spawnImpl?: typeof spawn;
}): StagedUpdate {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "cam-updater-"));
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "cam-update.mjs");
  const logFile = path.join(dir, "cam-update.log");
  fs.writeFileSync(script, updaterScript(), "utf8");
  fs.writeFileSync(logFile, `cam update ${new Date().toISOString()}\n`, "utf8");

  const npm = opts.npm ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  const start = opts.spawnImpl ?? spawn;

  const child = start(
    process.execPath,
    [script, opts.tarball, String(process.pid), logFile, opts.dbPath, npm],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  return { script, logFile, pid: child.pid ?? null };
}
