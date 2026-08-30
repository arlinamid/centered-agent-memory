import fs from "node:fs";
import type { Db } from "../db/open.js";
import type { ToolId } from "../db/schema.js";
import type { ResolvedRoots } from "../paths.js";

export interface SyncStat {
  sessions: number;
  turns: number;
  skipped: number;
  errors: number;
}

export const emptyStat = (): SyncStat => ({ sessions: 0, turns: 0, skipped: 0, errors: 0 });

export interface CollectorCtx {
  hub: Db;
  roots: ResolvedRoots;
  /** Read-only opener for another application's SQLite store. */
  openSource: (path: string) => Db;
  now: () => number;
  log: (msg: string) => void;
  /** Force a full re-read even when the watermark says nothing changed. */
  repair?: boolean;
  maxInlineBytes: number;
}

/**
 * Every path, database handle and clock arrives through the context, so a
 * collector can be pointed at fixtures and never touches the real machine
 * during tests.
 */
export interface Collector {
  readonly tool: ToolId;
  /** Display name, when several collectors feed the same tool. */
  readonly name?: string;
  sync(ctx: CollectorCtx): Promise<SyncStat>;
}

/**
 * Read a directory the caller has already found to exist.
 *
 * "Not installed" and "installed but unreadable" are different facts, and
 * collapsing them is how a permission problem surfaces as "you have no plans".
 * The absent case belongs to the caller's `existsSync`; a failure here is real,
 * so it is counted and named instead of swallowed.
 *
 * Returns null rather than an empty list, because for a collector that mirrors
 * a directory the two are opposites: an empty list means "delete what you have"
 * and null means "you learned nothing, change nothing".
 */
export function readDirOrNull(dir: string, ctx: CollectorCtx, stat: SyncStat): fs.Dirent[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    stat.errors++;
    ctx.log(`${dir}: nem olvasható — ${(err as Error).message}`);
    return null;
  }
}
