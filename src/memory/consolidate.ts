import type { Db } from "../db/open.js";
import { GATES, MEMORY_RULE_VERSION, passes, scoreTrace, type Trace } from "./score.js";

/**
 * Consolidation: recall trace in, long-term memory out.
 *
 * Three passes, after the model the plan describes:
 *
 *   Light — fold the raw recall events per chunk (what came back, how often,
 *           over how many days, to how many different questions).
 *   REM   — the terms that keep returning across different questions, which is
 *           what "a recurring topic" means without a model to ask.
 *   Deep  — score, gate, promote, and keep the result inside a character
 *           budget.
 *
 * Everything here is deterministic and offline: the same database consolidated
 * twice produces the same promotions.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How much promoted material we keep. Oldest promotions fall out first. */
export const DEFAULT_BUDGET_CHARS = 200_000;

export interface ConsolidateOptions {
  nowMs?: number;
  budgetChars?: number;
  /** Lower the promotion floor (for inspection); the gates still apply. */
  minScore?: number;
}

export interface ConsolidateStat {
  traces: number;
  topics: number;
  candidates: number;
  promoted: number;
  refreshed: number;
  demoted: number;
  evicted: number;
  /** Candidates dropped because a better-scoring one covers the same turns. */
  merged: number;
  facts: number;
  usedChars: number;
  budgetChars: number;
}

/** Light: the recall trace, folded per chunk. Always rebuilt from the events. */
export function light(db: Db, nowMs: number): number {
  const agg = db
    .prepare(
      `select chunk_id, count(*) recalls, count(distinct query_hash) queries,
              count(distinct cast(ts_ms / ${DAY_MS} as integer)) days,
              avg(score) avg_score, min(ts_ms) first_ms, max(ts_ms) last_ms
       from recall_events group by chunk_id`,
    )
    .all() as Array<{
    chunk_id: number;
    recalls: number;
    queries: number;
    days: number;
    avg_score: number | null;
    first_ms: number;
    last_ms: number;
  }>;

  // Distinct query terms per chunk. Counted here rather than in SQL because
  // SQLite cannot split a string, and the terms were parsed once already.
  const terms = queryTerms(db);
  const pairs = db.prepare("select distinct chunk_id, query_hash from recall_events").all() as Array<{
    chunk_id: number;
    query_hash: string;
  }>;
  const termsByChunk = new Map<number, Set<string>>();
  for (const p of pairs) {
    let set = termsByChunk.get(p.chunk_id);
    if (!set) termsByChunk.set(p.chunk_id, (set = new Set()));
    for (const t of terms.get(p.query_hash) ?? []) set.add(t);
  }

  const tx = db.transaction(() => {
    db.prepare("delete from memory_traces").run();
    const ins = db.prepare(
      `insert into memory_traces(chunk_id, recalls, queries, days, terms, avg_score, first_ms, last_ms, updated_ms)
       values (?,?,?,?,?,?,?,?,?)`,
    );
    for (const r of agg) {
      ins.run(
        r.chunk_id,
        r.recalls,
        r.queries,
        r.days,
        termsByChunk.get(r.chunk_id)?.size ?? 0,
        r.avg_score ?? 0,
        r.first_ms,
        r.last_ms,
        nowMs,
      );
    }
  });
  tx();
  return agg.length;
}

function queryTerms(db: Db): Map<string, string[]> {
  const rows = db.prepare("select hash, terms from memory_queries").all() as Array<{ hash: string; terms: string }>;
  return new Map(rows.map((r) => [r.hash, r.terms.split(" ").filter(Boolean)] as const));
}

/** A term has to come back to more than one question before it is a topic. */
const TOPIC_MIN_QUERIES = 2;

/**
 * REM: which terms keep returning, across how many questions, chunks and days.
 * Deterministic extraction — the terms are the ones the search already parsed,
 * no summarizing and nothing invented.
 */
export function rem(db: Db, nowMs: number): number {
  const terms = queryTerms(db);
  const events = db.prepare("select chunk_id, query_hash, ts_ms from recall_events").all() as Array<{
    chunk_id: number;
    query_hash: string;
    ts_ms: number;
  }>;

  interface Acc {
    queries: Set<string>;
    chunks: Set<number>;
    days: Set<number>;
    lastMs: number;
  }
  const byTerm = new Map<string, Acc>();
  for (const e of events) {
    const day = Math.floor(e.ts_ms / DAY_MS);
    for (const term of terms.get(e.query_hash) ?? []) {
      let a = byTerm.get(term);
      if (!a) byTerm.set(term, (a = { queries: new Set(), chunks: new Set(), days: new Set(), lastMs: 0 }));
      a.queries.add(e.query_hash);
      a.chunks.add(e.chunk_id);
      a.days.add(day);
      if (e.ts_ms > a.lastMs) a.lastMs = e.ts_ms;
    }
  }

  const rows = [...byTerm.entries()]
    .filter(([, a]) => a.queries.size >= TOPIC_MIN_QUERIES)
    .sort((a, b) => b[1].queries.size - a[1].queries.size || a[0].localeCompare(b[0]));

  const tx = db.transaction(() => {
    db.prepare("delete from memory_topics").run();
    const ins = db.prepare("insert into memory_topics(term, queries, chunks, days, last_ms) values (?,?,?,?,?)");
    for (const [term, a] of rows) ins.run(term, a.queries.size, a.chunks.size, a.days.size, a.lastMs);
  });
  tx();
  // nowMs is not stored: a topic is a property of the trace, not of the run.
  void nowMs;
  return rows.length;
}

interface TraceRow extends Trace {
  chunk_id: number;
  firstMs: number;
}

function traces(db: Db): TraceRow[] {
  return (
    db
      .prepare(
        `select chunk_id, recalls, queries, days, terms, avg_score, first_ms, last_ms
         from memory_traces order by chunk_id`,
      )
      .all() as Array<{
      chunk_id: number;
      recalls: number;
      queries: number;
      days: number;
      terms: number;
      avg_score: number;
      first_ms: number;
      last_ms: number;
    }>
  ).map((r) => ({
    chunk_id: r.chunk_id,
    recalls: r.recalls,
    queries: r.queries,
    days: r.days,
    terms: r.terms,
    avgScore: r.avg_score,
    lastMs: r.last_ms,
    firstMs: r.first_ms,
  }));
}

/**
 * Deep: score every trace, promote what clears the gates, drop what no longer
 * does, and keep the whole thing inside the character budget.
 */
export function deep(db: Db, opts: ConsolidateOptions = {}): Omit<ConsolidateStat, "traces" | "topics"> {
  const nowMs = opts.nowMs ?? Date.now();
  const budgetChars = opts.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const minScore = opts.minScore ?? GATES.minScore;

  const chunkInfo = db.prepare(
    "select char_len, project_id, session_id, seq_start, seq_end from chunks where id = ?",
  );
  const existing = new Map(
    (db.prepare("select chunk_id, id from memory_facts").all() as Array<{ chunk_id: number; id: number }>).map(
      (r) => [r.chunk_id, r.id] as const,
    ),
  );

  interface Candidate {
    trace: TraceRow;
    score: number;
    components: string;
    charLen: number;
    projectId: number | null;
    sessionId: number;
    seqStart: number;
    seqEnd: number;
  }

  const candidates: Candidate[] = [];
  for (const t of traces(db)) {
    const { score, components } = scoreTrace(t, nowMs);
    if (!passes(t, score, minScore)) continue;
    const info = chunkInfo.get(t.chunk_id) as
      | { char_len: number; project_id: number | null; session_id: number; seq_start: number; seq_end: number }
      | undefined;
    if (!info) continue; // the chunk went away under us
    candidates.push({
      trace: t,
      score,
      components: JSON.stringify(components),
      charLen: info.char_len,
      projectId: info.project_id,
      sessionId: info.session_id,
      seqStart: info.seq_start,
      seqEnd: info.seq_end,
    });
  }

  const kept = dedupe(candidates);
  const merged = candidates.length - kept.length;

  let promoted = 0;
  let refreshed = 0;
  const keep = new Set<number>();

  const tx = db.transaction(() => {
    const upsert = db.prepare(
      `insert into memory_facts
         (chunk_id, project_id, score, components, recalls, queries, days, chars,
          first_ms, last_ms, promoted_ms, updated_ms, rule_version)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict(chunk_id) do update set
         project_id = excluded.project_id, score = excluded.score, components = excluded.components,
         recalls = excluded.recalls, queries = excluded.queries, days = excluded.days,
         chars = excluded.chars, first_ms = excluded.first_ms, last_ms = excluded.last_ms,
         promoted_ms = excluded.promoted_ms, updated_ms = excluded.updated_ms,
         rule_version = excluded.rule_version`,
    );

    for (const c of kept) {
      // promoted_ms comes from the trace, not the clock: an evicted fact that
      // is promoted again must land in the same place in the order, or two
      // runs of the same database disagree with each other.
      upsert.run(
        c.trace.chunk_id,
        c.projectId,
        c.score,
        c.components,
        c.trace.recalls,
        c.trace.queries,
        c.trace.days,
        c.charLen,
        c.trace.firstMs,
        c.trace.lastMs,
        c.trace.firstMs,
        nowMs,
        MEMORY_RULE_VERSION,
      );
      if (existing.has(c.trace.chunk_id)) refreshed++;
      else promoted++;
      keep.add(c.trace.chunk_id);
    }

    // Anything that no longer clears the gates stops being a memory. The trace
    // stays, so it can come back if it is needed again.
    const del = db.prepare("delete from memory_facts where chunk_id = ?");
    for (const c of existing.keys()) if (!keep.has(c)) del.run(c);
  });
  tx();

  const demoted = [...existing.keys()].filter((c) => !keep.has(c)).length;
  const evicted = evict(db, budgetChars);

  const total = db.prepare("select count(*) c, coalesce(sum(chars),0) chars from memory_facts").get() as {
    c: number;
    chars: number;
  };

  return {
    candidates: candidates.length,
    promoted,
    refreshed,
    demoted,
    evicted,
    merged,
    facts: total.c,
    usedChars: total.chars,
    budgetChars,
  };
}

/**
 * Chunks overlap on purpose — the chunker carries a tail of whole turns forward
 * so a question and its answer are never separated — which means two neighbours
 * can hold much of the same conversation. Promoting both would show the reader
 * the same memory twice, and would pay a language model twice to describe it.
 * The better-scoring one wins; ties go to the longer span, then to the lower id,
 * so the choice never depends on row order.
 */
function dedupe<T extends { trace: { chunk_id: number }; score: number; sessionId: number; seqStart: number; seqEnd: number }>(
  candidates: ReadonlyArray<T>,
): T[] {
  const ranked = [...candidates].sort(
    (a, b) =>
      b.score - a.score ||
      b.seqEnd - b.seqStart - (a.seqEnd - a.seqStart) ||
      a.trace.chunk_id - b.trace.chunk_id,
  );
  const taken = new Map<number, Array<[number, number]>>();
  const kept: T[] = [];
  for (const c of ranked) {
    const spans = taken.get(c.sessionId) ?? [];
    if (spans.some(([s, e]) => c.seqStart <= e && s <= c.seqEnd)) continue;
    spans.push([c.seqStart, c.seqEnd]);
    taken.set(c.sessionId, spans);
    kept.push(c);
  }
  return kept.sort((a, b) => a.trace.chunk_id - b.trace.chunk_id);
}

/**
 * Keep the newest promotions that fit the budget; the oldest fall out first.
 * The tie-break is explicit so the order never depends on SQLite's row order.
 */
export function evict(db: Db, budgetChars: number): number {
  const rows = db
    .prepare("select id, chars, promoted_ms, score from memory_facts order by promoted_ms desc, score desc, id asc")
    .all() as Array<{ id: number; chars: number; promoted_ms: number; score: number }>;

  let used = 0;
  const drop: number[] = [];
  for (const r of rows) {
    if (used + r.chars <= budgetChars) used += r.chars;
    else drop.push(r.id);
  }
  if (drop.length === 0) return 0;

  const del = db.prepare("delete from memory_facts where id = ?");
  const tx = db.transaction(() => {
    for (const id of drop) del.run(id);
  });
  tx();
  return drop.length;
}

/** Where the last run is recorded, so "when did this last consolidate" has an answer. */
export const LAST_RUN_KEY = "memory_consolidated_ms";

/** The whole pipeline: Light, then REM, then Deep. */
export function consolidate(db: Db, opts: ConsolidateOptions = {}): ConsolidateStat {
  const nowMs = opts.nowMs ?? Date.now();
  const t = light(db, nowMs);
  const topics = rem(db, nowMs);
  const stat = deep(db, { ...opts, nowMs });
  // Recorded even when nothing was promoted: "it ran and found nothing" and
  // "it never ran" are different answers.
  db.prepare("insert or replace into meta(key, value) values (?, ?)").run(LAST_RUN_KEY, String(nowMs));
  return { traces: t, topics, ...stat };
}
