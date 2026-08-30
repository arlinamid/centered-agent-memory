import { createHash } from "node:crypto";
import type { Db } from "../db/open.js";
import { Hydrator } from "../index/hydrate.js";
import { excerpt, highlight, parseQuery } from "../search/keywords.js";

export type Confidence = "strong" | "medium" | "weak" | "none";

const CONFIDENCE_RANK: Record<string, number> = { strong: 3, medium: 2, weak: 1, none: 0 };

export interface RecallOptions {
  query: string;
  project?: string | null;
  tool?: string | null;
  sinceMs?: number | null;
  untilMs?: number | null;
  limit?: number;
  /** Results below this attribution confidence are hidden by default. */
  minConfidence?: Confidence;
  nowMs?: number;
  /**
   * Record the question itself alongside its hash. On by default: the memory
   * layer has to be able to show which questions promoted a fact, and a hash
   * cannot be shown to anybody. Turn it off to keep only the hash.
   */
  logQuery?: boolean;
}

export interface RecallHit {
  tool: string;
  project: string | null;
  sessionExtId: string;
  sessionTitle: string | null;
  tsMs: number | null;
  confidence: string;
  method: string | null;
  score: number;
  snippet: string;
  availability: string;
  citation: string;
}

/** Squash bm25 (lower is better, often negative) into 0..1. */
function bm25ToScore(rank: number): number {
  return rank < 0 ? -rank / (1 - rank) : 1 / (1 + rank);
}

/**
 * Full-text search over the contentless index, then rehydrate the winners.
 *
 * The index knows which chunks match; it does not hold their text, so every
 * snippet is read back from the source at query time. A source that has since
 * changed or vanished is reported rather than quietly skipped.
 */
export function recall(db: Db, opts: RecallOptions): RecallHit[] {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const minConf = CONFIDENCE_RANK[opts.minConfidence ?? "medium"] ?? 2;
  const parsed = parseQuery(opts.query, opts.nowMs);
  if (parsed.match.length === 0) return [];

  const since = opts.sinceMs ?? parsed.sinceMs ?? null;

  const where: string[] = ["chunks_fts match ?"];
  const params: Array<string | number> = [parsed.match];
  if (opts.project) {
    where.push("p.key = ?");
    params.push(opts.project);
  }
  if (opts.tool) {
    where.push("s.tool = ?");
    params.push(opts.tool);
  }
  if (since !== null) {
    where.push("coalesce(c.ts_ms, s.started_ms) >= ?");
    params.push(since);
  }
  if (opts.untilMs != null) {
    where.push("coalesce(c.ts_ms, s.started_ms) <= ?");
    params.push(opts.untilMs);
  }

  // Widen the candidate set before filtering, so project/tool filters do not
  // starve the result list.
  params.push(limit * 8);

  const rows = db
    .prepare(
      `select c.id as chunk_id, coalesce(c.ts_ms, s.started_ms) as ts_ms, s.tool, s.ext_id, s.title,
              p.key as project, a.confidence, a.method,
              bm25(chunks_fts) as rank
       from chunks_fts
       join chunks c on c.id = chunks_fts.rowid
       join sessions s on s.id = c.session_id
       left join projects p on p.id = c.project_id
       left join attribution a on a.session_id = s.id
       where ${where.join(" and ")}
       order by rank
       limit ?`,
    )
    .all(...params) as Array<{
    chunk_id: number;
    ts_ms: number | null;
    tool: string;
    ext_id: string;
    title: string | null;
    project: string | null;
    confidence: string | null;
    method: string | null;
    rank: number;
  }>;

  const hydrator = new Hydrator(db);
  const out: RecallHit[] = [];
  try {
    for (const r of rows) {
      const conf = r.confidence ?? "none";
      // An unattributed session is still a legitimate hit for an unfiltered
      // search; it is only hidden when the caller asked for a project.
      if (opts.project && (CONFIDENCE_RANK[conf] ?? 0) < minConf) continue;
      if (!opts.project && (CONFIDENCE_RANK[conf] ?? 0) < minConf && conf !== "none") continue;

      const { text, status } = hydrator.resolveChunk(r.chunk_id);
      const range = db.prepare("select seq_start, seq_end from chunks where id = ?").get(r.chunk_id) as {
        seq_start: number;
        seq_end: number;
      };

      out.push({
        tool: r.tool,
        project: r.project,
        sessionExtId: r.ext_id,
        sessionTitle: r.title,
        tsMs: r.ts_ms,
        confidence: conf,
        method: r.method,
        score: Number(bm25ToScore(r.rank).toFixed(4)),
        snippet: highlight(excerpt(text, parsed.terms), parsed.terms),
        availability: status,
        citation: `${r.tool}:${r.ext_id}#seq${range.seq_start}-${range.seq_end}`,
      });
      if (out.length >= limit) break;
    }
  } finally {
    hydrator.close();
  }

  recordRecall(
    db,
    opts.query,
    parsed.terms,
    out.length ? rows.slice(0, out.length) : [],
    opts.nowMs ?? Date.now(),
    opts.logQuery ?? true,
  );
  return out;
}

/**
 * Log what a search actually surfaced: the signal the memory layer promotes
 * from. It has to be collected from the first day, or there is nothing to
 * promote later.
 */
function recordRecall(
  db: Db,
  query: string,
  terms: ReadonlyArray<string>,
  rows: ReadonlyArray<{ chunk_id: number; rank: number }>,
  nowMs: number,
  logQuery: boolean,
): void {
  if (rows.length === 0) return;
  const text = query.trim();
  const hash = createHash("sha256").update(text.toLowerCase()).digest("hex").slice(0, 16);
  const ins = db.prepare("insert into recall_events(chunk_id, query_hash, score, ts_ms) values (?,?,?,?)");
  const tx = db.transaction(() => {
    if (logQuery) {
      // The parsed terms are stored with the question so consolidation never
      // has to tokenize again — and so it cannot tokenize differently.
      db.prepare(
        `insert into memory_queries(hash, text, terms, first_ms, last_ms, uses) values (?,?,?,?,?,1)
         on conflict(hash) do update set last_ms = excluded.last_ms, uses = uses + 1`,
      ).run(hash, text, terms.join(" "), nowMs, nowMs);
    }
    for (const r of rows) ins.run(r.chunk_id, hash, bm25ToScore(r.rank), nowMs);
  });
  tx();
}

export interface Citation {
  tool: string;
  sessionExtId: string;
  seqStart?: number;
  seqEnd?: number;
}

/**
 * The inverse of the `citation` field above: `tool:sessionId#seqN-M`, or just
 * `tool:sessionId` for a whole session. Lives next to the code that writes the
 * string, so the two cannot drift apart.
 */
export function parseCitation(citation: string): Citation | null {
  const m = /^([a-z_]+):([^#\s]+)(?:#seq(\d+)-(\d+))?$/.exec(citation.trim());
  if (!m) return null;
  const [, tool, sessionExtId, a, b] = m;
  if (!tool || !sessionExtId) return null;
  return {
    tool,
    sessionExtId,
    seqStart: a ? Number.parseInt(a, 10) : undefined,
    seqEnd: b ? Number.parseInt(b, 10) : undefined,
  };
}

export interface TurnText {
  seq: number;
  role: string;
  tsMs: number | null;
  text: string;
  availability: string;
}

/** Rehydrate a specific range of a session, for drilling into a hit. */
export function getTurns(
  db: Db,
  tool: string,
  sessionExtId: string,
  seqStart?: number,
  seqEnd?: number,
): TurnText[] {
  const session = db.prepare("select id from sessions where tool = ? and ext_id = ?").get(tool, sessionExtId) as
    | { id: number }
    | undefined;
  if (!session) return [];

  const from = seqStart ?? 0;
  const to = seqEnd ?? from + 40;
  const rows = db
    .prepare("select * from turns where session_id = ? and seq between ? and ? order by seq")
    .all(session.id, from, to) as never[];

  const hydrator = new Hydrator(db);
  try {
    return rows.map((row) => {
      const r = row as { seq: number; role: string; ts_ms: number | null };
      const resolved = hydrator.resolve(row);
      return {
        seq: r.seq,
        role: r.role,
        tsMs: r.ts_ms,
        text: resolved.text ?? "[source missing]",
        availability: resolved.status,
      };
    });
  } finally {
    hydrator.close();
  }
}
