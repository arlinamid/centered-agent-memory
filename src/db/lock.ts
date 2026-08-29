import os from "node:os";
import type { Db } from "./open.js";

/**
 * Advisory lock for the writing commands.
 *
 * A sync deletes and refills whole tables (`file_events`, the `cwd` slice of
 * `path_evidence`, the learned `workspace_roots`). Each of those is a
 * transaction, so a reader never sees an empty table — but two syncs running at
 * once would race on the watermarks and interleave their refills. The second
 * one steps back instead.
 *
 * The lock lives in `meta` rather than in a lock file: it travels with the
 * database, so a hub on a synced folder cannot be locked by a stale file on
 * another machine.
 */

export const LOCK_KEY = "sync_lock";

/** A holder that outlives this is assumed dead: a crashed sync must not wedge the hub. */
export const LOCK_STALE_MS = 60 * 60 * 1000;

export interface LockHolder {
  pid: number;
  host: string;
  startedMs: number;
  what: string;
}

export interface LockHandle {
  release(): void;
}

export type LockResult = { ok: true; handle: LockHandle } | { ok: false; heldBy: LockHolder };

function readHolder(db: Db): LockHolder | null {
  const row = db.prepare("select value from meta where key = ?").get(LOCK_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<LockHolder>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedMs !== "number") return null;
    return {
      pid: parsed.pid,
      host: String(parsed.host ?? ""),
      startedMs: parsed.startedMs,
      what: String(parsed.what ?? "sync"),
    };
  } catch {
    return null; // A garbled lock is no lock.
  }
}

/**
 * Is the recorded holder still running? Only answerable for our own machine;
 * elsewhere the age is all we have.
 */
function holderAlive(holder: LockHolder, nowMs: number, pid: number): boolean {
  if (nowMs - holder.startedMs > LOCK_STALE_MS) return false;
  if (holder.host !== os.hostname()) return true;
  if (holder.pid === pid) return false; // our own leftover
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch {
    return false; // no such process
  }
}

/**
 * The holder that is actually still running, or null. Separate from
 * `acquireLock` because reporting whether a sync is in flight must not take
 * the lock over as a side effect.
 */
export function liveHolder(db: Db, nowMs = Date.now(), pid = process.pid): LockHolder | null {
  const holder = readHolder(db);
  return holder && holderAlive(holder, nowMs, pid) ? holder : null;
}

export function acquireLock(
  db: Db,
  what = "sync",
  nowMs = Date.now(),
  pid = process.pid,
): LockResult {
  let blocked: LockHolder | null = null;

  // IMMEDIATE: two processes must not both read "free" and then both write.
  const tx = db.transaction(() => {
    const holder = readHolder(db);
    if (holder && holderAlive(holder, nowMs, pid)) {
      blocked = holder;
      return;
    }
    const mine: LockHolder = { pid, host: os.hostname(), startedMs: nowMs, what };
    db.prepare("insert or replace into meta(key, value) values (?, ?)").run(LOCK_KEY, JSON.stringify(mine));
  });
  tx.immediate();

  if (blocked) return { ok: false, heldBy: blocked };

  let released = false;
  return {
    ok: true,
    handle: {
      release(): void {
        if (released) return;
        released = true;
        // Only ever drop our own lock: a takeover of a stale one may have
        // happened in between.
        const holder = readHolder(db);
        if (holder && holder.pid === pid && holder.host === os.hostname()) {
          db.prepare("delete from meta where key = ?").run(LOCK_KEY);
        }
      },
    },
  };
}

export function describeHolder(h: LockHolder, nowMs = Date.now()): string {
  const age = Math.max(0, Math.round((nowMs - h.startedMs) / 1000));
  return `pid ${h.pid} @ ${h.host || "?"}, ${age} s óta`;
}
