import os from "node:os";
import path from "node:path";

/**
 * Where each source store lives. Resolved per platform and per user profile —
 * nothing here is hardcoded to a machine. Injected through CollectorCtx so
 * tests can point somewhere else entirely.
 */
export interface ResolvedRoots {
  claudeHome: string;
  claudeProjects: string;
  claudePlans: string;
  codexHome: string;
  codexStateDb: string;
  desktopSessions: string;
  coworkSessions: string;
  cursorStateDb: string;
  cursorHistory: string;
  claudeTemp: string;
  geminiHome: string;
  geminiTmp: string;
  /** IDE surface. Shares its conversation set with `antigravityIde`. */
  antigravityHome: string;
  antigravityIde: string;
  antigravityCli: string;
  /** Electron app data: `Local State` and the VS Code global storage. */
  antigravityState: string;
  devinCliHome: string;
  windsurfHome: string;
}

/**
 * Per-platform application-data directory for an Electron-style app.
 *
 * `APPDATA` and `XDG_CONFIG_HOME` describe the profile the process is running
 * as, so they are only consulted when the caller means that profile. Given some
 * other home — a fixture, or another user's — they would silently redirect the
 * answer back to this one, which is how a test that thinks it is writing into a
 * temporary directory ends up editing the real Claude Desktop config.
 */
export function appSupportDir(appName: string, home = os.homedir()): string {
  const ownProfile = home === os.homedir();
  switch (process.platform) {
    case "win32":
      return path.join(
        ownProfile && process.env.APPDATA ? process.env.APPDATA : path.join(home, "AppData", "Roaming"),
        appName,
      );
    case "darwin":
      return path.join(home, "Library", "Application Support", appName);
    default:
      return path.join(
        ownProfile && process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : path.join(home, ".config"),
        appName,
      );
  }
}

export function defaultRoots(home = os.homedir()): ResolvedRoots {
  const claudeApp = appSupportDir("Claude", home);
  const cursorUser = path.join(appSupportDir("Cursor", home), "User");
  return {
    claudeHome: path.join(home, ".claude"),
    claudeProjects: path.join(home, ".claude", "projects"),
    claudePlans: path.join(home, ".claude", "plans"),
    codexHome: path.join(home, ".codex"),
    codexStateDb: path.join(home, ".codex", "state_5.sqlite"),
    desktopSessions: path.join(claudeApp, "claude-code-sessions"),
    coworkSessions: path.join(claudeApp, "local-agent-mode-sessions"),
    cursorStateDb: path.join(cursorUser, "globalStorage", "state.vscdb"),
    cursorHistory: path.join(cursorUser, "History"),
    claudeTemp: path.join(os.tmpdir(), "claude"),
    geminiHome: path.join(home, ".gemini"),
    geminiTmp: path.join(home, ".gemini", "tmp"),
    antigravityHome: path.join(home, ".gemini", "antigravity"),
    antigravityIde: path.join(home, ".gemini", "antigravity-ide"),
    antigravityCli: path.join(home, ".gemini", "antigravity-cli"),
    antigravityState: appSupportDir("Antigravity", home),
    devinCliHome: path.join(appSupportDir("devin", home), "cli"),
    windsurfHome: path.join(home, ".codeium", "windsurf"),
  };
}

/**
 * Windows and macOS paths compare case-insensitively; POSIX ones do not.
 *
 * Overridable through `CAM_CASE_FOLD` (`1`/`0`), because the folding decision
 * is baked into every stored path: an index written on Windows holds lowercase
 * paths, and reading it on Linux with folding off finds nothing. The test suite
 * pins it so the same expectations hold on every platform.
 */
export const CASE_INSENSITIVE_FS =
  process.env.CAM_CASE_FOLD !== undefined
    ? process.env.CAM_CASE_FOLD === "1"
    : process.platform === "win32" || process.platform === "darwin";

/**
 * Normalize any path or file URI to a comparable absolute form, or null when
 * it is not an absolute local filesystem path. Handles both Windows drive
 * paths and POSIX paths, on any host.
 */
export function normalizePath(raw: string | null | undefined, caseFold = CASE_INSENSITIVE_FS): string | null {
  if (!raw) return null;
  let p = String(raw).trim();
  if (!p) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) && !/^file:\/\//i.test(p)) return null;
  if (/^(untitled|data|vscode-[a-z-]+|output|inmemory):/i.test(p)) return null;

  const wasFileUri = /^file:\/\//i.test(p);
  if (wasFileUri) {
    p = p.replace(/^file:\/\//i, "");
    // Decode per segment: a stray '%' in one filename must not discard the path.
    p = p
      .split("/")
      .map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg;
        }
      })
      .join("/");
  }

  p = p.replace(/\\/g, "/");
  p = p.replace(/^\/\/\?\//, ""); // \\?\ long-path prefix
  p = p.replace(/^\/+([a-zA-Z]:)/, "$1"); // /C:/foo (file URI form) -> C:/foo

  const isWindows = /^[a-zA-Z]:\//.test(p);
  const isPosix = p.startsWith("/");
  if (!isWindows && !isPosix) return null;

  p = p.replace(/\/+/g, "/").replace(/(.)\/+$/, "$1");
  if (caseFold) p = p.toLowerCase();

  return p.length >= 2 ? p : null;
}

/** Ancestor chain of a normalized path, nearest first, excluding the root. */
export function ancestors(normalized: string): string[] {
  const out: string[] = [];
  let cur = normalized;
  for (;;) {
    const idx = cur.lastIndexOf("/");
    if (idx <= 0) break;
    const parent = cur.slice(0, idx);
    if (/^[a-zA-Z]:$/.test(parent)) break; // drive root
    out.push(parent);
    cur = parent;
  }
  return out;
}

export function basename(normalized: string): string {
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}
