import { createHash } from "node:crypto";
import type { Db } from "../db/open.js";
import { Hydrator } from "../index/hydrate.js";
import { commandProvider } from "../memory/dream.js";
import { QMD_MODELS, type QmdRuntime } from "../qmd/runtime.js";

/**
 * Where vectors come from.
 *
 * `command` reads JSON { model, input: [text] } and returns
 * { embeddings: [[number]] } — any provider the user can wrap in a script.
 * `qmd` uses the bundled on-device model instead, which is the path that needs
 * no configuration at all.
 */
export interface EmbeddingConfig {
  provider?: "none" | "command" | "qmd";
  model?: string;
  command?: string[];
  timeoutMs?: number;
  maxInputChars?: number;
  minSimilarity?: number;
}

/** Everything the qmd provider needs that the config cannot carry. */
export interface EmbedCtx {
  runtime?: QmdRuntime | null;
  /**
   * Queries and documents are embedded with different prompt prefixes by
   * embeddinggemma. Getting this wrong does not fail, it just retrieves worse,
   * which is the kind of bug that never announces itself.
   */
  isQuery?: boolean;
  title?: string;
}

/** True when this config can produce vectors at all. */
export function semanticProvider(config: EmbeddingConfig): boolean {
  return config.provider === "command" || config.provider === "qmd";
}

/**
 * The identifier vectors are stored under. It has to be stable, because
 * `chunk_embeddings.model` is what decides whether an existing vector still
 * applies — so the qmd provider names its model even when the user did not.
 */
export function embeddingModel(config: EmbeddingConfig): string | undefined {
  if (config.model?.trim()) return config.model;
  return config.provider === "qmd" ? QMD_MODELS.embed : undefined;
}

export interface QueryEmbedding { model: string; vector: number[]; minSimilarity?: number }

export function normalizeVector(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.length > 65536 ||
      !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error("embedding must be a non-empty array of finite numbers (at most 65536 dimensions)");
  }
  const scale = Math.max(...value.map(Math.abs));
  if (!scale) throw new Error("embedding must not be a zero vector");
  const scaled = value.map((n: number) => n / scale);
  const norm = Math.sqrt(scaled.reduce((sum, n) => sum + n * n, 0));
  return scaled.map((n) => n / norm);
}

export function encodeVector(vector: number[]): Buffer {
  const out = Buffer.alloc(vector.length * 4);
  vector.forEach((n, i) => out.writeFloatLE(n, i * 4));
  return out;
}

export function cosine(vector: number[], blob: Buffer, dims: number): number | null {
  if (dims !== vector.length || blob.length !== dims * 4) return null;
  let dot = 0;
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    const n = blob.readFloatLE(i * 4);
    if (!Number.isFinite(n)) return null;
    dot += vector[i]! * n;
    norm += n * n;
  }
  return norm > 0 ? Math.max(-1, Math.min(1, dot / Math.sqrt(norm))) : null;
}

export async function embedText(config: EmbeddingConfig, text: string, ctx: EmbedCtx = {}): Promise<number[]> {
  if (config.provider === "qmd") {
    if (!ctx.runtime) throw new Error("qmd layer unavailable; run cam doctor to see which models are missing");
    return normalizeVector(await ctx.runtime.embed(text, { isQuery: ctx.isQuery, title: ctx.title }));
  }
  if (config.provider !== "command" || !config.model?.trim() || !config.command?.length) {
    throw new Error("Configure memory.embedding with provider: command or qmd; see docs/memory.md.");
  }
  const raw = await commandProvider({ ...config, provider: "command" }).generate(
    JSON.stringify({ model: config.model, input: [text] }),
  );
  const result = JSON.parse(raw) as { embeddings?: unknown[] };
  if (!Array.isArray(result?.embeddings) || result.embeddings.length !== 1) {
    throw new Error("embedding command must return JSON { embeddings: [[number, ...]] }");
  }
  return normalizeVector(result.embeddings[0]);
}

export interface EmbeddingItem { chunkId: number; hash: string; text: string; title?: string }

export function planEmbeddings(db: Db, config: EmbeddingConfig, opts: { project?: string | null; limit?: number; force?: boolean } = {}): EmbeddingItem[] {
  const limit = Math.min(1000, Math.max(1, Math.trunc(opts.limit ?? 100)));
  if (!Number.isFinite(limit)) throw new Error("embedding limit must be a positive finite number");
  const maxChars = config.maxInputChars ?? 8000;
  if (!Number.isFinite(maxChars) || maxChars < 1) throw new Error("embedding maxInputChars must be positive");
  const rows = db.prepare(`select c.id, c.text_sha256, s.title from chunks c
    left join sessions s on s.id = c.session_id
    left join projects p on p.id = c.project_id
    left join chunk_embeddings e on e.chunk_id = c.id
    where (? is null or p.key = ?) and (? = 1 or e.chunk_id is null or e.model != ? or e.input_sha256 is null or e.input_sha256 != c.text_sha256)
    order by c.id`).iterate(opts.project ?? null, opts.project ?? null, opts.force ? 1 : 0, embeddingModel(config) ?? "?");
  const hydrator = new Hydrator(db);
  const items: EmbeddingItem[] = [];
  try {
    for (const row of rows as Iterable<{ id: number; text_sha256: string; title: string | null }>) {
      const resolved = hydrator.resolveChunk(row.id);
      if (resolved.status !== "ok" || !resolved.readable || !resolved.text.trim()) continue;
      if (createHash("sha256").update(resolved.text).digest("hex") !== row.text_sha256) continue;
      items.push({
        chunkId: row.id,
        hash: row.text_sha256,
        text: resolved.text.slice(0, maxChars),
        title: row.title ?? undefined,
      });
      if (items.length >= limit) break;
    }
  } finally { hydrator.close(); }
  return items;
}

/** Run an already disclosed plan; each item is independently retryable. */
export async function runEmbeddings(db: Db, config: EmbeddingConfig, items: EmbeddingItem[], ctx: EmbedCtx = {}): Promise<{ generated: number; failed: number; errors: string[] }> {
  const stat = { generated: 0, failed: 0, errors: [] as string[] };
  const model = embeddingModel(config);
  if (!model) throw new Error("Configure memory.embedding with provider: command or qmd; see docs/memory.md.");
  const existing = db.prepare("select dims from chunk_embeddings where model = ? and input_sha256 is not null limit 1").get(model) as { dims: number } | undefined;
  let dims = existing?.dims;
  const insert = db.prepare(`insert into chunk_embeddings(chunk_id, model, dims, embedding, input_sha256)
    select id, ?, ?, ?, ? from chunks where id = ? and text_sha256 = ?
    on conflict(chunk_id) do update set model = excluded.model, dims = excluded.dims,
      embedding = excluded.embedding, input_sha256 = excluded.input_sha256`);
  for (const item of items) {
    try {
      const vector = await embedText(config, item.text, { ...ctx, isQuery: false, title: item.title });
      if (dims !== undefined && vector.length !== dims) throw new Error(`embedding dimension changed from ${dims} to ${vector.length}; use a new model identifier`);
      const changed = insert.run(model, vector.length, encodeVector(vector), item.hash, item.chunkId, item.hash).changes;
      if (!changed) throw new Error("source changed during embedding; sync and retry");
      dims = vector.length;
      stat.generated++;
    } catch (err) {
      stat.failed++;
      stat.errors.push(`#${item.chunkId}: ${(err as Error).message}`);
    }
  }
  return stat;
}
