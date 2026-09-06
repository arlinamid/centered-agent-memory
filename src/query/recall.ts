import { createHash } from "node:crypto";
import type { Db } from "../db/open.js";
import { Hydrator } from "../index/hydrate.js";
import { excerpt, highlight, parseQuery, termCoverage } from "../search/keywords.js";
import { cosine, embedText, normalizeVector, type EmbeddingConfig, type QueryEmbedding } from "../search/embeddings.js";

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
  /** Optional vector from the same model used to index the corpus. */
  embedding?: QueryEmbedding;
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

/** Optional semantic retrieval; provider failure leaves lexical search usable. */
export async function recallWithEmbeddings(db: Db, opts: RecallOptions, config: EmbeddingConfig = {}, warn?: (message: string) => void): Promise<RecallHit[]> {
  if (config.provider !== "command" || !opts.query.trim()) return recall(db, opts);
  const indexed = db.prepare("select 1 from chunk_embeddings where model = ? and input_sha256 is not null limit 1").get(config.model ?? "?");
  if (!indexed) return recall(db, opts);
  let embedding: QueryEmbedding | undefined;
  try {
    embedding = { model: config.model!, vector: await embedText(config, opts.query), minSimilarity: config.minSimilarity };
  } catch (err) {
    warn?.(`Semantic search unavailable; using keyword search: ${(err as Error).message}`);
  }
  return recall(db, { ...opts, embedding });
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
  if (parsed.match.length === 0 && !opts.embedding) return [];

  const since = opts.sinceMs ?? parsed.sinceMs ?? null;

  const where: string[] = [];
  const params: Array<string | number> = [];
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

  const confidenceSql = "case coalesce(a.confidence, 'none') when 'strong' then 3 when 'medium' then 2 when 'weak' then 1 else 0 end";
  where.push(opts.project ? `${confidenceSql} >= ?` : `(${confidenceSql} >= ? or coalesce(a.confidence, 'none') = 'none')`);
  params.push(minConf);
  const filters = where.join(" and ");
  const candidateLimit = Math.max(80, limit * 8);

  interface Row {
    chunk_id: number; ts_ms: number | null; tool: string; ext_id: string;
    title: string | null; project: string | null; confidence: string | null;
    method: string | null; rank: number; seq_start: number; seq_end: number;
    similarity?: number;
  }

  const lexical = db
    .prepare(
      `select c.id as chunk_id, coalesce(c.ts_ms, s.started_ms) as ts_ms, s.tool, s.ext_id, s.title,
              p.key as project, a.confidence, a.method,
              bm25(chunks_fts) as rank, c.seq_start, c.seq_end
       from chunks_fts
       join chunks c on c.id = chunks_fts.rowid
       join sessions s on s.id = c.session_id
       left join projects p on p.id = c.project_id
       left join attribution a on a.session_id = s.id
       where chunks_fts match ? and ${filters}
       order by rank, c.id
       limit ?`,
    );
  const rows = lexical.all(parsed.match || '""', ...params, candidateLimit) as Row[];
  // Full-query matches must not be crowded out by many high-IDF OR matches.
  if (parsed.terms.length > 1) {
    const seen = new Set(rows.map((r) => r.chunk_id));
    for (const r of lexical.all(parsed.match.split(" OR ").join(" AND "), ...params, candidateLimit) as Row[]) {
      if (!seen.has(r.chunk_id)) rows.push(r);
    }
  }

  if (opts.embedding) {
    const vector = normalizeVector(opts.embedding.vector);
    const floor = opts.embedding.minSimilarity ?? 0.5;
    if (!Number.isFinite(floor) || floor < 0 || floor > 1) throw new Error("minSimilarity must be between 0 and 1");
    const semantic = db.prepare(`select c.id as chunk_id, coalesce(c.ts_ms, s.started_ms) as ts_ms,
      s.tool, s.ext_id, s.title, p.key as project, a.confidence, a.method,
      c.seq_start, c.seq_end, e.dims, e.embedding, 0 as rank
      from chunk_embeddings e join chunks c on c.id = e.chunk_id
      join sessions s on s.id = c.session_id
      left join projects p on p.id = c.project_id
      left join attribution a on a.session_id = s.id
      where e.model = ? and e.input_sha256 = c.text_sha256 and e.dims = ? and ${filters}`);
    const best: Row[] = [];
    for (const r of semantic.iterate(opts.embedding.model, vector.length, ...params) as Iterable<Row & { dims: number; embedding: Buffer }>) {
      const similarity = cosine(vector, r.embedding, r.dims);
      if (similarity === null || similarity < floor) continue;
      best.push({ ...r, similarity });
      best.sort((a, b) => b.similarity! - a.similarity! || a.chunk_id - b.chunk_id);
      if (best.length > candidateLimit) best.pop();
    }
    const byId = new Map(rows.map((r) => [r.chunk_id, r]));
    for (const r of best) {
      const lexical = byId.get(r.chunk_id);
      if (lexical) lexical.similarity = r.similarity;
      else rows.push(r);
    }
  }

  const hydrator = new Hydrator(db);
  const out: RecallHit[] = [];
  const surfaced: Array<{ chunk_id: number; score: number }> = [];
  try {
    const ranked = rows.map((r) => {
      const resolved = hydrator.resolveChunk(r.chunk_id);
      const coverage = termCoverage(resolved.text, parsed.terms);
      // Coverage is stable across corpus sizes. BM25 only breaks ranking ties.
      const score = resolved.status === "ok" ? Math.max(coverage, r.similarity ?? 0) : 0;
      return { r, ...resolved, score };
    }).sort((a, b) => b.score - a.score || a.r.rank - b.r.rank || a.r.chunk_id - b.r.chunk_id);
    const spans = new Map<string, Array<[number, number]>>();
    for (const { r, text, status, score } of ranked) {
      const conf = r.confidence ?? "none";
      // An unattributed session is still a legitimate hit for an unfiltered
      // search; it is only hidden when the caller asked for a project.
      if (opts.project && (CONFIDENCE_RANK[conf] ?? 0) < minConf) continue;
      if (!opts.project && (CONFIDENCE_RANK[conf] ?? 0) < minConf && conf !== "none") continue;

      const key = `${r.tool}:${r.ext_id}`;
      const taken = spans.get(key) ?? [];
      if (taken.some(([start, end]) =>
        Math.max(0, Math.min(end, r.seq_end) - Math.max(start, r.seq_start) + 1) /
          Math.min(end - start + 1, r.seq_end - r.seq_start + 1) >= 0.8)) continue;
      taken.push([r.seq_start, r.seq_end]);
      spans.set(key, taken);

      out.push({
        tool: r.tool,
        project: r.project,
        sessionExtId: r.ext_id,
        sessionTitle: r.title,
        tsMs: r.ts_ms,
        confidence: conf,
        method: r.method,
        score: Number(score.toFixed(4)),
        snippet: highlight(excerpt(text, parsed.terms), parsed.terms),
        availability: status,
        citation: `${r.tool}:${r.ext_id}#seq${r.seq_start}-${r.seq_end}`,
      });
      if (status === "ok" && score > 0) surfaced.push({ chunk_id: r.chunk_id, score });
      if (out.length >= limit) break;
    }
  } finally {
    hydrator.close();
  }

  recordRecall(db, opts.query, parsed.terms, surfaced, opts.nowMs ?? Date.now(), opts.logQuery ?? true);
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
  rows: ReadonlyArray<{ chunk_id: number; score: number }>,
  nowMs: number,
  logQuery: boolean,
): void {
  if (rows.length === 0) return;
  const text = query.trim();
  const hash = createHash("sha256").update(text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ")).digest("hex").slice(0, 16);
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
    for (const r of rows) ins.run(r.chunk_id, hash, r.score, nowMs);
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
