import type { Db } from "../db/open.js";
import { pruneResolutionCache } from "../attribution/resolve.js";

/**
 * Retention.
 *
 * Three things in this database grow without limit and nothing ever removed
 * them: the recall trace (`recall_events`, one row per hit per search), the run
 * log (`sync_runs`, one row per sync forever), and the sessions of sources that
 * have since disappeared — those keep turning up as "source missing" hits that
 * can never be read again.
 *
 * One rule constrains all of it: **evidence behind a live promotion is never
 * pruned**. The whole claim of the memory layer is that a promoted fact can
 * show when and to which questions it came back, and a retention sweep that
 * quietly emptied that proof would make the claim false. So the trace of a
 * chunk in `memory_facts` stays regardless of age, and only demotion (which is
 * consolidation's job, not this one's) can release it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionPolicy {
  /** Recall events older than this go, unless a promotion depends on them. */
  recallDays: number;
  /** Keep at most this many sync_runs rows, newest first. */
  keepRuns: number;
  /**
   * Drop sessions whose source has been missing for longer than this. Zero
   * disables it: a source can be missing because an external drive is not
   * mounted, and a hasty sweep would delete an index that would have come back.
   */
  missingDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  recallDays: 365,
  keepRuns: 500,
  missingDays: 0,
};

export interface PruneStat {
  recallEvents: number;
  /** Query texts left with no event pointing at them. */
  queries: number;
  syncRuns: number;
  /** Sessions removed with their turns and chunks, because the source is gone. */
  missingSessions: number;
  missingTurns: number;
  /** Recall events kept only because a live promotion cites them. */
  protectedEvents: number;
  resolutionCache: number;
  dryRun: boolean;
}

export interface PruneOptions {
  policy?: Partial<RetentionPolicy>;
  nowMs?: number;
  dryRun?: boolean;
}

/**
 * Count first, then delete. A dry run and a real run therefore report the same
 * numbers, which is the only way `--dry-run` is worth having.
 */
export function prune(db: Db, opts: PruneOptions = {}): PruneStat {
  const policy = { ...DEFAULT_RETENTION, ...(opts.policy ?? {}) };
  const nowMs = opts.nowMs ?? Date.now();
  const dryRun = opts.dryRun ?? false;

  const recallCutoff = nowMs - policy.recallDays * DAY_MS;
  const missingCutoff = nowMs - policy.missingDays * DAY_MS;

  const count = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql).get(...params) as { c: number }).c;

  const OLD_EVENTS = "recall_events where ts_ms < ?";
  const PROMOTED = "chunk_id in (select chunk_id from memory_facts)";

  const stat: PruneStat = {
    recallEvents: count(`select count(*) c from ${OLD_EVENTS} and not ${PROMOTED}`, recallCutoff),
    protectedEvents: count(`select count(*) c from ${OLD_EVENTS} and ${PROMOTED}`, recallCutoff),
    queries: 0,
    syncRuns: count(
      "select count(*) c from sync_runs where id not in (select id from sync_runs order by started_ms desc, id desc limit ?)",
      policy.keepRuns,
    ),
    missingSessions: 0,
    missingTurns: 0,
    resolutionCache: 0,
    dryRun,
  };

  // A missing source is only a candidate once it has been missing for a while
  // and the sync that noticed it is old enough to trust.
  const missing =
    policy.missingDays > 0
      ? (db
          .prepare(
            `select s.id from sessions s join sources src on src.id = s.source_id
             where src.status = 'missing' and coalesce(src.last_synced_ms, 0) < ?`,
          )
          .all(missingCutoff) as Array<{ id: number }>).map((r) => r.id)
      : [];

  if (missing.length > 0) {
    const list = missing.join(",");
    stat.missingSessions = missing.length;
    stat.missingTurns = count(`select count(*) c from turns where session_id in (${list})`);
  }

  if (dryRun) {
    // The orphan sweep depends on the deletes above, so on a dry run the best
    // honest answer is how many query texts would be left dangling.
    stat.queries = count(
      `select count(distinct query_hash) c from ${OLD_EVENTS} and not ${PROMOTED}
       and query_hash not in (select query_hash from recall_events where ts_ms >= ?)`,
      recallCutoff,
      recallCutoff,
    );
    stat.resolutionCache = count(
      "select count(*) c from path_keys where resource not in (select distinct resource from file_events)",
    );
    return stat;
  }

  const tx = db.transaction(() => {
    db.prepare(`delete from ${OLD_EVENTS} and not ${PROMOTED}`).run(recallCutoff);
    // A question nobody's trace refers to any more is not evidence of anything.
    stat.queries = db
      .prepare("delete from memory_queries where hash not in (select distinct query_hash from recall_events)")
      .run().changes;
    db.prepare(
      "delete from sync_runs where id not in (select id from sync_runs order by started_ms desc, id desc limit ?)",
    ).run(policy.keepRuns);
    if (missing.length > 0) {
      // ON DELETE CASCADE takes the turns and chunks; the chunks trigger takes
      // the contentless FTS rows with them.
      db.prepare(`delete from sessions where id in (${missing.join(",")})`).run();
    }
  });
  tx();

  stat.resolutionCache = pruneResolutionCache(db);
  return stat;
}

export interface ForgetTarget {
  project?: string | null;
  /** `tool:extId`, as `cam recall` cites it. */
  session?: string | null;
}

export interface ForgetStat {
  sessions: number;
  turns: number;
  chunks: number;
  facts: number;
  artifacts: number;
  dryRun: boolean;
}

export class ForgetTargetError extends Error {}

/**
 * Forget a project or a single session: the index rows go, the source files
 * are not touched, and a later `cam sync` will index them again unless the
 * source itself is gone. Forgetting is therefore about the index, not about the
 * history — the honest thing to tell the user, and the reason this is not
 * called "delete".
 */
export function forget(db: Db, target: ForgetTarget, opts: { dryRun?: boolean } = {}): ForgetStat {
  const dryRun = opts.dryRun ?? false;
  let ids: number[];

  if (target.project) {
    const project = db.prepare("select id from projects where key = ?").get(target.project) as
      | { id: number }
      | undefined;
    if (!project) throw new ForgetTargetError(`No such project: ${target.project}`);
    ids = (
      db.prepare("select id from sessions where project_id = ?").all(project.id) as Array<{ id: number }>
    ).map((r) => r.id);
  } else if (target.session) {
    const [tool, ...rest] = target.session.split(":");
    const extId = rest.join(":");
    if (!tool || !extId) throw new ForgetTargetError(`Unreadable citation: ${target.session}`);
    const row = db.prepare("select id from sessions where tool = ? and ext_id = ?").get(tool, extId) as
      | { id: number }
      | undefined;
    if (!row) throw new ForgetTargetError(`No such session: ${target.session}`);
    ids = [row.id];
  } else {
    throw new ForgetTargetError("Give a project or a session.");
  }

  const list = ids.join(",") || "-1";
  const count = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
  const stat: ForgetStat = {
    sessions: ids.length,
    turns: count(`select count(*) c from turns where session_id in (${list})`),
    chunks: count(`select count(*) c from chunks where session_id in (${list})`),
    facts: count(
      `select count(*) c from memory_facts where chunk_id in (select id from chunks where session_id in (${list}))`,
    ),
    artifacts: count(`select count(*) c from artifacts where session_id in (${list})`),
    dryRun,
  };
  if (dryRun || ids.length === 0) return stat;

  const tx = db.transaction(() => {
    db.prepare(`delete from sessions where id in (${list})`).run();
    // The project row itself only goes when nothing points at it any more; a
    // manual alias or attribution that outlived its sessions would otherwise
    // resurrect an empty project on the next reattribute.
    if (target.project) {
      db.prepare("delete from path_evidence where project_key = ?").run(target.project);
      db.prepare(
        "delete from projects where key = ? and not exists (select 1 from sessions where project_id = projects.id)",
      ).run(target.project);
    }
  });
  tx();
  return stat;
}

export interface VacuumStat {
  beforeBytes: number;
  afterBytes: number;
}

/**
 * Reclaim the free pages. Separate from `prune` because it rewrites the whole
 * file and cannot run inside a transaction, and because a scheduled prune
 * should not pay for it every night.
 */
export function vacuum(db: Db): VacuumStat {
  const size = (): number => {
    const p = db.pragma("page_count", { simple: true }) as number;
    const s = db.pragma("page_size", { simple: true }) as number;
    return p * s;
  };
  const beforeBytes = size();
  // WAL frames hold pages the vacuum would otherwise leave behind.
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("vacuum");
  return { beforeBytes, afterBytes: size() };
}
