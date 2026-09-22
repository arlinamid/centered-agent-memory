import type { Db } from "../db/open.js";

export interface TimelineEntry {
  tool: string;
  sessionExtId: string;
  title: string | null;
  turns: number;
  startedMs: number | null;
  endedMs: number | null;
  role: string;
  agentRole: string | null;
  parentExtId: string | null;
  confidence: string;
  method: string | null;
}

export interface TimelineOptions {
  project: string;
  sinceMs?: number | null;
  untilMs?: number | null;
  tools?: string[] | null;
  includeSubagents?: boolean;
  limit?: number;
}

/** Pure index range scan: no text is touched, so this stays in single digits of ms. */
export function timeline(db: Db, opts: TimelineOptions): TimelineEntry[] {
  const where = ["p.key = ?"];
  const params: Array<string | number> = [opts.project];
  if (opts.sinceMs != null) {
    where.push("s.started_ms >= ?");
    params.push(opts.sinceMs);
  }
  if (opts.untilMs != null) {
    where.push("s.started_ms <= ?");
    params.push(opts.untilMs);
  }
  if (opts.tools?.length) {
    where.push(`s.tool in (${opts.tools.map(() => "?").join(",")})`);
    params.push(...opts.tools);
  }
  if (!opts.includeSubagents) where.push("s.role = 'main'");
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 1000));

  return (
    db
      .prepare(
        `select s.tool, s.ext_id, s.title, s.turn_count, s.started_ms, s.ended_ms,
                s.role, s.agent_role, s.parent_ext_id,
                coalesce(a.confidence, 'none') as confidence, a.method
         from sessions s
         join projects p on p.id = s.project_id
         left join attribution a on a.session_id = s.id
         where ${where.join(" and ")}
         order by s.started_ms
         limit ?`,
      )
      .all(...params) as Array<Record<string, unknown>>
  ).map((r) => ({
    tool: String(r.tool),
    sessionExtId: String(r.ext_id),
    title: (r.title as string | null) ?? null,
    turns: Number(r.turn_count ?? 0),
    startedMs: (r.started_ms as number | null) ?? null,
    endedMs: (r.ended_ms as number | null) ?? null,
    role: String(r.role),
    agentRole: (r.agent_role as string | null) ?? null,
    parentExtId: (r.parent_ext_id as string | null) ?? null,
    confidence: String(r.confidence),
    method: (r.method as string | null) ?? null,
  }));
}

export interface ToolSummary {
  tool: string;
  sessions: number;
  turns: number;
  firstMs: number | null;
  lastMs: number | null;
}

export interface Dossier {
  project: string;
  rootPath: string | null;
  totals: { sessions: number; turns: number; subagents: number };
  byTool: ToolSummary[];
  attribution: Record<string, number>;
  availability: Record<string, number>;
  topSessions: TimelineEntry[];
  recentTitles: Array<{ tool: string; title: string; whenMs: number | null }>;
  artifacts: Array<{ kind: string; count: number; bytes: number }>;
  fileEvents: { count: number; firstMs: number | null; lastMs: number | null };
}

/**
 * Everything the hub knows about one project, in a single pass of small
 * queries. `topN` bounds the two list sections (`--limit` on the CLI).
 */
export function dossier(db: Db, project: string, topN = 8): Dossier | null {
  const proj = db.prepare("select id, key, root_path from projects where key = ?").get(project) as
    | { id: number; key: string; root_path: string | null }
    | undefined;
  if (!proj) return null;

  const byTool = db
    .prepare(
      `select tool, count(*) sessions, coalesce(sum(turn_count),0) turns,
              min(started_ms) first_ms, max(coalesce(ended_ms, started_ms)) last_ms
       from sessions where project_id = ? group by tool order by turns desc`,
    )
    .all(proj.id) as Array<{
    tool: string;
    sessions: number;
    turns: number;
    first_ms: number | null;
    last_ms: number | null;
  }>;

  const totals = db
    .prepare(
      `select count(*) sessions, coalesce(sum(turn_count),0) turns,
              sum(case when role = 'subagent' then 1 else 0 end) subagents
       from sessions where project_id = ?`,
    )
    .get(proj.id) as { sessions: number; turns: number; subagents: number };

  const attribution: Record<string, number> = {};
  for (const r of db
    .prepare(
      `select coalesce(a.confidence,'none') conf, count(*) c
       from sessions s left join attribution a on a.session_id = s.id
       where s.project_id = ? group by conf`,
    )
    .all(proj.id) as Array<{ conf: string; c: number }>) {
    attribution[r.conf] = r.c;
  }

  const availability: Record<string, number> = {};
  for (const r of db
    .prepare(
      `select t.availability a, count(*) c from turns t
       join sessions s on s.id = t.session_id where s.project_id = ? group by a`,
    )
    .all(proj.id) as Array<{ a: string; c: number }>) {
    availability[r.a] = r.c;
  }

  const artifacts = db
    .prepare(
      "select kind, count(*) count, coalesce(sum(size_bytes),0) bytes from artifacts where project_id = ? group by kind",
    )
    .all(proj.id) as Array<{ kind: string; count: number; bytes: number }>;

  const fileEvents = db
    .prepare("select count(*) count, min(ts_ms) first_ms, max(ts_ms) last_ms from file_events where project_key = ?")
    .get(proj.key) as { count: number; first_ms: number | null; last_ms: number | null };

  const wanted = Math.max(1, topN);
  const all = timeline(db, { project, includeSubagents: true, limit: 1000 });
  const topSessions = [...all].sort((a, b) => b.turns - a.turns).slice(0, wanted);
  // Repeated runs of the same prompt are one topic, not eight.
  const seenTitle = new Set<string>();
  const recentTitles: Array<{ tool: string; title: string; whenMs: number | null }> = [];
  for (const e of [...all].sort((a, b) => (b.startedMs ?? 0) - (a.startedMs ?? 0))) {
    if (!e.title) continue;
    const key = e.title.slice(0, 40).toLowerCase();
    if (seenTitle.has(key)) continue;
    seenTitle.add(key);
    recentTitles.push({ tool: e.tool, title: e.title, whenMs: e.startedMs });
    if (recentTitles.length >= wanted) break;
  }

  return {
    project: proj.key,
    rootPath: proj.root_path,
    totals,
    byTool: byTool.map((t) => ({
      tool: t.tool,
      sessions: t.sessions,
      turns: t.turns,
      firstMs: t.first_ms,
      lastMs: t.last_ms,
    })),
    attribution,
    availability,
    topSessions,
    recentTitles,
    artifacts,
    fileEvents: { count: fileEvents.count, firstMs: fileEvents.first_ms, lastMs: fileEvents.last_ms },
  };
}

export function listProjects(db: Db): Array<{ key: string; sessions: number; turns: number; lastMs: number | null }> {
  return (
    db
      .prepare(
        `select p.key, count(s.id) sessions, coalesce(sum(s.turn_count),0) turns,
                max(coalesce(s.ended_ms, s.started_ms)) last_ms
         from projects p join sessions s on s.project_id = p.id
         group by p.id order by turns desc`,
      )
      .all() as Array<{ key: string; sessions: number; turns: number; last_ms: number | null }>
  ).map((r) => ({ key: r.key, sessions: r.sessions, turns: r.turns, lastMs: r.last_ms }));
}
