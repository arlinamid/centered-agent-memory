import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DreamConfig } from "./memory/dream.js";
import { DEFAULT_STALE_MS } from "./ops/freshness.js";
import type { RetentionPolicy } from "./ops/prune.js";
import { defaultRoots, normalizePath, type ResolvedRoots } from "./paths.js";

export interface HubConfig {
  dbPath: string;
  roots: ResolvedRoots;
  /** Inline-capture ceiling for volatile sources (Temp scratchpads, Cowork outputs). */
  maxInlineBytes: number;
  /**
   * The dream phase's model. Configuration rather than code on purpose: which
   * model writes the digests is a decision that can change without a rebuild,
   * and "none" (the default) sends nothing anywhere.
   */
  dream: DreamConfig;
  /** What `cam prune` removes. Empty means the built-in policy applies. */
  retention: Partial<RetentionPolicy>;
  /** Past this age the index reports itself as stale, everywhere it is quoted. */
  staleAfterMs: number;
}

/** Directory name used under the user's data and config directories. */
export const APP_DIR = "centered-agent-memory";

function installRoot(): string {
  // src/config.ts or dist/config.js -> package root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Where the index lives when nothing says otherwise: a user data directory, not
 * the install directory. A globally installed package would otherwise write
 * under `node_modules`, and an `npx` run would throw the index away between
 * invocations.
 */
export function userDataDir(home = os.homedir()): string {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), APP_DIR);
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), APP_DIR);
}

/** Same idea for the config file: XDG on POSIX, APPDATA on Windows. */
export function userConfigDir(home = os.homedir()): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), APP_DIR);
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), APP_DIR);
}

export function configFilePath(home = os.homedir()): string {
  return process.env.CAM_CONFIG ?? path.join(userConfigDir(home), "config.json");
}

/**
 * A checkout that already has an index keeps using it. Without this a `git
 * pull` would look like the history had vanished, because the default moved.
 */
function checkoutDb(): string | null {
  const p = path.join(installRoot(), ".data", "hub.sqlite");
  return fs.existsSync(p) ? p : null;
}

export interface FileConfig {
  dbPath?: string;
  maxInlineBytes?: number;
  /** Any subset of the ten store locations. */
  roots?: Partial<ResolvedRoots>;
  /** The memory layer. Only the dream phase has anything to configure. */
  memory?: { dream?: DreamConfig };
  retention?: Partial<RetentionPolicy>;
  /** Hours, because that is the unit the answer is thought about in. */
  staleAfterHours?: number;
}

/**
 * The config file is optional and never required to be valid: a broken one is
 * reported and ignored, because a typo in it must not make the tool unusable.
 */
export function readConfigFile(file = configFilePath(), warn?: (msg: string) => void): FileConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) throw new Error("nem objektum");
    return parsed as FileConfig;
  } catch (err) {
    warn?.(`a konfigurációs fájl nem olvasható (${file}): ${(err as Error).message}`);
    return {};
  }
}

/**
 * Precedence, strongest first: explicit override (the `--db` flag), environment
 * variable, config file, built-in default.
 *
 * `CAM_DB` moves the index, `CAM_HOME` moves the profile the source stores are
 * resolved from, `CAM_CONFIG` moves the config file. The second one exists so
 * the CLI can be exercised end to end against a fixture profile instead of the
 * real machine.
 */
export function loadConfig(overrides: Partial<HubConfig> = {}, warn?: (msg: string) => void): HubConfig {
  const file = readConfigFile(configFilePath(), warn);
  const home = process.env.CAM_HOME || undefined;

  return {
    dbPath:
      overrides.dbPath ??
      process.env.CAM_DB ??
      file.dbPath ??
      checkoutDb() ??
      path.join(userDataDir(home), "hub.sqlite"),
    roots: overrides.roots ?? { ...defaultRoots(home), ...(file.roots ?? {}) },
    maxInlineBytes: overrides.maxInlineBytes ?? file.maxInlineBytes ?? 256 * 1024,
    dream: overrides.dream ?? file.memory?.dream ?? {},
    retention: overrides.retention ?? file.retention ?? {},
    staleAfterMs:
      overrides.staleAfterMs ??
      (typeof file.staleAfterHours === "number" && file.staleAfterHours > 0
        ? file.staleAfterHours * 60 * 60 * 1000
        : DEFAULT_STALE_MS),
  };
}

/**
 * Filesystem markers that identify a directory as a project root. Checked
 * nearest-ancestor-first, so a monorepo package wins over the repo when it
 * carries its own marker.
 */
export const PROJECT_MARKERS: ReadonlyArray<string> = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "composer.json",
  "Gemfile",
  "CMakeLists.txt",
  "requirements.txt",
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
];

/**
 * Directory names that never identify a project — generic build/scratch
 * folders, and machine-generated names. Agent tooling creates a directory per
 * run (`codex-runs/<uuid>`, `job-research_metadata-20260826-212306`); those are
 * runs of a project, not projects.
 */
export function isRejectedSegment(seg: string): boolean {
  const s = seg.toLowerCase();
  if (!s || s === "." || s === "..") return true;
  if (REJECTED.has(s)) return true;
  if (/^new folder( \(\d+\))?$/.test(s)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) return true; // uuid
  if (/^[0-9a-f]{16,}$/.test(s)) return true; // hash
  if (/\d{8}[-_]\d{6}/.test(s)) return true; // timestamped run
  if (/^(tmp|temp|scratch|run|job)[-_.]/.test(s)) return true;
  return false;
}

const REJECTED = new Set([
  "node_modules",
  "temp",
  "tmp",
  "appdata",
  "windows",
  "program files",
  "program files (x86)",
  "users",
  "home",
  "library",
  "system32",
  "dist",
  "build",
  "out",
  ".git",
  ".cache",
  "src",
  "backend",
  "frontend",
  "codex-runs",
  "worktrees",
  "sessions",
]);

/**
 * Directories under which we refuse to look for projects at all: the user's
 * own dotfile stores and OS scratch areas. Derived from the running profile,
 * never hardcoded.
 */
export function excludedPrefixes(home = os.homedir()): string[] {
  const raw = [
    path.join(home, ".claude"),
    path.join(home, ".codex"),
    path.join(home, ".vscode"),
    path.join(home, ".cursor"),
    os.tmpdir(),
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    process.env.ProgramFiles,
    "/usr",
    "/etc",
    "/var",
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
  return raw.map((p) => normalizePath(p)).filter((p): p is string => p !== null);
}
