import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFilePath, readConfigFile, type FileConfig } from "../config.js";
import { QMD_MODELS, modelsPresent, qmdCacheHome, qmdModelCacheDir, type QmdConfig } from "../qmd/runtime.js";

/**
 * Where the relevance models are allowed to land.
 *
 * This is a question and not a default because the answer is about the machine,
 * not the software: the three GGUF files are a little over two gigabytes, and
 * the drive a user's home directory happens to sit on is often the one with no
 * room left. Guessing wrong here does not fail politely — the download dies
 * partway with ENOSPC, after several minutes.
 */

/** Rather more than the weights need, so the choice survives a future model. */
export const MODELS_BYTES = 2.4 * 2 ** 30;

export interface Location {
  /** The cache root; models land in `<root>/qmd/models`. */
  cacheHome: string;
  label: string;
  freeBytes: number | null;
  /** Models already downloaded here. */
  cached: number;
}

export function freeBytes(dir: string): number | null {
  // Walk up to something that exists: a drive is reportable before the
  // directory on it has been created.
  let at = path.resolve(dir);
  for (;;) {
    try {
      const s = fs.statfsSync(at);
      return s.bavail * s.bsize;
    } catch {
      const up = path.dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
}

export const gb = (bytes: number | null): string => (bytes === null ? "?" : `${(bytes / 2 ** 30).toFixed(1)} GB`);

/** How many of the three are already sitting in this location. */
function cachedCount(cacheHome: string): number {
  const present = modelsPresent(QMD_MODELS, path.join(path.resolve(cacheHome), "qmd", "models"));
  return Object.values(present).filter(Boolean).length;
}

export function describe(cacheHome: string, label: string): Location {
  const root = path.resolve(cacheHome);
  return { cacheHome: root, label, freeBytes: freeBytes(root), cached: cachedCount(root) };
}

/**
 * The places worth offering: where the models already are, the home directory,
 * and every other fixed drive with room.
 *
 * Ordered by usefulness rather than by size — a location that already holds the
 * weights is the right answer even when a bigger drive exists, because the
 * alternative is downloading two gigabytes again.
 */
export function candidates(config: QmdConfig = {}, home = os.homedir()): Location[] {
  const out: Location[] = [];
  const seen = new Set<string>();
  const add = (dir: string, label: string): void => {
    const root = path.resolve(dir);
    const key = root.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(describe(root, label));
  };

  if (config.cacheHome) add(config.cacheHome, "configured");
  add(qmdCacheHome({}, home), "home directory");
  for (const root of otherRoots(home)) add(root, "other drive");

  return out.sort((a, b) => {
    if (a.cached !== b.cached) return b.cached - a.cached;
    return (b.freeBytes ?? 0) - (a.freeBytes ?? 0);
  });
}

/**
 * Fixed drives other than the one home is on, each with a `.cache` directory.
 *
 * Only drives that already exist are offered, and only on Windows is there more
 * than one root to consider; elsewhere the home directory is the answer and the
 * question is a formality with one option.
 */
function otherRoots(home: string): string[] {
  if (process.platform !== "win32") return [];
  const homeDrive = path.parse(path.resolve(home)).root.toUpperCase();
  const roots: string[] = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const root = `${letter}:\\`;
    if (root.toUpperCase() === homeDrive) continue;
    try {
      fs.accessSync(root);
    } catch {
      continue;
    }
    roots.push(path.join(root, ".cache"));
  }
  return roots;
}

export interface ModelPlan {
  cacheHome: string;
  modelsDir: string;
  freeBytes: number | null;
  cached: number;
  /** True when the chosen place cannot hold what is missing. */
  tooSmall: boolean;
}

export function plan(cacheHome: string): ModelPlan {
  const root = path.resolve(cacheHome);
  const cached = cachedCount(root);
  const free = freeBytes(root);
  const needed = MODELS_BYTES * ((3 - cached) / 3);
  return {
    cacheHome: root,
    modelsDir: qmdModelCacheDir({ cacheHome: root }),
    freeBytes: free,
    cached,
    tooSmall: free !== null && free < needed,
  };
}

/** Write the choice down, leaving every other setting exactly as it was. */
export function writeCacheHome(cacheHome: string, file = configFilePath()): void {
  const current: FileConfig = readConfigFile(file);
  const memory = { ...(current.memory ?? {}) };
  memory.qmd = { ...(memory.qmd ?? {}), cacheHome: path.resolve(cacheHome) };
  const next: FileConfig = { ...current, memory };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function readCacheHome(file = configFilePath()): string | null {
  return readConfigFile(file).memory?.qmd?.cacheHome ?? null;
}
