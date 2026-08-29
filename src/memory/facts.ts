import type { Db } from "../db/open.js";
import { Hydrator } from "../index/hydrate.js";
import { LAST_RUN_KEY } from "./consolidate.js";
import type { ScoreComponents } from "./score.js";

/**
 * Reading long-term memory.
 *
 * A promoted fact stores no text: it points at a chunk, and the text is read
 * back from the source exactly like a search hit. The invariant survives the
 * memory layer — and a fact whose source vanished says so instead of quietly
 * showing a copy that nothing can verify any more.
 */

export interface MemoryFact {
  id: number;
  chunkId: number;
  project: string | null;
  tool: string;
  sessionExtId: string;
  sessionTitle: string | null;
  score: number;
  components: ScoreComponents;
  recalls: number;
  queries: number;
  days: number;
  chars: number;
  firstMs: number;
  lastMs: number;
  promotedMs: number;
  citation: string;
  text: string;
  availability: string;
  /** What the dream phase wrote about it, if anything ever did. */
  digest: string | null;
  digestModel: string | null;
}

export interface EvidenceRow {
  /** The question itself when it was logged, otherwise just its hash. */
  query: string | null;
  queryHash: string;
  hits: number;
  firstMs: number;
  lastMs: number;
}

interface FactRow {
  id: number;
  chunk_id: number;
  score: number;
  components: string;
  recalls: number;
  queries: number;
  days: number;
  chars: number;
  first_ms: number;
  last_ms: number;
  promoted_ms: number;
  project: string | null;
  tool: string;
  ext_id: string;
  title: string | null;
  seq_start: number;
  seq_end: number;
  digest: string | null;
  digest_model: string | null;
}

// The newest dream for the chunk, if the dream phase ever ran on it. A left
// join: a memory without a digest is the normal case, not a missing row.
const SELECT = `select f.id, f.chunk_id, f.score, f.components, f.recalls, f.queries, f.days, f.chars,
                       f.first_ms, f.last_ms, f.promoted_ms,
                       p.key as project, s.tool, s.ext_id, s.title, c.seq_start, c.seq_end,
                       d.text as digest, d.model as digest_model
                from memory_facts f
                join chunks c on c.id = f.chunk_id
                join sessions s on s.id = c.session_id
                left join projects p on p.id = f.project_id
                left join memory_dreams d on d.id = (
                  select id from memory_dreams where chunk_id = f.chunk_id and kind = 'digest'
                  order by created_ms desc, id desc limit 1
                )`;

function toFact(r: FactRow, hydrator: Hydrator, hydrate: boolean): MemoryFact {
  const resolved = hydrate ? hydrator.resolveChunk(r.chunk_id) : null;
  return {
    id: r.id,
    chunkId: r.chunk_id,
    project: r.project,
    tool: r.tool,
    sessionExtId: r.ext_id,
    sessionTitle: r.title,
    score: r.score,
    components: JSON.parse(r.components) as ScoreComponents,
    recalls: r.recalls,
    queries: r.queries,
    days: r.days,
    chars: r.chars,
    firstMs: r.first_ms,
    lastMs: r.last_ms,
    promotedMs: r.promoted_ms,
    citation: `${r.tool}:${r.ext_id}#seq${r.seq_start}-${r.seq_end}`,
    text: resolved?.text ?? "",
    availability: resolved?.status ?? "unknown",
    digest: r.digest,
    digestModel: r.digest_model,
  };
}

export interface ListOptions {
  project?: string | null;
  limit?: number;
  /** Read the text back from the sources. Off for a bare count. */
  hydrate?: boolean;
}

export function listFacts(db: Db, opts: ListOptions = {}): MemoryFact[] {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const where = opts.project ? " where p.key = ?" : "";
  const params: Array<string | number> = opts.project ? [opts.project, limit] : [limit];

  const rows = db
    .prepare(`${SELECT}${where} order by f.score desc, f.id asc limit ?`)
    .all(...params) as FactRow[];

  const hydrator = new Hydrator(db);
  try {
    return rows.map((r) => toFact(r, hydrator, opts.hydrate ?? true));
  } finally {
    hydrator.close();
  }
}

/** One fact with the evidence that promoted it: when, and to which questions. */
export function getFact(db: Db, id: number): { fact: MemoryFact; evidence: EvidenceRow[] } | null {
  const row = db.prepare(`${SELECT} where f.id = ?`).get(id) as FactRow | undefined;
  if (!row) return null;

  const hydrator = new Hydrator(db);
  let fact: MemoryFact;
  try {
    fact = toFact(row, hydrator, true);
  } finally {
    hydrator.close();
  }

  const evidence = (
    db
      .prepare(
        `select e.query_hash, count(*) hits, min(e.ts_ms) first_ms, max(e.ts_ms) last_ms, q.text
         from recall_events e
         left join memory_queries q on q.hash = e.query_hash
         where e.chunk_id = ?
         group by e.query_hash
         order by hits desc, first_ms asc, e.query_hash asc`,
      )
      .all(row.chunk_id) as Array<{
      query_hash: string;
      hits: number;
      first_ms: number;
      last_ms: number;
      text: string | null;
    }>
  ).map((r) => ({
    query: r.text,
    queryHash: r.query_hash,
    hits: r.hits,
    firstMs: r.first_ms,
    lastMs: r.last_ms,
  }));

  return { fact, evidence };
}

export interface Topic {
  term: string;
  queries: number;
  chunks: number;
  days: number;
  lastMs: number;
}

export function listTopics(db: Db, limit = 20): Topic[] {
  return (
    db
      .prepare("select term, queries, chunks, days, last_ms from memory_topics order by queries desc, term asc limit ?")
      .all(Math.min(Math.max(limit, 1), 200)) as Array<{
      term: string;
      queries: number;
      chunks: number;
      days: number;
      last_ms: number;
    }>
  ).map((r) => ({ term: r.term, queries: r.queries, chunks: r.chunks, days: r.days, lastMs: r.last_ms }));
}

export interface MemoryStatus {
  facts: number;
  chars: number;
  dreams: number;
  dreamModels: string[];
  traces: number;
  candidates: number;
  topics: number;
  events: number;
  queries: number;
  lastConsolidatedMs: number | null;
}

export function memoryStatus(db: Db): MemoryStatus {
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;
  const facts = one<{ c: number; chars: number }>(
    "select count(*) c, coalesce(sum(chars),0) chars from memory_facts",
  );
  const lastRun = db.prepare("select value from meta where key = ?").get(LAST_RUN_KEY) as
    | { value: string }
    | undefined;
  const dreams = one<{ c: number }>("select count(*) c from memory_dreams");
  const models = (
    db.prepare("select distinct model from memory_dreams order by model").all() as Array<{ model: string }>
  ).map((r) => r.model);
  const traces = one<{ c: number }>("select count(*) c from memory_traces");
  const ready = one<{ c: number }>("select count(*) c from memory_traces where recalls >= 3 and queries >= 3");
  const topics = one<{ c: number }>("select count(*) c from memory_topics");
  const events = one<{ c: number }>("select count(*) c from recall_events");
  const queries = one<{ c: number }>("select count(*) c from memory_queries");
  return {
    facts: facts.c,
    chars: facts.chars,
    dreams: dreams.c,
    dreamModels: models,
    traces: traces.c,
    candidates: ready.c,
    topics: topics.c,
    events: events.c,
    queries: queries.c,
    lastConsolidatedMs: lastRun ? Number(lastRun.value) : null,
  };
}
