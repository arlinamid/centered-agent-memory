import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTurns, upsertSession } from "../src/index/indexer.js";
import { consolidate } from "../src/memory/consolidate.js";
import { listFacts } from "../src/memory/facts.js";
import { planDream, runDream } from "../src/memory/dream.js";
import { recall, recallWithEmbeddings } from "../src/query/recall.js";
import { parseQuery, termCoverage } from "../src/search/keywords.js";
import { cosine, embedText, encodeVector, normalizeVector, planEmbeddings, runEmbeddings, type EmbeddingConfig } from "../src/search/embeddings.js";
import { makeHarness, type Harness } from "./helpers/fixtures.js";

let h: Harness;
const NOW = Date.parse("2026-09-01T12:00:00Z");
const DAY = 86400000;
beforeEach(() => { h = makeHarness(); });
afterEach(() => h.cleanup());

function seed(id: string, text: string, project = "demo", confidence = "strong"): number {
  h.hub.prepare("insert or ignore into projects(key, display_name) values (?, ?)").run(project, project);
  const p = h.hub.prepare("select id from projects where key = ?").get(project) as { id: number };
  const s = upsertSession(h.hub, { tool: "codex", extId: id, startedMs: NOW });
  h.hub.prepare("update sessions set project_id = ? where id = ?").run(p.id, s);
  h.hub.prepare(`insert or replace into attribution(session_id, project_id, confidence, method, computed_ms, rule_version)
    values (?, ?, ?, 'cwd', ?, 1)`).run(s, p.id, confidence, NOW);
  addTurns(h.hub, s, [{ seq: 0, role: "user", tsMs: NOW, text, locator: { kind: "inline" } }]);
  return s;
}

function promote(): void {
  for (const [i, query] of ["database", "migration", "rollback"].entries()) {
    recall(h.hub, { query, nowMs: NOW + i * DAY });
  }
  consolidate(h.hub, { nowMs: NOW + 2 * DAY });
}

function embeddingConfig(body?: string): EmbeddingConfig {
  const file = path.join(h.dir, "embed.mjs");
  fs.writeFileSync(file, body ?? `let s=''; process.stdin.on('data', d=>s+=d).on('end',()=>{
    const {input} = JSON.parse(s);
    const vector = /bicycle|pedal|cycling/.test(input[0]) ? [1,0,0] : [0,1,0];
    process.stdout.write(JSON.stringify({embeddings:[vector]}));
  });`);
  return { provider: "command", model: "fixture-v1", command: [process.execPath, file] };
}

describe("retrieval to long-term memory to dreaming", () => {
  it("promotes real search results on a small corpus without rewriting scores", async () => {
    seed("decision", "Database migration rollback requires a backup before deployment.");
    promote();
    const facts = listFacts(h.hub);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.score).toBeGreaterThanOrEqual(0.8);
    const prompts: string[] = [];
    const stat = await runDream(h.hub, { provider: { model: "fixture", generate: async (prompt) => {
      prompts.push(prompt); return "Back up the database before deploying the migration.";
    } } });
    expect(stat.generated).toBe(1);
    expect(prompts[0]).toContain("requires a backup");
    expect(listFacts(h.hub)[0]!.digestModel).toBe("fixture");
  });

  it("ranks full-query matches ahead of partial matches", () => {
    seed("partial", "Rollback rollback rollback.");
    seed("complete", "Database migration rollback is tested before deployment.");
    const hits = recall(h.hub, { query: "database migration rollback", limit: 2 });
    expect(hits.map((h) => h.sessionExtId)).toEqual(["complete", "partial"]);
    expect(hits[0]!.score).toBe(1);
    expect(hits[1]!.score).toBeCloseTo(1 / 3, 3);
  });

  it("does not let hidden weak matches starve the candidate budget", () => {
    for (let i = 0; i < 90; i++) seed(`weak-${i}`, "rollback", "demo", "weak");
    seed("strong", `rollback ${"background ".repeat(100)}`);
    expect(recall(h.hub, { query: "rollback", project: "demo", limit: 1 })[0]!.sessionExtId).toBe("strong");
  });

  it("keeps short identifiers and does not count substrings as exact terms", () => {
    seed("ui", "UI regression in DB connection pooling.");
    expect(recall(h.hub, { query: "UI" })).toHaveLength(1);
    expect(termCoverage("debug build", ["db", "ui"])).toBe(0);
    expect(termCoverage("Clean node_modules before rebuilding", ["node_modules"])).toBe(1);
    expect(parseQuery("rollback rollback").terms).toEqual(["rollback"]);
    expect(parseQuery("today", NOW).terms).toEqual([]);
  });

  it("drains the dream queue beyond cached high-ranked items", async () => {
    for (let i = 0; i < 3; i++) seed(`decision-${i}`, `Database migration rollback: backup number ${i}.`);
    promote();
    expect(listFacts(h.hub)).toHaveLength(3);
    const provider = { model: "fixture", generate: async () => "Keep the backup." };
    for (let i = 0; i < 3; i++) {
      expect((await runDream(h.hub, { provider, limit: 1 })).generated).toBe(1);
    }
    expect((await runDream(h.hub, { provider, limit: 1 })).generated).toBe(0);
    expect(listFacts(h.hub).every((f) => f.digest !== null)).toBe(true);
  });

  it("invalidates evidence, embeddings and dreams when indexed content changes", async () => {
    const session = seed("decision", "Database migration rollback requires a backup.");
    promote();
    const config = embeddingConfig();
    await runEmbeddings(h.hub, config, planEmbeddings(h.hub, config));
    await runDream(h.hub, { provider: { model: "fixture", generate: async () => "Back up first." } });
    addTurns(h.hub, session, [{ seq: 0, role: "user", tsMs: NOW, text: "A completely different decision.", locator: { kind: "inline" } }]);
    for (const table of ["recall_events", "memory_facts", "memory_dreams", "chunk_embeddings"]) {
      expect(h.hub.prepare(`select count(*) as n from ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it("counts attempted dream input even when the provider fails", async () => {
    seed("decision", "Database migration rollback requires a backup.");
    promote();
    const provider = { model: "fixture", generate: async () => { throw new Error("offline"); } };
    const chars = planDream(h.hub, { provider })[0]!.prompt.length;
    const stat = await runDream(h.hub, { provider });
    expect(stat).toMatchObject({ failed: 1, sentChars: chars, generated: 0 });
  });

  it("hides stale digests and does not reinforce a changed source", async () => {
    seed("decision", "Database migration rollback requires a backup.");
    promote();
    await runDream(h.hub, { provider: { model: "fixture", generate: async () => "Back up first." } });
    const before = h.hub.prepare("select count(*) n from recall_events").get();
    // Simulate drift before the collector reindexes this source.
    h.hub.prepare("update turns set inline_text = 'Database migration rollback is no longer the same.'").run();
    expect(recall(h.hub, { query: "rollback" })[0]!.availability).toBe("stale");
    expect(h.hub.prepare("select count(*) n from recall_events").get()).toEqual(before);
    expect(listFacts(h.hub)[0]!.digest).toBeNull();
    expect(planDream(h.hub)).toEqual([]);
  });
});

describe("optional semantic retrieval", () => {
  it("indexes, caches and retrieves a paraphrase with no shared keywords", async () => {
    seed("bike", "The bicycle needs repair.");
    seed("unrelated", "Database migration requires a backup.");
    const config = embeddingConfig();
    const items = planEmbeddings(h.hub, config);
    expect((await runEmbeddings(h.hub, config, items)).generated).toBe(2);
    expect(planEmbeddings(h.hub, config)).toEqual([]);
    expect(recall(h.hub, { query: "pedal maintenance" })).toEqual([]);
    expect((await recallWithEmbeddings(h.hub, { query: "pedal maintenance" }, config)).map((h) => h.sessionExtId)).toEqual(["bike"]);
    expect(planEmbeddings(h.hub, { ...config, model: "other" })).toHaveLength(2);
  });

  it("applies project, tool, date and attribution filters to vectors", async () => {
    seed("bike", "bicycle", "demo");
    seed("private", "bicycle", "other");
    seed("weak", "bicycle", "demo", "weak");
    const config = embeddingConfig();
    await runEmbeddings(h.hub, config, planEmbeddings(h.hub, config));
    const embedding = { model: config.model!, vector: [1, 0, 0] };
    const embeddings = [embedding];
    expect(recall(h.hub, { query: "cycling", project: "demo", embeddings }).map((h) => h.sessionExtId)).toEqual(["bike"]);
    expect(recall(h.hub, { query: "cycling", tool: "claude_code", embeddings })).toEqual([]);
    expect(recall(h.hub, { query: "cycling", sinceMs: NOW + DAY, embeddings })).toEqual([]);
    expect(recall(h.hub, { query: "cycling", embeddings: [{ ...embedding, model: "wrong" }] })).toEqual([]);
    expect(recall(h.hub, { query: "cycling", embeddings: [{ ...embedding, vector: [1, 0] }] })).toEqual([]);
  });

  it("falls back visibly when the embedding command fails", async () => {
    seed("bike", "bicycle");
    const config = embeddingConfig();
    await runEmbeddings(h.hub, config, planEmbeddings(h.hub, config));
    const bad = embeddingConfig("process.exit(1)");
    const warnings: string[] = [];
    expect(await recallWithEmbeddings(h.hub, { query: "bicycle" }, bad, (s) => warnings.push(s))).toHaveLength(1);
    expect(warnings[0]).toContain("using keyword search");
  });

  it("rejects invalid vectors and ignores corrupt stored vectors", async () => {
    for (const v of [[], [0, 0], [NaN, 1], [Infinity], ["1"]]) expect(() => normalizeVector(v)).toThrow();
    expect(cosine([1, 0], Buffer.alloc(3), 2)).toBeNull();
    expect(cosine([1, 0], encodeVector([NaN, 1]), 2)).toBeNull();
    expect(cosine([1, 0], encodeVector([0, 0]), 2)).toBeNull();
    const config = embeddingConfig("process.stdout.write('{\"embeddings\":[[0,0]]}')");
    await expect(embedText(config, "x")).rejects.toThrow("zero vector");
  });
});
