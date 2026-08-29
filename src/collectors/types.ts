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
