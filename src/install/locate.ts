import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Finding the program, not the thing that starts it.
 *
 * Every one of these agent CLIs ships as a launcher with the executable behind
 * it, and the shape of the launcher differs by platform: a `.cmd` batch file on
 * Windows, a symlink into `lib/node_modules` on Linux and macOS, a Homebrew
 * shim, a shell wrapper. `where` and `which` answer with the launcher, and PATH
 * order decides which launcher, which is the wrong tie-breaker when a tool is
 * installed twice — the npm build and the native build of Codex sat on this
 * machine at different versions, and the shim in front was the broken one.
 *
 * So the entire PATH is searched, the launchers are read through to what they
 * would run, and the result is always one of two shapes: a native executable,
 * or `node <script>`. Both start without a shell, which matters because the
 * command recorded here is later run by a scheduler that has neither a shell
 * nor a PATH.
 */

export type BinKind = "native" | "script" | "launcher";

export interface Located {
  /** What to spawn. */
  bin: string;
  /** Argv that must come first — the script, when the program is one. */
  prefix: string[];
  kind: BinKind;
  /** The launcher we came in through, when that is not what we ended up with. */
  via: string;
}

const WINDOWS = process.platform === "win32";
const SCRIPT = /\.(js|mjs|cjs)$/i;
const LAUNCHER = /\.(cmd|bat)$/i;

/**
 * Places a tool may live that are not on the PATH of an unattended process.
 * A scheduled task inherits a minimal environment, and a GUI-installed tool is
 * often only on the interactive shell's PATH.
 */
export function knownDirs(home = os.homedir(), env = process.env): string[] {
  const dirs = WINDOWS
    ? [
        path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "Programs"),
        path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local")),
        path.join(env.PROGRAMFILES ?? "C:\\Program Files"),
      ]
    : ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", path.join(home, ".local", "bin"), path.join(home, "bin")];
  return dirs.filter((d) => d !== "");
}

/**
 * @param names  The command name, plus any aliases it is installed under.
 * @param extra  Provider-specific directories to look in after the PATH.
 */
export function locate(names: string[], extra: string[] = [], env = process.env): Located | null {
  const dirs = [...(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean), ...extra];

  const launchers: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      for (const file of variants(dir, name)) {
        if (!exists(file)) continue;
        // A launcher is remembered but not taken: a real executable further
        // down the PATH is the better answer, and we cannot know there is one
        // until the search finishes.
        if (WINDOWS && LAUNCHER.test(file)) {
          launchers.push(file);
          continue;
        }
        const real = follow(file);
        if (real) return real;
      }
    }
  }

  for (const launcher of launchers) {
    const behind = behindBatch(launcher);
    if (behind) return behind;
  }
  const fallback = launchers[0];
  return fallback === undefined ? null : { bin: fallback, prefix: [], kind: "launcher", via: fallback };
}

function variants(dir: string, name: string): string[] {
  return WINDOWS ? [path.join(dir, `${name}.exe`), path.join(dir, `${name}.cmd`), path.join(dir, `${name}.bat`)] : [path.join(dir, name)];
}

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve symlinks and shell wrappers until we are holding either a native
 * executable or a script, and say which.
 */
function follow(file: string): Located | null {
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    real = file;
  }

  // The usual npm layout on Linux and macOS: bin/tool is a symlink to a .js
  // with a shebang. Running it through an explicit node is steadier than
  // trusting `/usr/bin/env node` to find one in a cron environment.
  if (SCRIPT.test(real)) return { bin: process.execPath, prefix: [real], kind: "script", via: file };

  const wrapped = behindWrapper(real);
  if (wrapped) return { ...wrapped, via: file };

  return { bin: real, prefix: [], kind: "native", via: file };
}

/** Read the first bytes of a file without pulling a large binary into memory. */
function head(file: string, bytes = 4096): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    const text = buf.subarray(0, read).toString("utf8");
    // A native binary is not text; NUL in the first block is the cheap test.
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** A `#!/bin/sh` wrapper whose job is to exec a node script. */
function behindWrapper(file: string): Omit<Located, "via"> | null {
  const text = head(file);
  if (text === null || !text.startsWith("#!")) return null;
  if (SCRIPT.test(file)) return { bin: process.execPath, prefix: [file], kind: "script" };

  const m = /\bexec\s+(?:"?\$?\w*"?\s+)?"?([^"\s]+\.(?:js|mjs|cjs))"?/.exec(text);
  const script = m?.[1];
  if (script === undefined) return null;
  const target = path.isAbsolute(script) ? script : path.resolve(path.dirname(file), script);
  return exists(target) ? { bin: process.execPath, prefix: [target], kind: "script" } : null;
}

/** An npm-generated Windows batch shim, whose last line names the real target. */
function behindBatch(shim: string): Located | null {
  const text = head(shim);
  if (text === null) return null;

  const m = /"%_prog%"\s+"%dp0%\\(.+?)"/.exec(text) ?? /"%dp0%\\([^"]+\.(?:js|mjs|cjs|exe))"/.exec(text);
  const rel = m?.[1];
  if (rel === undefined) return null;

  const target = path.resolve(path.dirname(shim), rel);
  if (!exists(target)) return null;
  if (!SCRIPT.test(target)) return { bin: target, prefix: [], kind: "native", via: shim };

  // The shim prefers a node.exe beside it; that is the interpreter the tool was
  // installed against.
  const sibling = path.join(path.dirname(shim), "node.exe");
  const node = exists(sibling) ? sibling : process.execPath;
  return { bin: node, prefix: [target], kind: "script", via: shim };
}
