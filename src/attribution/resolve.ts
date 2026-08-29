import type { Db } from "../db/open.js";
import { excludedPrefixes, isRejectedSegment } from "../config.js";
import { ProjectResolver } from "./projkey.js";
import { detectWorkspaceRoots } from "./roots.js";

/**
 * Bumped whenever the cascade changes, so `doctor` can report drift.
 *
 * 2: manual evidence is no longer re-resolved as if it were a path, which
 *    silently discarded every `cam attribute` decision.
 */
export const RULE_VERSION = 2;

export type Confidence = "strong" | "medium" | "weak" | "none";

export interface AttributionStats {
  sessions: number;
  attributed: number;
  byMethod: Record<string, number>;
  roots: string[];
}

interface EvidenceRow {
  session_id: number;
  origin: string;
  raw_path: string;
  project_key: string | null;
  weight: number;
}

/**
 * Feed every session's own working directory into the evidence table. Other
 * collectors add their own evidence (Cursor file paths, Cowork folder picks)
 * with different origins and weights.
 */
export function collectCwdEvidence(db: Db): void {
  // Delete-then-refill in one transaction: a concurrent reader must never see
  // the gap where the evidence is gone.
  const tx = db.transaction(() => {
    db.prepare("delete from path_evidence where origin = 'cwd'").run();
    db.prepare(
      `insert into path_evidence(session_id, origin, raw_path, project_key, weight)
       select id, 'cwd', cwd_norm, null, 3 from sessions where cwd_norm is not null`,
    ).run();
  });
  tx();
}

/** Persist the workspace roots learned from the corpus, keeping manual ones. */
export function learnRoots(db: Db, minChildren = 3): string[] {
  const cwds = (db.prepare("select distinct cwd_norm from sessions where cwd_norm is not null").all() as Array<{
    cwd_norm: string;
  }>).map((r) => r.cwd_norm);

  // A root inside an excluded area (OS temp, the agents' own dotfile stores) is
  // scratch space, not a place where projects live. Same for a root whose own
  // name is a generated one.
  const excluded = excludedPrefixes();
  const detected = detectWorkspaceRoots(cwds, minChildren).filter(
    (d) =>
      !excluded.some((x) => d.root === x || d.root.startsWith(x + "/")) &&
      !isRejectedSegment(d.root.slice(d.root.lastIndexOf("/") + 1)),
  );
  const tx = db.transaction(() => {
    db.prepare("delete from workspace_roots where kind = 'learned'").run();
    const ins = db.prepare("insert or ignore into workspace_roots(root, children, kind) values (?,?, 'learned')");
    for (const d of detected) ins.run(d.root, d.children);
  });
  tx();

  return (db.prepare("select root from workspace_roots order by root").all() as Array<{ root: string }>).map(
    (r) => r.root,
  );
}

/** Window around a conversation in which a file edit counts as related. */
export const CORRELATION_MARGIN_MS = 30 * 60 * 1000;
const CORRELATION_MIN_EVENTS = 3;
const CORRELATION_MIN_SHARE = 0.5;

export interface FileEventResolution {
  /** Distinct resources seen in `file_events`. */
  resources: number;
  /** Of those, the ones that landed on a project. */
  resolved: number;
  /** Answered from `path_keys` without touching the filesystem. */
  cached: number;
  /** Actually resolved this run — the only part that costs anything. */
  computed: number;
}

/**
 * Resolve the file-history resources once, so the correlation query can group
 * by project instead of by path.
 *
 * The cursor-history collector reloads `file_events` wholesale every day, and
 * the reload writes a null `project_key`. Re-resolving every path afterwards
 * was the single most expensive step of a sync (~20 s of 26 on the reference
 * machine, for ~6 000 paths whose answers had not changed). The verdicts are
 * therefore kept in `path_keys` and survive the reload.
 *
 * `recompute` throws the cache away, which is what `cam reattribute` wants: a
 * new alias or workspace root changes the answers, and nothing else would
 * notice.
 */
export function resolveFileEvents(
  db: Db,
  resolver: ProjectResolver,
  opts: { recompute?: boolean } = {},
): FileEventResolution {
  const out: FileEventResolution = { resources: 0, resolved: 0, cached: 0, computed: 0 };

  if (opts.recompute) db.prepare("delete from path_keys").run();

  const unknown = db
    .prepare(
      `select distinct f.resource from file_events f
       left join path_keys k on k.resource = f.resource
       where k.resource is null`,
    )
    .all() as Array<{ resource: string }>;

  const remember = db.prepare("insert or replace into path_keys(resource, project_key, resolved_ms) values (?,?,?)");
  const nowMs = Date.now();
  const learnTx = db.transaction(() => {
    for (const r of unknown) remember.run(r.resource, resolver.key(r.resource), nowMs);
  });
  learnTx();
  out.computed = unknown.length;

  // One set-based update instead of a statement per path: the cache is the
  // authority, and file_events only mirrors it.
  db.prepare(
    `update file_events set project_key = (select k.project_key from path_keys k where k.resource = file_events.resource)`,
  ).run();

  const counts = db
    .prepare(
      `select count(*) n, count(project_key) hit from (select distinct resource, project_key from file_events)`,
    )
    .get() as { n: number; hit: number };
  out.resources = counts.n;
  out.resolved = counts.hit;
  out.cached = Math.max(0, out.resources - out.computed);
  return out;
}

/** Drop cached resolutions for resources that no longer appear in file_events. */
export function pruneResolutionCache(db: Db): number {
  const info = db
    .prepare("delete from path_keys where resource not in (select distinct resource from file_events)")
    .run();
  return info.changes;
}

/**
 * A Cursor conversation has no working directory, and many never mention a
 * path. For those, what the user was editing at the time is the only signal
 * left — weaker than a path, and marked as such.
 */
export function correlateTime(db: Db): number {
  const haveStrong = new Set(
    (
      db
        .prepare(
          `select distinct session_id from path_evidence
           where project_key is not null
             and origin in ('manual','cwd','user_selected_folders','ofs_key','bubble_scan','msg_request_ctx')`,
        )
        .all() as Array<{ session_id: number }>
    ).map((r) => r.session_id),
  );

  const sessions = db
    .prepare("select id, started_ms, ended_ms from sessions where started_ms is not null")
    .all() as Array<{ id: number; started_ms: number; ended_ms: number | null }>;

  const query = db.prepare(
    `select project_key, count(*) c from file_events
     where project_key is not null and ts_ms between ? and ?
     group by project_key order by c desc`,
  );

  let written = 0;
  const tx = db.transaction(() => {
    db.prepare("delete from path_evidence where origin in ('time_correlation','time_correlation_weak')").run();
    const ins = db.prepare(
      "insert into path_evidence(session_id, origin, raw_path, project_key, weight) values (?,?,?,?,1)",
    );
    for (const s of sessions) {
      if (haveStrong.has(s.id)) continue;
      const from = s.started_ms - CORRELATION_MARGIN_MS;
      const to = (s.ended_ms ?? s.started_ms) + CORRELATION_MARGIN_MS;
      const rows = query.all(from, to) as Array<{ project_key: string; c: number }>;
      if (rows.length === 0) continue;
      const total = rows.reduce((n, r) => n + r.c, 0);
      const top = rows[0]!;
      const origin =
        top.c >= CORRELATION_MIN_EVENTS && top.c / total >= CORRELATION_MIN_SHARE
          ? "time_correlation"
          : "time_correlation_weak";
      // The raw_path is the verdict itself here: correlation produces a
      // project, not a path, and the project_key is written directly.
      ins.run(s.id, origin, `~time:${top.c}/${total}`, top.project_key);
      written++;
    }
  });
  tx();
  return written;
}

export function makeResolver(db: Db): ProjectResolver {
  const roots = (db.prepare("select root from workspace_roots").all() as Array<{ root: string }>).map((r) => r.root);
  const aliases = new Map(
    (db.prepare("select alias, key from project_aliases").all() as Array<{ alias: string; key: string }>).map(
      (r) => [r.alias.toLowerCase(), r.key] as const,
    ),
  );
  const learned = new Map(
    (
      db.prepare("select root_path, key from projects where root_path is not null").all() as Array<{
        root_path: string;
        key: string;
      }>
    ).map((r) => [r.root_path, r.key] as const),
  );
  return new ProjectResolver({ excluded: excludedPrefixes(), workspaceRoots: roots, aliases, learned });
}

function upsertProject(db: Db, key: string, rootPath: string | null, nowMs: number): number {
  const existing = db.prepare("select id, root_path from projects where key = ?").get(key) as
    | { id: number; root_path: string | null }
    | undefined;
  if (existing) {
    if (!existing.root_path && rootPath) {
      db.prepare("update projects set root_path = ? where id = ?").run(rootPath, existing.id);
    }
    return existing.id;
  }
  const info = db
    .prepare("insert into projects(key, display_name, root_path, first_seen_ms, last_seen_ms) values (?,?,?,?,?)")
    .run(key, key, rootPath, nowMs, nowMs);
  return Number(info.lastInsertRowid);
}

/**
 * Recompute every verdict from stored evidence. No source store is touched, so
 * adding an alias or a root and re-running is a sub-second operation.
 */
export function reattribute(db: Db, nowMs = Date.now()): AttributionStats {
  const resolver = makeResolver(db);

  // Resolve the raw paths first: this is the only step that may touch the
  // filesystem, and it is cached per directory.
  const evidence = db.prepare("select * from path_evidence").all() as EvidenceRow[];
  const updateEvidence = db.prepare("update path_evidence set project_key = ? where session_id = ? and origin = ? and raw_path = ?");
  const resolvedRoot = new Map<string, string | null>();

  // Correlation evidence carries its verdict directly; so does a manual
  // decision, whose raw_path is a marker (`~manual:<key>`) and not a path.
  // Re-resolving those would resolve them to nothing and quietly undo the
  // user's own call — which is the one verdict that must survive this.
  const PRE_RESOLVED = new Set(["manual", "time_correlation", "time_correlation_weak"]);

  const evalTx = db.transaction(() => {
    for (const e of evidence) {
      if (PRE_RESOLVED.has(e.origin)) continue;
      const ref = resolver.resolve(e.raw_path);
      e.project_key = ref?.key ?? null;
      if (ref?.rootPath && ref.key) resolvedRoot.set(ref.key, ref.rootPath);
      updateEvidence.run(e.project_key, e.session_id, e.origin, e.raw_path);
    }
  });
  evalTx();

  const bySession = new Map<number, EvidenceRow[]>();
  for (const e of evidence) {
    let list = bySession.get(e.session_id);
    if (!list) bySession.set(e.session_id, (list = []));
    list.push(e);
  }

  const stats: AttributionStats = { sessions: 0, attributed: 0, byMethod: {}, roots: [] };
  const sessions = db.prepare("select id from sessions").all() as Array<{ id: number }>;

  const writeTx = db.transaction(() => {
    const upsertAttr = db.prepare(
      `insert into attribution(session_id, project_id, method, confidence, score,
                               runner_up_key, runner_up_score, computed_ms, rule_version)
       values (?,?,?,?,?,?,?,?,?)
       on conflict(session_id) do update set
         project_id = excluded.project_id, method = excluded.method, confidence = excluded.confidence,
         score = excluded.score, runner_up_key = excluded.runner_up_key,
         runner_up_score = excluded.runner_up_score, computed_ms = excluded.computed_ms,
         rule_version = excluded.rule_version`,
    );
    const setSessionProject = db.prepare("update sessions set project_id = ? where id = ?");
    const setChunkProject = db.prepare("update chunks set project_id = ? where session_id = ?");

    for (const { id } of sessions) {
      stats.sessions++;
      const rows = bySession.get(id) ?? [];
      const verdict = decide(rows);
      stats.byMethod[verdict.method] = (stats.byMethod[verdict.method] ?? 0) + 1;

      let projectId: number | null = null;
      if (verdict.key) {
        projectId = upsertProject(db, verdict.key, resolvedRoot.get(verdict.key) ?? null, nowMs);
        stats.attributed++;
      }
      upsertAttr.run(
        id,
        projectId,
        verdict.method,
        verdict.confidence,
        verdict.score,
        verdict.runnerUpKey,
        verdict.runnerUpScore,
        nowMs,
        RULE_VERSION,
      );
      setSessionProject.run(projectId, id);
      setChunkProject.run(projectId, id);
    }
  });
  writeTx();

  stats.roots = (db.prepare("select root from workspace_roots order by children desc").all() as Array<{
    root: string;
  }>).map((r) => r.root);
  return stats;
}

interface Verdict {
  key: string | null;
  method: string;
  confidence: Confidence;
  score: number | null;
  runnerUpKey: string | null;
  runnerUpScore: number | null;
}

/**
 * The cascade. Direct signals (a session's own working directory, the folders
 * a Cowork session was pointed at) beat inferred ones; a manual override beats
 * everything and survives re-running this.
 */
function decide(rows: ReadonlyArray<EvidenceRow>): Verdict {
  const none: Verdict = {
    key: null,
    method: "unattributed",
    confidence: "none",
    score: null,
    runnerUpKey: null,
    runnerUpScore: null,
  };
  if (rows.length === 0) return none;

  const order: Array<{ origins: string[]; method: string; confidence: Confidence }> = [
    { origins: ["manual"], method: "manual", confidence: "strong" },
    { origins: ["cwd", "user_selected_folders"], method: "cwd", confidence: "strong" },
    { origins: ["ofs_key"], method: "ofs_votes", confidence: "strong" },
    { origins: ["bubble_scan", "msg_request_ctx"], method: "msg_votes", confidence: "strong" },
    { origins: ["time_correlation"], method: "time_correlation", confidence: "medium" },
    { origins: ["time_correlation_weak"], method: "time_correlation", confidence: "weak" },
  ];

  for (const step of order) {
    const scores = new Map<string, number>();
    for (const r of rows) {
      if (!r.project_key || !step.origins.includes(r.origin)) continue;
      scores.set(r.project_key, (scores.get(r.project_key) ?? 0) + r.weight);
    }
    if (scores.size === 0) continue;

    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const [key, score] = ranked[0]!;
    const runner = ranked[1];
    return {
      key,
      method: step.method,
      confidence: step.confidence,
      score,
      runnerUpKey: runner?.[0] ?? null,
      runnerUpScore: runner?.[1] ?? null,
    };
  }
  return none;
}
