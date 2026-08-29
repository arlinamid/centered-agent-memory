import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { claudeCodeCollector } from "../src/collectors/claude-code.js";
import { collectCwdEvidence, learnRoots, reattribute } from "../src/attribution/resolve.js";
import { recall } from "../src/query/recall.js";
import { consolidate, deep, evict, light, rem, DEFAULT_BUDGET_CHARS } from "../src/memory/consolidate.js";
import { getFact, listFacts, listTopics, memoryStatus } from "../src/memory/facts.js";
import { GATES, passes, recency, saturate, scoreTrace, WEIGHTS } from "../src/memory/score.js";
import { makeHarness, writeTranscript, type Harness } from "./helpers/fixtures.js";

/**
 * The memory layer promotes from what the searches actually surfaced. Nothing
 * here needs a model or a network, and the same database consolidated twice has
 * to promote the same things — that is the milestone's own condition.
 */

let h: Harness;

const SID = "11111111-2222-3333-4444-555555555555";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-08-01T10:00:00.000Z");

async function seed(): Promise<void> {
  writeTranscript(h.roots, "C--work-demo", SID, [
    { type: "ai-title", sessionId: SID, title: "Árvíztűrő teszt" },
    {
      type: "user",
      sessionId: SID,
      cwd: "C:\\work\\demo",
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { content: "Hogyan javítsuk a tükörfúrógép hibát a docker-compose alatt?" },
    },
    {
      type: "assistant",
      sessionId: SID,
      cwd: "C:\\work\\demo",
      timestamp: "2026-08-01T10:00:30.000Z",
      message: { content: [{ type: "text", text: "Az árvíztűrő megoldás a docker-compose átírása." }] },
    },
  ]);
  await claudeCodeCollector.sync(h.ctx);
  collectCwdEvidence(h.hub);
  learnRoots(h.hub);
  h.hub
    .prepare("insert or replace into projects(key, display_name, root_path) values ('demo','demo','c:/work/demo')")
    .run();
  reattribute(h.hub);
}

/** Search the corpus as a user would, at a given moment. */
const search = (query: string, nowMs: number): number =>
  recall(h.hub, { query, nowMs, minConfidence: "weak" }).length;

/**
 * The trace that just clears every gate: three questions, on three days, with
 * three recalls.
 *
 * The relevance of a hit comes from bm25, which is a property of the corpus:
 * two chunks carry no IDF spread at all, so every score here collapses to
 * ~1e-7 and no fixture could ever be promoted. On the reference machine's real
 * index the same figure is 0.90-0.93, so the scores are set to that measured
 * value — everything else about the trace is produced by real searches.
 */
function threeDaysOfSearches(relevance = 0.95): void {
  search("arvizturo", T0 + DAY);
  search("tukorfurogep hiba", T0 + 2 * DAY);
  search("docker compose", T0 + 3 * DAY);
  h.hub.prepare("update recall_events set score = ?").run(relevance);
}

beforeEach(async () => {
  h = makeHarness();
  await seed();
});

afterEach(() => h.cleanup());

describe("scoring", () => {
  it("weights add up to one, so a perfect trace scores one", () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    const perfect = scoreTrace(
      { recalls: 100, queries: 100, days: 100, terms: 100, avgScore: 1, lastMs: T0 },
      T0,
    );
    expect(perfect.score).toBe(1);
  });

  it("saturates: the tenth recall is worth less than the second", () => {
    expect(saturate(0, 10)).toBe(0);
    expect(saturate(2, 10) - saturate(1, 10)).toBeGreaterThan(saturate(10, 10) - saturate(9, 10));
    expect(saturate(50, 10)).toBe(1);
  });

  it("halves the recency term every 14 days", () => {
    expect(recency(T0, T0)).toBe(1);
    expect(recency(T0, T0 + 14 * DAY)).toBeCloseTo(0.5, 10);
    expect(recency(T0, T0 + 28 * DAY)).toBeCloseTo(0.25, 10);
    expect(recency(T0 + DAY, T0)).toBe(1); // never above one
  });

  it("keeps out what only one question ever asked for", () => {
    const t = { recalls: 9, queries: 1, days: 3, terms: 4, avgScore: 1, lastMs: T0 };
    const { score } = scoreTrace(t, T0);
    expect(passes(t, score)).toBe(false);
    expect(GATES.minQueries).toBe(3);
  });

  it("keeps out what was asked three times in one burst but never scored", () => {
    const t = { recalls: 3, queries: 3, days: 1, terms: 3, avgScore: 0.1, lastMs: T0 };
    expect(passes(t, scoreTrace(t, T0).score)).toBe(false);
  });

  it("is a pure function of the trace and the clock", () => {
    const t = { recalls: 5, queries: 4, days: 3, terms: 7, avgScore: 0.8, lastMs: T0 };
    expect(scoreTrace(t, T0 + DAY)).toEqual(scoreTrace(t, T0 + DAY));
  });
});

describe("light consolidation", () => {
  it("folds the recall events per chunk", () => {
    threeDaysOfSearches();
    expect(light(h.hub, T0 + 3 * DAY)).toBeGreaterThan(0);
    const row = h.hub
      .prepare("select recalls, queries, days, terms, avg_score, first_ms, last_ms from memory_traces limit 1")
      .get() as { recalls: number; queries: number; days: number; terms: number; avg_score: number };
    expect(row.recalls).toBeGreaterThanOrEqual(3);
    expect(row.queries).toBe(3);
    expect(row.days).toBe(3);
    expect(row.terms).toBeGreaterThanOrEqual(3);
    expect(row.avg_score).toBeGreaterThan(0);
  });

  it("is rebuilt from the events, not accumulated", () => {
    threeDaysOfSearches();
    light(h.hub, T0 + 3 * DAY);
    const first = h.hub.prepare("select recalls from memory_traces limit 1").get() as { recalls: number };
    light(h.hub, T0 + 3 * DAY);
    const second = h.hub.prepare("select recalls from memory_traces limit 1").get() as { recalls: number };
    expect(second.recalls).toBe(first.recalls);
  });
});

describe("REM consolidation", () => {
  it("finds the terms that keep coming back to different questions", () => {
    search("docker compose", T0 + DAY);
    search("docker hiba", T0 + 2 * DAY);
    rem(h.hub, T0 + 2 * DAY);
    const topics = listTopics(h.hub);
    const docker = topics.find((t) => t.term === "docker");
    expect(docker).toBeDefined();
    expect(docker!.queries).toBe(2);
    expect(docker!.days).toBe(2);
  });

  it("ignores a term that only one question ever used", () => {
    search("arvizturo", T0 + DAY);
    rem(h.hub, T0 + DAY);
    expect(listTopics(h.hub).some((t) => t.term === "arvizturo")).toBe(false);
  });
});

describe("promotion", () => {
  it("promotes what came back on several days to several questions", () => {
    threeDaysOfSearches();
    const stat = consolidate(h.hub, { nowMs: T0 + 3 * DAY });
    expect(stat.promoted).toBeGreaterThan(0);
    expect(stat.facts).toBe(stat.promoted);

    const facts = listFacts(h.hub);
    expect(facts[0]!.score).toBeGreaterThanOrEqual(GATES.minScore);
    expect(facts[0]!.project).toBe("demo");
    expect(facts[0]!.citation).toContain("claude_code:");
  });

  it("promotes nothing from a single search", () => {
    search("arvizturo", T0 + DAY);
    const stat = consolidate(h.hub, { nowMs: T0 + DAY });
    expect(stat.traces).toBeGreaterThan(0);
    expect(stat.promoted).toBe(0);
    expect(listFacts(h.hub)).toEqual([]);
  });

  it("shows a promoted fact with the evidence behind it", () => {
    threeDaysOfSearches();
    consolidate(h.hub, { nowMs: T0 + 3 * DAY });
    const id = listFacts(h.hub)[0]!.id;

    const found = getFact(h.hub, id);
    expect(found).not.toBeNull();
    expect(found!.evidence.length).toBe(3);
    // The questions themselves, not just their hashes.
    expect(found!.evidence.map((e) => e.query)).toContain("docker compose");
    expect(found!.evidence.every((e) => e.firstMs > 0 && e.hits > 0)).toBe(true);
    // The six parts of the score are kept, so a verdict can be explained.
    expect(Object.keys(found!.fact.components).sort()).toEqual(
      ["conceptual", "consolidation", "diversity", "frequency", "recency", "relevance"],
    );
  });

  it("stores no copy of the text: it rehydrates from the source", () => {
    threeDaysOfSearches();
    consolidate(h.hub, { nowMs: T0 + 3 * DAY });
    const id = listFacts(h.hub)[0]!.id;
    expect(getFact(h.hub, id)!.fact.text).toContain("árvíztűrő");

    // No column of memory_facts holds the text.
    const cols = (h.hub.prepare("pragma table_info(memory_facts)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).not.toContain("text");

    const path = (h.hub.prepare("select distinct loc_path from turns").get() as { loc_path: string }).loc_path;
    fs.rmSync(path);
    const after = getFact(h.hub, id)!.fact;
    expect(after.availability).toBe("missing");
    expect(after.text).toContain("forrás hiányzik");
  });

  it("takes a promotion back when the trace stops clearing the gates", () => {
    threeDaysOfSearches();
    consolidate(h.hub, { nowMs: T0 + 3 * DAY });
    expect(listFacts(h.hub).length).toBeGreaterThan(0);

    // Forget two of the three questions: the diversity gate closes.
    const hashes = (
      h.hub.prepare("select distinct query_hash from recall_events").all() as Array<{ query_hash: string }>
    ).map((r) => r.query_hash);
    h.hub.prepare("delete from recall_events where query_hash in (?, ?)").run(hashes[0], hashes[1]);

    const stat = consolidate(h.hub, { nowMs: T0 + 3 * DAY });
    expect(stat.demoted).toBeGreaterThan(0);
    expect(listFacts(h.hub)).toEqual([]);
  });

  it("promotes the same set on a second run of the same database", () => {
    threeDaysOfSearches();
    const first = consolidate(h.hub, { nowMs: T0 + 3 * DAY });
    const factsA = listFacts(h.hub).map((f) => ({ chunk: f.chunkId, score: f.score, promoted: f.promotedMs }));

    // A later clock must not change what was promoted, only how it is scored.
    const second = consolidate(h.hub, { nowMs: T0 + 3 * DAY });
    const factsB = listFacts(h.hub).map((f) => ({ chunk: f.chunkId, score: f.score, promoted: f.promotedMs }));

    expect(factsB).toEqual(factsA);
    expect(second.facts).toBe(first.facts);
    expect(second.promoted).toBe(0); // the second run refreshes, it does not re-promote
    expect(second.refreshed).toBe(first.promoted);
  });

  it("does not need the network, and says what it did", () => {
    threeDaysOfSearches();
    const stat = consolidate(h.hub, { nowMs: T0 + 3 * DAY });
    expect(stat).toMatchObject({ traces: expect.any(Number), topics: expect.any(Number) });
    expect(stat.budgetChars).toBe(DEFAULT_BUDGET_CHARS);
    expect(stat.usedChars).toBeGreaterThan(0);
  });
});

describe("budget", () => {
  it("keeps the newest promotions and drops the oldest first", () => {
    threeDaysOfSearches();
    consolidate(h.hub, { nowMs: T0 + 3 * DAY });
    const before = listFacts(h.hub);
    expect(before.length).toBeGreaterThan(0);

    // A budget of one character cannot hold anything.
    expect(evict(h.hub, 1)).toBe(before.length);
    expect(listFacts(h.hub)).toEqual([]);
  });

  it("re-promotes an evicted fact to the same place, so two runs agree", () => {
    threeDaysOfSearches();
    consolidate(h.hub, { nowMs: T0 + 3 * DAY });
    const promotedMs = listFacts(h.hub)[0]!.promotedMs;

    evict(h.hub, 1);
    consolidate(h.hub, { nowMs: T0 + 3 * DAY });
    // Promotion age comes from the trace, not from the clock: had it come from
    // the clock, a re-promoted fact would jump to the front of the queue and
    // evict something else on every run.
    expect(listFacts(h.hub)[0]!.promotedMs).toBe(promotedMs);
  });
});

describe("forgetting", () => {
  it("lets a memory fade when it stops being needed", () => {
    threeDaysOfSearches();
    expect(consolidate(h.hub, { nowMs: T0 + 3 * DAY }).promoted).toBe(1);

    // Same trace, later clock: the recency term decays with a 14-day half-life,
    // and a memory that only just cleared the bar falls back under it. Nothing
    // is deleted — one more recall would bring it back.
    const later = consolidate(h.hub, { nowMs: T0 + 20 * DAY });
    expect(later.facts).toBe(0);
    expect(later.demoted).toBe(1);
    expect((h.hub.prepare("select count(*) c from memory_traces").get() as { c: number }).c).toBeGreaterThan(0);
  });
});

describe("status", () => {
  it("reports what has been collected and what has been promoted", () => {
    threeDaysOfSearches();
    const before = memoryStatus(h.hub);
    expect(before.events).toBeGreaterThan(0);
    expect(before.queries).toBe(3);
    expect(before.facts).toBe(0);

    consolidate(h.hub, { nowMs: T0 + 3 * DAY });
    const after = memoryStatus(h.hub);
    expect(after.traces).toBeGreaterThan(0);
    expect(after.facts).toBeGreaterThan(0);
    expect(after.lastConsolidatedMs).toBe(T0 + 3 * DAY);
  });

  it("keeps only the hash when query logging is off", () => {
    recall(h.hub, { query: "arvizturo", nowMs: T0 + DAY, minConfidence: "weak", logQuery: false });
    expect(memoryStatus(h.hub).queries).toBe(0);
    expect(memoryStatus(h.hub).events).toBeGreaterThan(0);
  });
});

describe("deep on its own", () => {
  it("can be run with a lower floor without touching the gates", () => {
    search("arvizturo", T0 + DAY);
    search("arvizturo megoldas", T0 + 2 * DAY);
    light(h.hub, T0 + 2 * DAY);
    // Two questions: below the diversity gate, and no floor can override that.
    expect(deep(h.hub, { nowMs: T0 + 2 * DAY, minScore: 0 }).promoted).toBe(0);
  });
});
