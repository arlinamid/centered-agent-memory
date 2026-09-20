import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * qmd as a model runtime.
 *
 * cam keeps its own index, its own attribution and its own citations; what it
 * did not have was a relevance model. qmd ships three, on-device and cached in
 * SQLite, and its SDK hands them over without asking for the documents: query
 * expansion, embeddings, and reranking. Nothing of the user's conversations is
 * written into qmd's store — this module only borrows the models.
 *
 * Everything here returns rather than throws. A missing model, a failed import
 * or an offline machine must cost precision, never recall: the caller falls
 * back to the lexical path and says so.
 */

/** qmd's defaults, pinned explicitly so a user's own index.yml cannot move them. */
export const QMD_MODELS = {
  embed: "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
  generate: "hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf",
  rerank: "hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf",
} as const;

/**
 * What the reranker is told it is reading. Without it the model scores these
 * excerpts as documents, and a conversation is not a document: the thing being
 * looked for is usually the decision or the change, not the topic.
 */
export const DEFAULT_INTENT =
  "Excerpts from the user's earlier conversations with AI coding tools. " +
  "Prefer passages that state what was decided, changed or explained.";

export type QueryType = "lex" | "vec" | "hyde";
export interface ExpandedQuery {
  type: QueryType;
  text: string;
}

export interface RerankDoc {
  /** Any stable key; cam passes the citation and matches results back by it. */
  file: string;
  text: string;
}

export interface QmdConfig {
  /** `false` keeps cam on the lexical path, as if qmd were not installed. */
  enabled?: boolean;
  /** Defaults to qmd's own index, so its model and LLM caches are shared. */
  dbPath?: string;
  /**
   * qmd's cache root, holding the index and the GGUF weights. Point it at a
   * drive with room when the home drive has none — the three models are a
   * couple of gigabytes.
   */
  cacheHome?: string;
  models?: Partial<typeof QMD_MODELS>;
  /**
   * Widen the query before retrieval. **Off by default, on measurement.**
   *
   * Expansion runs a 1.7B generative model: ~74 s per new question on a Vulkan
   * GPU, ~197 s on CPU. Reranking does the de-noising this layer exists for and
   * costs ~8 s warm. Paying a minute and a half to phrase the question three
   * more ways is not a trade a search should make on its own — turn it on
   * deliberately, for a corpus where recall matters more than latency.
   */
  expand?: boolean;
  /**
   * How long the whole layer may take before recall answers without it.
   *
   * The promise is that a slow model costs precision, never an answer. Without
   * a deadline that promise is false: a cold model held an MCP call for three
   * and a half minutes, and the client closed the connection. The abandoned
   * call still finishes in the background and qmd caches its result, so the
   * same question asked again is fast.
   */
  deadlineMs?: number;
  /** Rerank retrieved candidates and drop the ones below `minRerankScore`. */
  rerank?: boolean;
  /**
   * Load the reranker when a long-lived server starts. **Off by default.**
   *
   * Loading is native and synchronous: it blocks the event loop for about a
   * minute, during which the server answers nothing at all — not even the tool
   * listing a client asks for on connect, which is why clients were timing out
   * at sixty seconds. Off, an MCP server answers immediately and without the
   * relevance model, and says so. On, it pays the freeze once at startup and
   * reranks from then on. The one-shot CLI ignores this: it always waits,
   * because it has no later.
   */
  warmUp?: boolean;
  /** Below this the reranker's verdict is "not relevant", and the hit is cut. */
  minRerankScore?: number;
  /** Clean transcript exhaust out of turns when rendering chunks. */
  denoise?: boolean;
  intent?: string;
  /**
   * Which accelerator the models may use.
   *
   * `"auto"` by default, because CPU turned out not to be a usable option
   * rather than a slower one: reranking measured ~83 s on CPU against ~8 s on
   * a Vulkan GPU, and embedding ~45 s against fractions of a second. `false`
   * is still there for a machine whose GPU is busy with the work the person is
   * actually doing — with `expand` off and a deadline in place, the layer only
   * asks for a few seconds of it per question.
   */
  gpu?: false | "auto" | "metal" | "vulkan" | "cuda";
}

/** The layer's whole budget for one question. */
export const DEFAULT_DEADLINE_MS = 20_000;

/**
 * Stop waiting, without pretending the work stopped.
 *
 * The model call keeps running and its result lands in qmd's cache, which is
 * why a question that timed out once is usually fast the second time. What this
 * bounds is how long a person waits, not how long a GPU works.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`)),
          Math.max(1, ms),
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface QmdRuntime {
  embed(text: string, opts?: { isQuery?: boolean; title?: string }): Promise<number[]>;
  expand(query: string): Promise<ExpandedQuery[]>;
  rerank(query: string, docs: ReadonlyArray<RerankDoc>, intent?: string): Promise<Array<{ file: string; score: number }>>;
  models(): typeof QMD_MODELS;
  /**
   * Load the reranker now, so the first real question does not pay for it.
   *
   * Loading it measured ~60 s on this hardware, which a question cannot wait
   * for and a deadline therefore skips — meaning a freshly started server
   * answers its first few questions without the layer it was installed for.
   * A long-lived process has idle time before anyone asks; this spends it.
   */
  warmUp(): Promise<void>;
  /**
   * Whether the reranker is loaded and answering quickly.
   *
   * This exists because a deadline cannot save a caller from the first load:
   * node-llama-cpp loads a model in native code, which blocks the event loop,
   * so the timer meant to cut the wait short never gets to fire. The only way
   * not to wait is not to ask. Until this is true, recall answers lexically and
   * says the model is still coming.
   */
  readonly ready: boolean;
  /**
   * The qmd store itself, for the things cam does not wrap: project file
   * collections and the notes attached to their paths. Those are qmd's own
   * documents, indexed in qmd's own index — unlike conversations, which stay
   * in the hub and only borrow the models.
   */
  readonly store: QmdStoreLike;
  dbPath: string;
  close(): Promise<void>;
}

/**
 * qmd's cache root.
 *
 * `XDG_CACHE_HOME` or `~/.cache` — on every platform, Windows included. qmd
 * does not use `LOCALAPPDATA` there, and guessing that it might would have cam
 * looking for models in a directory qmd never writes, reporting "not cached"
 * about files that are sitting on disk.
 *
 * `cacheHome` exists because the weights are gigabytes and the home drive is
 * not always where there is room for them.
 */
export function qmdCacheHome(config: QmdConfig = {}, home = os.homedir()): string {
  const root = config.cacheHome ?? process.env.XDG_CACHE_HOME;
  return root ? path.resolve(root) : path.join(home, ".cache");
}

/**
 * Where qmd keeps its index.
 *
 * Resolved here rather than asked of qmd: `getDefaultDbPath` throws outside
 * qmd's own production mode, and a thrown path would take the whole layer down
 * for a question cam can answer itself.
 */
export function qmdIndexPath(config: QmdConfig = {}, home = os.homedir()): string {
  if (process.env.QMD_INDEX_PATH) return process.env.QMD_INDEX_PATH;
  if (process.env.INDEX_PATH) return process.env.INDEX_PATH;
  return path.join(qmdCacheHome(config, home), "qmd", "index.sqlite");
}

/** Where `qmd pull` leaves the GGUF files, so cam can say whether they are there. */
export function qmdModelCacheDir(config: QmdConfig = {}, home = os.homedir()): string {
  return path.join(qmdCacheHome(config, home), "qmd", "models");
}

/**
 * Which of the three models have been downloaded.
 *
 * Reported rather than enforced: a model arrives on first use, so "missing" is
 * a statement about this moment, not a refusal. `cam doctor` prints it and
 * `cam recall` mentions it only when the layer actually degraded.
 */
export function modelsPresent(models: typeof QMD_MODELS = QMD_MODELS, dir = qmdModelCacheDir()): Record<"embed" | "generate" | "rerank", boolean> {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  const present = (uri: string): boolean => {
    const file = uri.split("/").pop()?.toLowerCase() ?? "";
    if (!file) return false;
    return entries.some((e) => e.toLowerCase().includes(file) && e.toLowerCase().endsWith(".gguf"));
  };
  return { embed: present(models.embed), generate: present(models.generate), rerank: present(models.rerank) };
}

/** The minimum of qmd's SDK this module uses, named so the import stays typed. */
export interface QmdStoreLike {
  internal: {
    llm?: {
      embed(text: string, options?: { model?: string; isQuery?: boolean; title?: string }): Promise<{ embedding?: number[]; vector?: number[] } | number[] | null>;
    };
    expandQuery(query: string, model?: string): Promise<Array<{ type: string; text: string }>>;
    rerank(
      query: string,
      documents: Array<{ file: string; text: string }>,
      model?: string,
      intent?: string,
    ): Promise<Array<{ file: string; score: number }>>;
  };
  close(): Promise<void>;

  // The SDK surface, used for project file collections and their notes.
  addCollection(name: string, opts: { path: string; pattern?: string; ignore?: string[] }): Promise<void>;
  removeCollection(name: string): Promise<boolean>;
  listCollections(): Promise<Array<{ name: string; pwd: string; glob_pattern: string; doc_count: number; active_count: number }>>;
  update(opts?: { collections?: string[] }): Promise<{ indexed: number; updated: number; unchanged: number; removed: number; skipped: number }>;
  embed(opts?: { collection?: string }): Promise<unknown>;
  search(opts: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  /** BM25 only — no model, so it answers without blocking on one. */
  searchLex(query: string, opts?: { limit?: number; collection?: string | string[] }): Promise<Array<Record<string, unknown>>>;
  get(pathOrDocid: string, opts?: { includeBody?: boolean }): Promise<Record<string, unknown>>;
  addContext(collection: string, pathPrefix: string, text: string): Promise<boolean>;
  removeContext(collection: string, pathPrefix: string): Promise<boolean>;
  listContexts(): Promise<Array<{ collection: string; path: string; context: string }>>;
}

/**
 * One store per process, opened on first use.
 *
 * qmd loads a model on first call and unloads it after five idle minutes, so
 * holding the handle open costs nothing between questions but saves the load on
 * a second question — which is the normal case, because an agent that asks once
 * usually asks again.
 */
let shared: Promise<QmdRuntime | null> | null = null;

export async function openQmd(config: QmdConfig = {}, warn?: (message: string) => void): Promise<QmdRuntime | null> {
  // The kill switch exists for the test suite above all: opening the layer
  // would create qmd's index on the machine running the tests, and a test must
  // not leave anything behind outside its own directory.
  if (config.enabled === false || process.env.CAM_QMD === "0") return null;
  shared ??= create(config, warn);
  return shared;
}

/**
 * Release the store.
 *
 * Not optional housekeeping: the store holds an open SQLite handle and keeps
 * the event loop alive, so a one-shot CLI run that forgets this never exits.
 */
export async function closeQmd(): Promise<void> {
  const current = shared;
  shared = null;
  if (!current) return;
  try {
    await (await current)?.close();
  } catch {
    // Closing a handle that never opened is not a failure worth reporting.
  }
}

async function create(config: QmdConfig, warn?: (message: string) => void): Promise<QmdRuntime | null> {
  const models = { ...QMD_MODELS, ...(config.models ?? {}) };
  const dbPath = config.dbPath ?? qmdIndexPath();
  try {
    applyGpuMode(config.gpu ?? "auto");
    applyCacheHome(config.cacheHome);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const qmd = (await import("@tobilu/qmd")) as unknown as {
      createStore(options: { dbPath: string; config?: unknown }): Promise<QmdStoreLike>;
    };
    // An empty collection set on purpose: cam indexes nothing here and asks
    // nothing of qmd's documents. The store exists to own the three models and
    // their caches.
    const store = await qmd.createStore({ dbPath, config: { collections: {}, models } });
    return wrap(store, models, dbPath);
  } catch (err) {
    warn?.(`qmd layer unavailable; using keyword search: ${(err as Error).message}`);
    return null;
  }
}

/**
 * qmd reads its accelerator choice from the environment, every time it asks.
 * Setting it here keeps the decision in cam's configuration while still letting
 * an environment variable the user set themselves win — they are closer to the
 * machine than a default is.
 */
/**
 * qmd derives both its index path and its model cache from `XDG_CACHE_HOME`,
 * and reads it at import time. Setting it in this process — not in the user's
 * environment — is how cam's `cacheHome` reaches it without changing what any
 * other tool on the machine does.
 */
export function applyCacheHome(cacheHome?: string): void {
  if (!cacheHome || process.env.XDG_CACHE_HOME !== undefined) return;
  // Resolved, not passed through: a value that is not absolute lands relative
  // to whatever directory the command happened to run in, and the first sign of
  // that is a second copy of two gigabytes of weights inside a repository.
  const root = path.resolve(cacheHome);
  fs.mkdirSync(path.join(root, "qmd"), { recursive: true });
  process.env.XDG_CACHE_HOME = root;
}

export function applyGpuMode(gpu: false | "auto" | "metal" | "vulkan" | "cuda"): void {
  if (process.env.QMD_LLAMA_GPU !== undefined || process.env.QMD_FORCE_CPU !== undefined) return;
  if (gpu === false) {
    process.env.QMD_FORCE_CPU = "1";
    process.env.QMD_LLAMA_GPU = "false";
    return;
  }
  if (gpu !== "auto") process.env.QMD_LLAMA_GPU = gpu;
}

function wrap(store: QmdStoreLike, models: typeof QMD_MODELS, dbPath: string): QmdRuntime {
  let ready = false;
  let warming: Promise<void> | null = null;

  const runtime: QmdRuntime = {
    dbPath,
    store,
    models: () => models,
    get ready() {
      return ready;
    },

    async embed(text, opts) {
      const llm = store.internal.llm;
      if (!llm) throw new Error("qmd store has no model runtime");
      const result = await llm.embed(text, { model: models.embed, isQuery: opts?.isQuery, title: opts?.title });
      const vector = Array.isArray(result) ? result : (result?.embedding ?? result?.vector);
      if (!Array.isArray(vector) || vector.length === 0) throw new Error("qmd returned no embedding");
      return vector;
    },

    async expand(query) {
      const raw = await store.internal.expandQuery(query, models.generate);
      const out: ExpandedQuery[] = [];
      for (const q of raw ?? []) {
        const text = typeof q?.text === "string" ? q.text.trim() : "";
        if (!text) continue;
        const type: QueryType = q.type === "vec" || q.type === "hyde" ? q.type : "lex";
        out.push({ type, text });
      }
      return out;
    },

    async rerank(query, docs, intent) {
      if (docs.length === 0) return [];
      const scored = await store.internal.rerank(
        query,
        docs.map((d) => ({ file: d.file, text: d.text })),
        models.rerank,
        intent ?? DEFAULT_INTENT,
      );
      return (scored ?? []).filter((s) => typeof s?.file === "string" && Number.isFinite(s.score));
    },

    async warmUp() {
      // A trivial pair: the answer is discarded, the loaded model is the point.
      warming ??= store.internal
        .rerank("warm up", [{ file: "warm", text: "warm up" }], models.rerank)
        .then(() => {
          ready = true;
        });
      await warming;
    },

    async close() {
      await store.close();
    },
  };

  return runtime;
}
