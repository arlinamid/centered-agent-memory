import { LOCK_STALE_MS, liveHolder } from "../db/lock.js";
import type { Db } from "../db/open.js";

/**
 * How old the index is.
 *
 * `sync_runs` was written from the first version and read by nobody, which is
 * the same as not having it. The failure this closes is specific: an agent
 * quoting a six-week-old answer in the belief that it is current. Every MCP
 * response carries this line, and `cam doctor` prints it.
 */

/** Past this, the index is reported as stale rather than merely old. */
export const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

export interface Freshness {
  /** Start of the most recent run that finished; null when none ever did. */
  lastRunMs: number | null;
  lastEndedMs: number | null;
  /** Age of that run's end, in ms. Null when nothing has ever finished. */
  ageMs: number | null;
  /** Errors reported by the last finished run. Non-zero means partial data. */
  errors: number;
  turnsAdded: number;
  /** A sync holding the lock right now, so the numbers are still moving. */
  running: boolean;
  stale: boolean;
  /** Runs that started and never wrote an end: crashed, killed, or power loss. */
  unfinished: number;
  sessions: number;
  turns: number;
}

interface RunRow {
  started_ms: number;
  ended_ms: number;
  errors: number;
  turns_added: number;
}

export function freshness(db: Db, nowMs = Date.now(), staleAfterMs = DEFAULT_STALE_MS): Freshness {
  const last = db
    .prepare(
      `select started_ms, ended_ms, errors, turns_added from sync_runs
       where ended_ms is not null order by ended_ms desc, id desc limit 1`,
    )
    .get() as RunRow | undefined;

  // A run whose end is missing may still be in flight, so only the ones older
  // than the lock's own staleness window count as abandoned.
  const unfinished = (
    db.prepare("select count(*) c from sync_runs where ended_ms is null and started_ms < ?").get(nowMs - LOCK_STALE_MS) as {
      c: number;
    }
  ).c;

  const counts = db
    .prepare("select (select count(*) from sessions) s, (select count(*) from turns) t")
    .get() as { s: number; t: number };

  const ageMs = last ? Math.max(0, nowMs - last.ended_ms) : null;
  return {
    lastRunMs: last?.started_ms ?? null,
    lastEndedMs: last?.ended_ms ?? null,
    ageMs,
    errors: last?.errors ?? 0,
    turnsAdded: last?.turns_added ?? 0,
    running: liveHolder(db, nowMs) !== null,
    stale: ageMs === null || ageMs > staleAfterMs,
    unfinished,
    sessions: counts.s,
    turns: counts.t,
  };
}

/** Coarse on purpose: the decision it supports is "trust this or re-sync". */
export function humanAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The one-line form appended to every MCP response. It has to be readable by a
 * model at a glance and never absent — an index with no line at all would be
 * indistinguishable from a fresh one.
 */
export function formatFreshness(f: Freshness): string {
  if (f.lastEndedMs === null) {
    const started = f.unfinished > 0 ? ", and an earlier run was interrupted" : "";
    return `— index: no sync has finished yet${started}; contents may be incomplete (cam sync)`;
  }

  const parts = [
    `— index: ${new Date(f.lastEndedMs).toISOString().slice(0, 16).replace("T", " ")} UTC (${humanAge(f.ageMs ?? 0)})`,
    `${f.sessions} session`,
    `${f.turns} turn`,
  ];
  if (f.stale) parts.push("STALE, run: cam sync");
  if (f.errors > 0) parts.push(`${f.errors} error(s) in the last sync`);
  if (f.running) parts.push("a sync is running");
  return parts.join(" · ");
}

/** Multi-line form for `cam doctor` and `cam_status`. */
export function describeFreshness(f: Freshness): string {
  const L: string[] = [];
  L.push(
    f.lastEndedMs === null
      ? "last sync         no finished run yet"
      : `last sync         ${new Date(f.lastEndedMs).toISOString().slice(0, 16).replace("T", " ")} UTC` +
          `  (${humanAge(f.ageMs ?? 0)}${f.stale ? ", stale" : ""})`,
  );
  L.push(`contents          ${f.sessions} session · ${f.turns} turn`);
  if (f.turnsAdded > 0) L.push(`last run          ${f.turnsAdded} new turn(s)`);
  if (f.errors > 0) L.push(`  ! ${f.errors} error(s) in the last sync`);
  if (f.unfinished > 0) L.push(`  ! ${f.unfinished} interrupted run(s) (cam prune cleans these)`);
  if (f.running) L.push("  ! a sync is running");
  return L.join("\n");
}
