import { createHash } from "node:crypto";
import type { Db } from "../db/open.js";
import { Hydrator, type Availability } from "../index/hydrate.js";
import { DEFAULT_DEADLINE_MS, withDeadline, type QmdConfig, type QmdRuntime } from "../qmd/runtime.js";
import { excerpt, highlight, parseQuery, termCoverage, type ParsedQuery } from "../search/keywords.js";
import {
  cosine,
  embedText,
  embeddingModel,
  normalizeVector,
  semanticProvider,
  type EmbeddingConfig,
  type QueryEmbedding,
} from "../search/embeddings.js";

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
  /**
   * Vectors from the same model used to index the corpus. Several when the
   * question was expanded: each one retrieves on its own and a chunk keeps its
   * best similarity, so a sub-query can rescue a hit the others missed.
   */
  embeddings?: QueryEmbedding[];
  /**
   * Extra FTS match expressions, from query expansion. They widen the candidate
   * set only — the ranking below still decides what survives.
   */
  extraMatches?: string[];
  /** Widen the question before retrieving. Off shows the literal match set. */
  expand?: boolean;
  /** Rerank the candidates locally. Off shows the lexical order. */
  rerank?: boolean;
  /** Injection seam: supply the reranker directly instead of opening qmd. */
  rerankFn?: RerankFn | null;
  /** How long the whole relevance layer may take before recall answers without it. */
  deadlineMs?: number;
  /** A candidate the reranker scores below this is dropped, not demoted. */
  minRerankScore?: number;
  rerankIntent?: string;
}

/** Keyed by citation, because that is the one identifier a hit already carries. */
export type RerankFn = (
  query: string,
  docs: ReadonlyArray<{ file: string; text: string }>,
  intent?: string,
) => Promise<Array<{ file: string; score: number }>>;

export interface RecallHit {
  tool: string;
  project: string | null;
  sessionExtId: string;
  sessionTitle: string | null;
  tsMs: number | null;
  confidence: string;
  method: string | null;
  score: number;
  /** The local reranker's verdict, when it ran. Absent means it did not. */
  rerank?: number;
  snippet: string;
  availability: string;
  citation: string;
}

/** At most this many sub-queries are taken from an expansion. */
const MAX_EXPANSIONS = 4;

/**
 * How the deadline is divided.
 *
 * Reranking gets the largest share because it is the stage that changes the
 * answer. Expansion's share is generous only because it is off unless asked
 * for, and it runs before the others rather than alongside them.
 */
const EXPAND_SHARE = 0.5;
const EMBED_SHARE = 0.3;
const RERANK_SHARE = 0.7;

export interface RecallLayer {
  /** The local model runtime, or null when it could not be opened. */
  runtime?: QmdRuntime | null;
  qmd?: QmdConfig;
  /**
   * Whether this surface can afford to wait for a model that is still loading.
   *
   * A long-lived server cannot: the load blocks the event loop for about a
   * minute, past what an MCP client will wait, and it has a next question to be
   * ready for. A one-shot command has no next question — if it will not wait,
   * it never reranks at all — so it does.
   */
  waitForModel?: boolean;
}

/**
 * The full recall path: widen the question, retrieve, then let a relevance
 * model decide what actually answers it.
 *
 * Every optional step degrades on its own. Expansion failing costs breadth,
 * embedding failing costs semantic matches, reranking failing costs precision —
 * none of them costs the lexical answer, because a search that returns nothing
 * when a model did not load is worse than a search that returns too much.
 */
export async function recallWithEmbeddings(
  db: Db,
  opts: RecallOptions,
  config: EmbeddingConfig = {},
  warn?: (message: string) => void,
  layer: RecallLayer = {},
): Promise<RecallHit[]> {
  const query = opts.query.trim();
  if (!query) return recall(db, opts);

  const runtime = layer.runtime ?? null;
  const qmd = layer.qmd ?? {};
  // Expansion is opt-in; see QmdConfig.expand for the measurement behind that.
  const wantExpand = opts.expand ?? qmd.expand ?? false;
  const wantRerank = qmd.rerank !== false && opts.rerank !== false;

  // Each stage gets its own share of the budget rather than drawing from one
  // pot in order. A shared pot looks fairer and is not: a slow embedding
  // command — a Python adapter spawning an interpreter per query, say — spends
  // the whole thing and silently switches reranking off, which is the one
  // stage the layer exists for. Nobody would see why.
  // A surface that chose to wait gets no deadline at all: the person typed the
  // command and is watching it run. Cutting them off at thirty seconds would
  // mean a one-shot command can never rerank, since every run loads the model
  // afresh.
  const unlimited = layer.waitForModel === true;
  const budget = opts.deadlineMs ?? qmd.deadlineMs ?? DEFAULT_DEADLINE_MS;
  /**
   * Race `work` against this stage's share, or simply await it when the caller
   * said it would wait. Not a very large number instead of no number:
   * `setTimeout` is 32-bit, so a huge delay silently becomes one millisecond —
   * "wait forever" would have meant "give up immediately".
   */
  const stage = <T>(work: Promise<T>, fraction: number, what: string): Promise<T> =>
    unlimited ? work : withDeadline(work, Math.max(1000, Math.round(budget * fraction)), what);

  const extraMatches: string[] = [];
  const vectorQueries: string[] = [query];

  if (runtime && wantExpand) {
    try {
      for (const q of (await stage(runtime.expand(query), EXPAND_SHARE, "Query expansion")).slice(0, MAX_EXPANSIONS)) {
        if (q.text === query) continue;
        if (q.type === "lex") extraMatches.push(q.text);
        else vectorQueries.push(q.text);
      }
    } catch (err) {
      warn?.(`Query expansion unavailable: ${(err as Error).message}`);
    }
  }

  const embeddings = await queryVectors(db, config, vectorQueries, runtime, warn, (w, p) => stage(p, EMBED_SHARE, w));

  const candidates = rankCandidates(db, { ...opts, embeddings, extraMatches });

  const rerankFn: RerankFn | null =
    opts.rerankFn ?? (runtime ? (q, docs, intent) => runtime.rerank(q, docs, intent) : null);

  // A runtime that has not finished loading is not asked. Waiting for it would
  // block the event loop in native code, where no deadline can reach — the
  // answer would arrive a minute late instead of now and reranked next time.
  const loading =
    runtime !== null && !runtime.ready && opts.rerankFn === undefined && layer.waitForModel !== true;
  if (loading && wantRerank && candidates.length > 1) {
    warn?.("Relevance model still loading; showing keyword order. Ask again in a moment for reranked results.");
  }

  let reranked = candidates;
  if (rerankFn && wantRerank && !loading && candidates.length > 1) {
    try {
      reranked = await applyRerank(query, candidates, {
        rerank: (q, docs, intent) => stage(rerankFn(q, docs, intent), RERANK_SHARE, "Reranking"),
        intent: opts.rerankIntent ?? qmd.intent,
        floor: opts.minRerankScore ?? qmd.minRerankScore ?? DEFAULT_MIN_RERANK,
      });
    } catch (err) {
      warn?.(`Reranking unavailable; showing keyword order: ${(err as Error).message}`);
    }
  }

  return finish(db, reranked, opts);
}

/**
 * One vector per query variant, from whichever provider is configured.
 *
 * Skipped entirely when the corpus holds no vectors for this model: embedding a
 * question nothing can be compared against spends a model load for nothing.
 */
async function queryVectors(
  db: Db,
  config: EmbeddingConfig,
  queries: ReadonlyArray<string>,
  runtime: QmdRuntime | null,
  warn?: (message: string) => void,
  stage: <T>(what: string, work: Promise<T>) => Promise<T> = (what, work) =>
    withDeadline(work, DEFAULT_DEADLINE_MS, what),
): Promise<QueryEmbedding[]> {
  if (!semanticProvider(config)) return [];
  const model = embeddingModel(config);
  if (!model) return [];
  const indexed = db
    .prepare("select 1 from chunk_embeddings where model = ? and input_sha256 is not null limit 1")
    .get(model);
  if (!indexed) return [];

  const out: QueryEmbedding[] = [];
  for (const text of queries) {
    try {
      out.push({
        model,
        vector: await stage("Embedding the question", embedText(config, text, { runtime, isQuery: true })),
        minSimilarity: config.minSimilarity,
      });
    } catch (err) {
      warn?.(`Semantic search unavailable; using keyword search: ${(err as Error).message}`);
      break;
    }
  }
  return out;
}

/**
 * Full-text search over the contentless index, then rehydrate the winners.
 *
 * The index knows which chunks match; it does not hold their text, so every
 * snippet is read back from the source at query time. A source that has since
 * changed or vanished is reported rather than quietly skipped.
 */
export function recall(db: Db, opts: RecallOptions): RecallHit[] {
  return finish(db, rankCandidates(db, opts), opts);
}

/** A retrieved chunk with its text already read back, before anything is cut. */
interface Candidate {
  r: Row;
  text: string;
  status: Availability;
  score: number;
  rerank?: number;
  parsed: ParsedQuery;
}

interface Row {
  chunk_id: number; ts_ms: number | null; tool: string; ext_id: string;
  title: string | null; project: string | null; confidence: string | null;
  method: string | null; rank: number; seq_start: number; seq_end: number;
  similarity?: number;
}

/**
 * Retrieve and score, stopping short of choosing. Everything expensive happens
 * here — the SQL, the vectors, the rehydration — and what comes back is still
 * the full candidate set, because the reranker cannot improve on a list that
 * has already been cut to ten.
 */
function rankCandidates(db: Db, opts: RecallOptions): Candidate[] {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const minConf = CONFIDENCE_RANK[opts.minConfidence ?? "medium"] ?? 2;
  const parsed = parseQuery(opts.query, opts.nowMs);
  const embeddings = opts.embeddings ?? [];
  if (parsed.match.length === 0 && embeddings.length === 0) return [];

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

  // Expansion's lexical variants. They only add rows; scoring is unchanged, so
  // a variant can surface a chunk but cannot promote one above a better match.
  for (const variant of opts.extraMatches ?? []) {
    const extra = parseQuery(variant, opts.nowMs);
    if (!extra.match) continue;
    const seen = new Set(rows.map((r) => r.chunk_id));
    try {
      for (const r of lexical.all(extra.match, ...params, candidateLimit) as Row[]) {
        if (!seen.has(r.chunk_id)) rows.push(r);
      }
    } catch {
      // A generated query that FTS5 will not parse is not an error worth
      // surfacing — the original query already ran.
    }
  }

  const semanticSql = db.prepare(`select c.id as chunk_id, coalesce(c.ts_ms, s.started_ms) as ts_ms,
    s.tool, s.ext_id, s.title, p.key as project, a.confidence, a.method,
    c.seq_start, c.seq_end, e.dims, e.embedding, 0 as rank
    from chunk_embeddings e join chunks c on c.id = e.chunk_id
    join sessions s on s.id = c.session_id
    left join projects p on p.id = c.project_id
    left join attribution a on a.session_id = s.id
    where e.model = ? and e.input_sha256 = c.text_sha256 and e.dims = ? and ${filters}`);

  for (const embedding of embeddings) {
    const vector = normalizeVector(embedding.vector);
    const floor = embedding.minSimilarity ?? 0.5;
    if (!Number.isFinite(floor) || floor < 0 || floor > 1) throw new Error("minSimilarity must be between 0 and 1");
    const best: Row[] = [];
    for (const r of semanticSql.iterate(embedding.model, vector.length, ...params) as Iterable<Row & { dims: number; embedding: Buffer }>) {
      const similarity = cosine(vector, r.embedding, r.dims);
      if (similarity === null || similarity < floor) continue;
      best.push({ ...r, similarity });
      best.sort((a, b) => b.similarity! - a.similarity! || a.chunk_id - b.chunk_id);
      if (best.length > candidateLimit) best.pop();
    }
    const byId = new Map(rows.map((r) => [r.chunk_id, r]));
    for (const r of best) {
      const already = byId.get(r.chunk_id);
      // A chunk keeps its best similarity across the expanded queries: the
      // variant that found it is the one that speaks for it.
      if (already) already.similarity = Math.max(already.similarity ?? 0, r.similarity ?? 0);
      else rows.push(r);
    }
  }

  const hydrator = new Hydrator(db);
  try {
    return rows
      .map((r) => {
        const resolved = hydrator.resolveChunk(r.chunk_id);
        const coverage = termCoverage(resolved.text, parsed.terms);
        // Coverage is stable across corpus sizes. BM25 only breaks ranking ties.
        const score = resolved.status === "ok" ? Math.max(coverage, r.similarity ?? 0) : 0;
        return { r, text: resolved.text, status: resolved.status, score, parsed };
      })
      .sort((a, b) => b.score - a.score || a.r.rank - b.r.rank || a.r.chunk_id - b.r.chunk_id)
      .slice(0, candidateLimit);
  } finally {
    hydrator.close();
  }
}

/** Below this the reranker is saying "this is not about that". */
export const DEFAULT_MIN_RERANK = 0.3;
/**
 * How much of the final score is the reranker's.
 *
 * One weight for every candidate, deliberately. Weighting by position — trusting
 * retrieval at the top and the model below it — sounds reasonable and is not:
 * it makes two candidates' scores mean different things, so sorting by them
 * interleaves the two rankings instead of combining them. Retrieval still
 * decides which candidates exist at all, and still breaks ties.
 */
const RERANK_WEIGHT = 0.65;
/**
 * How many candidates the reranker actually sees.
 *
 * A cross-encoder reads every (question, passage) pair, so its cost is linear
 * in the text it is handed — and retrieval hands over up to eighty candidates.
 * Judging all of them, at full chunk length, took minutes on a real corpus and
 * blew every deadline; ten excerpts land in seconds. An answer shows ten hits
 * and de-duplicates overlapping ones on the way, so a candidate retrieval
 * ranked sixtieth was never going to be read.
 *
 * The rest are not dropped. They keep their retrieval order below the judged
 * ones — which is the order they would have had anyway.
 */
const RERANK_MAX_DOCS = 10;
/**
 * How much of a candidate the reranker reads.
 *
 * Its cost turned out to scale with total text, not with the number of
 * candidates: twenty-four chunks at 2000 characters took 14 s, the same
 * twenty-four at 600 took 5 s. And a cross-encoder does not need the whole
 * chunk — it needs the passage the question is about, which is the same
 * excerpt the snippet already shows. Sending the rest bought nothing and cost
 * the deadline.
 */
const RERANK_CHARS = 500;
/**
 * What survives when the reranker rejects everything.
 *
 * The floor applies to every candidate, including the first — otherwise the
 * noise that happens to match best is the one thing that can never be cut. But
 * a model that mis-scores a whole result set must not turn "here is what I
 * found" into "nothing found", so the best retrieval hit is kept and marked.
 */
const KEEP_IF_ALL_REJECTED = 1;

/**
 * Score the candidates with a relevance model and drop the ones it rejects.
 *
 * The blend is position-aware, the way qmd's own pipeline is: retrieval is
 * trusted for the first couple of places, because a chunk that both matched
 * lexically and embedded close is rarely wrong, and the reranker takes over
 * below that, where lexical overlap stops meaning much.
 *
 * The floor is the part that does the de-noising. Demoting a tool-call dump to
 * position nine still leaves it in a ten-hit answer; dropping it is what makes
 * the answer shorter and truer.
 */
async function applyRerank(
  query: string,
  candidates: Candidate[],
  opts: { rerank: RerankFn; intent?: string; floor: number },
): Promise<Candidate[]> {
  const readable = candidates
    .filter((c) => c.status !== "missing" && c.text.trim())
    .slice(0, RERANK_MAX_DOCS);
  if (readable.length === 0) return candidates;

  const scored = await opts.rerank(
    query,
    // The excerpt around the match, not the chunk: same passage the reader is
    // shown, and the part the verdict should be about.
    readable.map((c) => ({ file: citationOf(c.r), text: excerpt(c.text, c.parsed.terms, RERANK_CHARS) })),
    opts.intent,
  );
  if (scored.length === 0) return candidates;

  const byCitation = new Map(scored.map((s) => [s.file, s.score]));
  const kept: Candidate[] = [];
  const rejected: Candidate[] = [];

  for (const c of candidates) {
    const verdict = byCitation.get(citationOf(c.r));
    if (verdict === undefined) {
      // Not scored (unreadable, or the model returned a short list). Keeping it
      // unjudged is the honest option: the alternative is dropping a hit for a
      // reason no model ever gave.
      kept.push(c);
      continue;
    }
    const blended = { ...c, rerank: verdict, score: (1 - RERANK_WEIGHT) * c.score + RERANK_WEIGHT * verdict };
    if (verdict < opts.floor) rejected.push(blended);
    else kept.push(blended);
  }

  const survivors = kept.length > 0 ? kept : rejected.slice(0, KEEP_IF_ALL_REJECTED);
  return survivors.sort((a, b) => b.score - a.score || a.r.chunk_id - b.r.chunk_id);
}

function citationOf(r: Row): string {
  return `${r.tool}:${r.ext_id}#seq${r.seq_start}-${r.seq_end}`;
}

/**
 * Choose. Overlapping excerpts of the same session collapse to one, the limit
 * applies, and what actually surfaced is logged for the memory layer — which
 * now means what survived reranking, so a fact is promoted by having been
 * genuinely relevant rather than merely matched.
 */
function finish(db: Db, candidates: Candidate[], opts: RecallOptions): RecallHit[] {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
  const minConf = CONFIDENCE_RANK[opts.minConfidence ?? "medium"] ?? 2;
  const out: RecallHit[] = [];
  const surfaced: Array<{ chunk_id: number; score: number }> = [];
  const spans = new Map<string, Array<[number, number]>>();

  for (const { r, text, status, score, rerank, parsed } of candidates) {
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
      ...(rerank === undefined ? {} : { rerank: Number(rerank.toFixed(4)) }),
      snippet: highlight(excerpt(text, parsed.terms), parsed.terms),
      availability: status,
      citation: citationOf(r),
    });
    if (status === "ok" && score > 0) surfaced.push({ chunk_id: r.chunk_id, score });
    if (out.length >= limit) break;
  }

  recordRecall(db, opts.query, candidates[0]?.parsed.terms ?? [], surfaced, opts.nowMs ?? Date.now(), opts.logQuery ?? true);
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
