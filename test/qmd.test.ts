import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTurns, upsertSession } from "../src/index/indexer.js";
import { focusedSessions } from "../src/query/dossier.js";
import { recallWithEmbeddings, type RecallLayer } from "../src/query/recall.js";
import {
  QMD_MODELS,
  applyGpuMode,
  modelsPresent,
  openQmd,
  qmdCacheHome,
  qmdIndexPath,
  qmdModelCacheDir,
  type ExpandedQuery,
  type QmdRuntime,
} from "../src/qmd/runtime.js";
import { embedText, embeddingModel, semanticProvider } from "../src/search/embeddings.js";
import { makeHarness, type Harness } from "./helpers/fixtures.js";

let h: Harness;
const NOW = Date.parse("2026-09-01T12:00:00Z");
beforeEach(() => { h = makeHarness(); });
afterEach(() => h.cleanup());

function seed(extId: string, text: string, project = "demo"): void {
  h.hub.prepare("insert or ignore into projects(key, display_name) values (?, ?)").run(project, project);
  const p = h.hub.prepare("select id from projects where key = ?").get(project) as { id: number };
  const s = upsertSession(h.hub, { tool: "codex", extId, startedMs: NOW, title: extId });
  h.hub.prepare("update sessions set project_id = ? where id = ?").run(p.id, s);
  h.hub.prepare(`insert or replace into attribution(session_id, project_id, confidence, method, computed_ms, rule_version)
    values (?, ?, 'strong', 'cwd', ?, 1)`).run(s, p.id, NOW);
  addTurns(h.hub, s, [{ seq: 0, role: "user", tsMs: NOW, text, locator: { kind: "inline" } }]);
}

/** A runtime with no models behind it: every answer is stated by the test. */
function stub(overrides: Partial<QmdRuntime> = {}): QmdRuntime {
  return {
    dbPath: "(stub)",
    models: () => QMD_MODELS,
    embed: async () => [1, 0],
    expand: async (): Promise<ExpandedQuery[]> => [],
    rerank: async () => [],
    warmUp: async () => {},
    ready: true,
    close: async () => {},
    ...overrides,
  };
}

const layerOf = (runtime: QmdRuntime | null): RecallLayer => ({ runtime, qmd: {} });

describe("rerank", () => {
  beforeEach(() => {
    seed("relevant", "The Docker port moved from 3000 to 80.");
    seed("passing", "Docker came up in passing while we discussed the logo.");
    seed("noise", "Docker docker docker docker docker.");
  });

  it("reorders by the model's verdict rather than by keyword overlap", async () => {
    const scores: Record<string, number> = { relevant: 0.95, passing: 0.9, noise: 0.85 };
    const hits = await recallWithEmbeddings(
      h.hub,
      { query: "docker", nowMs: NOW },
      {},
      undefined,
      layerOf(stub({ rerank: async (_q, docs) => docs.map((d) => ({ file: d.file, score: scores[d.file.split(":")[1]!.split("#")[0]!] ?? 0 })) })),
    );
    expect(hits.map((x) => x.sessionExtId)).toEqual(["relevant", "passing", "noise"]);
    expect(hits[0]!.rerank).toBe(0.95);
  });

  it("drops what the model rejects instead of demoting it", async () => {
    const hits = await recallWithEmbeddings(
      h.hub,
      { query: "docker", nowMs: NOW },
      {},
      undefined,
      layerOf(stub({
        rerank: async (_q, docs) =>
          docs.map((d) => ({ file: d.file, score: d.file.includes("relevant") ? 0.9 : 0.01 })),
      })),
    );
    expect(hits.map((x) => x.sessionExtId)).toEqual(["relevant"]);
  });

  it("keeps one hit rather than answering nothing when everything is rejected", async () => {
    const hits = await recallWithEmbeddings(
      h.hub,
      { query: "docker", nowMs: NOW },
      {},
      undefined,
      layerOf(stub({ rerank: async (_q, docs) => docs.map((d) => ({ file: d.file, score: 0 })) })),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rerank).toBe(0);
  });

  it("honours a caller's floor", async () => {
    const rerank = async (_q: ReadonlyArray<unknown> | string, docs: ReadonlyArray<{ file: string }>) =>
      docs.map((d) => ({ file: d.file, score: d.file.includes("relevant") ? 0.9 : 0.5 }));
    const layer = layerOf(stub({ rerank: rerank as QmdRuntime["rerank"] }));
    const loose = await recallWithEmbeddings(h.hub, { query: "docker", nowMs: NOW, minRerankScore: 0.4 }, {}, undefined, layer);
    const strict = await recallWithEmbeddings(h.hub, { query: "docker", nowMs: NOW, minRerankScore: 0.8 }, {}, undefined, layer);
    expect(loose).toHaveLength(3);
    expect(strict).toHaveLength(1);
  });

  it("rerank: false leaves the lexical answer untouched", async () => {
    const hits = await recallWithEmbeddings(
      h.hub,
      { query: "docker", nowMs: NOW, rerank: false },
      {},
      undefined,
      layerOf(stub({ rerank: async () => { throw new Error("must not be called"); } })),
    );
    expect(hits).toHaveLength(3);
    expect(hits.every((x) => x.rerank === undefined)).toBe(true);
  });
});

describe("query expansion", () => {
  it("surfaces a hit the literal question misses", async () => {
    seed("bike", "The bicycle needs repair.");
    const plain = await recallWithEmbeddings(h.hub, { query: "cycle maintenance", nowMs: NOW }, {}, undefined, layerOf(null));
    expect(plain).toEqual([]);

    const widened = await recallWithEmbeddings(
      h.hub,
      { query: "cycle maintenance", nowMs: NOW, expand: true },
      {},
      undefined,
      layerOf(stub({ expand: async () => [{ type: "lex", text: "bicycle repair" }] })),
    );
    expect(widened.map((x) => x.sessionExtId)).toEqual(["bike"]);
  });

  it("ignores a generated sub-query that FTS cannot parse", async () => {
    seed("bike", "The bicycle needs repair.");
    const hits = await recallWithEmbeddings(
      h.hub,
      { query: "bicycle", nowMs: NOW, expand: true },
      {},
      undefined,
      layerOf(stub({ expand: async () => [{ type: "lex", text: 'unbalanced " quote AND' }] })),
    );
    expect(hits.map((x) => x.sessionExtId)).toEqual(["bike"]);
  });

  it("expand: false asks the model nothing", async () => {
    seed("bike", "The bicycle needs repair.");
    const hits = await recallWithEmbeddings(
      h.hub,
      { query: "bicycle", nowMs: NOW, expand: false },
      {},
      undefined,
      layerOf(stub({ expand: async () => { throw new Error("must not be called"); } })),
    );
    expect(hits).toHaveLength(1);
  });
});

describe("degrading", () => {
  beforeEach(() => seed("bike", "The bicycle needs repair."));

  it("without a runtime, the answer is exactly what it was before the layer", async () => {
    const before = await recallWithEmbeddings(h.hub, { query: "bicycle", nowMs: NOW }, {}, undefined, {});
    const withNull = await recallWithEmbeddings(h.hub, { query: "bicycle", nowMs: NOW }, {}, undefined, layerOf(null));
    expect(withNull).toEqual(before);
    expect(withNull[0]!.rerank).toBeUndefined();
  });

  it("a failing reranker warns and keeps the keyword order", async () => {
    // Two candidates, because one hit is never sent to the model: it would be
    // kept either way, and loading a model to confirm that is wasted work.
    seed("bike2", "Another bicycle, also in need of repair.");
    const warnings: string[] = [];
    const hits = await recallWithEmbeddings(
      h.hub,
      { query: "bicycle", nowMs: NOW },
      {},
      (m) => warnings.push(m),
      layerOf(stub({ rerank: async () => { throw new Error("model not cached"); } })),
    );
    expect(hits).toHaveLength(2);
    expect(warnings.join(" ")).toContain("Reranking unavailable");
  });

  it("does not load a model to judge a single hit", async () => {
    const hits = await recallWithEmbeddings(
      h.hub,
      { query: "bicycle", nowMs: NOW },
      {},
      undefined,
      layerOf(stub({ rerank: async () => { throw new Error("must not be called"); } })),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rerank).toBeUndefined();
  });

  it("a failing expander warns and still retrieves", async () => {
    const warnings: string[] = [];
    const hits = await recallWithEmbeddings(
      h.hub,
      { query: "bicycle", nowMs: NOW, expand: true },
      {},
      (m) => warnings.push(m),
      layerOf(stub({ expand: async () => { throw new Error("out of memory"); } })),
    );
    expect(hits).toHaveLength(1);
    expect(warnings.join(" ")).toContain("Query expansion unavailable");
  });

  it("stops waiting for a slow model instead of holding the answer", async () => {
    // What a cold model on CPU actually did: held an MCP call for minutes until
    // the client gave up. The answer must arrive without the model.
    seed("bike2", "Another bicycle, also in need of repair.");
    const warnings: string[] = [];
    const started = Date.now();
    const hits = await recallWithEmbeddings(
      h.hub,
      { query: "bicycle", nowMs: NOW, deadlineMs: 50 },
      {},
      (m) => warnings.push(m),
      layerOf(stub({ rerank: () => new Promise(() => {}) })),
    );
    expect(hits).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(warnings.join(" ")).toMatch(/Reranking unavailable.*longer than/);
  });

  it("openQmd stays out of the way when the layer is turned off", async () => {
    expect(await openQmd({ enabled: false })).toBeNull();
  });
});

describe("the qmd embedding provider", () => {
  it("is a semantic provider and names its own model", () => {
    expect(semanticProvider({ provider: "qmd" })).toBe(true);
    expect(semanticProvider({ provider: "none" })).toBe(false);
    expect(embeddingModel({ provider: "qmd" })).toBe(QMD_MODELS.embed);
    expect(embeddingModel({ provider: "qmd", model: "mine" })).toBe("mine");
  });

  it("embeds through the runtime, and marks a query as a query", async () => {
    const seen: Array<{ text: string; isQuery?: boolean }> = [];
    const runtime = stub({
      embed: async (text, o) => {
        seen.push({ text, isQuery: o?.isQuery });
        return [3, 4];
      },
    });
    const vector = await embedText({ provider: "qmd" }, "docker port", { runtime, isQuery: true });
    expect(seen).toEqual([{ text: "docker port", isQuery: true }]);
    // Normalised on the way in, like every other provider's output.
    expect(vector[0]! ** 2 + vector[1]! ** 2).toBeCloseTo(1);
  });

  it("says what to do when the layer is not there", async () => {
    await expect(embedText({ provider: "qmd" }, "x", { runtime: null })).rejects.toThrow(/cam doctor/);
  });
});

describe("a focused dossier", () => {
  it("orders a project's sessions by relevance", async () => {
    seed("logo", "We argued about the logo colour.");
    seed("ports", "The Docker port moved from 3000 to 80.");
    const order = await focusedSessions(h.hub, "demo", "docker port", {
      layer: layerOf(stub({
        rerank: async (_q, docs) => docs.map((d) => ({ file: d.file, score: d.file.includes("ports") ? 0.9 : 0.1 })),
      })),
    });
    expect(order).toEqual(["ports"]);
  });

  it("does not teach the memory layer what a report was ordered by", async () => {
    seed("ports", "The Docker port moved from 3000 to 80.");
    await focusedSessions(h.hub, "demo", "docker port", { layer: layerOf(null) });
    const logged = h.hub.prepare("select count(*) n from memory_queries").get() as { n: number };
    expect(logged.n).toBe(0);
  });
});

describe("paths", () => {
  it("resolves qmd's cache the way qmd does, on every platform", () => {
    // Not LOCALAPPDATA on Windows: qmd reads XDG_CACHE_HOME or ~/.cache there
    // too, and looking anywhere else reports downloaded models as missing.
    expect(qmdCacheHome({}, "/home/someone")).toBe(path.join("/home/someone", ".cache"));
    expect(qmdIndexPath({}, "/home/someone")).toBe(path.join("/home/someone", ".cache", "qmd", "index.sqlite"));
    expect(qmdModelCacheDir({}, "/home/someone")).toBe(path.join("/home/someone", ".cache", "qmd", "models"));
  });

  it("puts both the index and the weights under a configured cacheHome", () => {
    const cfg = { cacheHome: path.join("/data", "cache") };
    const root = path.resolve(cfg.cacheHome);
    expect(qmdIndexPath(cfg)).toBe(path.join(root, "qmd", "index.sqlite"));
    expect(qmdModelCacheDir(cfg)).toBe(path.join(root, "qmd", "models"));
  });

  it("resolves a relative cacheHome instead of writing beside the caller", () => {
    // How two gigabytes of weights ended up inside a repository: a relative
    // cache home lands wherever the command was run from.
    expect(path.isAbsolute(qmdModelCacheDir({ cacheHome: ".cache" }))).toBe(true);
  });

  it("honours an explicit index override", () => {
    process.env.QMD_INDEX_PATH = "/tmp/elsewhere.sqlite";
    try {
      expect(qmdIndexPath()).toBe("/tmp/elsewhere.sqlite");
    } finally {
      delete process.env.QMD_INDEX_PATH;
    }
  });

  it("reports a model cache that is not there as nothing cached", () => {
    const present = modelsPresent(QMD_MODELS, "/definitely/not/a/directory");
    expect(present).toEqual({ embed: false, generate: false, rerank: false });
  });

  it("keeps the GPU out of cam's way by default, and leaves the user's own choice alone", () => {
    for (const k of ["QMD_FORCE_CPU", "QMD_LLAMA_GPU"]) delete process.env[k];
    applyGpuMode(false);
    expect(process.env.QMD_FORCE_CPU).toBe("1");

    for (const k of ["QMD_FORCE_CPU", "QMD_LLAMA_GPU"]) delete process.env[k];
    process.env.QMD_LLAMA_GPU = "cuda";
    applyGpuMode(false);
    expect(process.env.QMD_FORCE_CPU).toBeUndefined();
    delete process.env.QMD_LLAMA_GPU;
  });
});
