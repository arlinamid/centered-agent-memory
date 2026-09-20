import path from "node:path";
import type { QmdRuntime, QmdStoreLike } from "./runtime.js";

/**
 * A project's own files, searchable, with notes attached to paths.
 *
 * This is the one place cam does put something into qmd's index, and the
 * distinction matters: conversations stay in the hub because they live in other
 * applications' stores and cam only holds locators into them. A project's files
 * are already on disk, already the user's, and qmd indexes files — including
 * `.tsx` and `.js`, which it chunks by syntax rather than by line, so a hit
 * lands on a function rather than halfway through one.
 *
 * A note is qmd's `context` for a path: a sentence about what a file is for,
 * which the search reads alongside the file. It is the thing a codebase cannot
 * tell you about itself — why this module exists, what not to touch — and it
 * belongs next to the file, not in a conversation nobody will search for.
 */

/** Collections cam creates are named after the project, and say so. */
export const COLLECTION_PREFIX = "cam-";

export function collectionName(project: string): string {
  const slug = project
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${COLLECTION_PREFIX}${slug || "project"}`;
}

/**
 * What gets indexed when nobody says otherwise.
 *
 * Everything textual, not just markdown: the request was file-level notes on
 * `.tsx` and `.js`, and a collection that silently skipped them would answer
 * questions about the docs folder while pretending the code was not there.
 */
export const DEFAULT_PATTERN =
  "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py,go,rs,java,kt,rb,php,cs,swift,c,h,cpp,hpp," +
  "sql,sh,ps1,yml,yaml,toml,json,md,mdx,txt,html,css,scss,vue,svelte}";

/**
 * Directories whose contents are generated, vendored or enormous.
 *
 * Indexing `node_modules` is not merely slow: it buries the project's own files
 * under a hundred thousand someone else wrote, which is the opposite of what a
 * project collection is for.
 */
export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/target/**",
  "**/vendor/**",
  "**/*.min.js",
  "**/*.lock",
  "**/package-lock.json",
];

export interface DocHit {
  collection: string;
  /** Collection-relative, as qmd reports it. */
  path: string;
  title: string | null;
  score: number;
  snippet: string;
  /** The note attached to this path, when there is one. */
  note: string | null;
  docid: string | null;
}

export interface DocsApi {
  list(): Promise<Array<{ name: string; path: string; files: number }>>;
  add(name: string, opts: { path: string; pattern?: string; ignore?: string[] }): Promise<void>;
  remove(name: string): Promise<boolean>;
  index(name?: string): Promise<{ indexed: number; updated: number; removed: number }>;
  query(query: string, opts?: { collection?: string; limit?: number; minScore?: number; rerank?: boolean; keywordOnly?: boolean }): Promise<DocHit[]>;
  get(pathOrDocid: string): Promise<{ path: string; text: string } | null>;
  note(collection: string, pathPrefix: string, text: string): Promise<boolean>;
  unnote(collection: string, pathPrefix: string): Promise<boolean>;
  notes(collection?: string): Promise<Array<{ collection: string; path: string; note: string }>>;
}

/** qmd names the matched text differently depending on the search path taken. */
function snippetOf(row: Record<string, unknown>): string {
  for (const key of ["snippet", "excerpt", "body", "text"]) {
    const v = row[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

export function docsApi(runtime: QmdRuntime): DocsApi {
  const store: QmdStoreLike = runtime.store;

  /**
   * qmd reports a hit as `qmd://<collection>/<path>`; a note is stored against
   * the bare path. Comparing the two as they come matched nothing, which looked
   * exactly like "this file has no note".
   */
  const relativePath = (file: string, collection: string): string => {
    const bare = file.replace(/^qmd:[/][/]/, "");
    const prefix = collection + "/";
    return (bare.startsWith(prefix) ? bare.slice(prefix.length) : bare).split("\\").join("/");
  };

  const noteFor = async (collection: string, filePath: string): Promise<string | null> => {
    const all = await store.listContexts();
    // The longest matching prefix wins: a note on `src/qmd/` describes the
    // folder, one on `src/qmd/runtime.ts` describes the file, and the file's
    // own note is the more specific answer.
    let best: { path: string; context: string } | null = null;
    for (const c of all) {
      if (c.collection !== collection) continue;
      const prefix = c.path.replace(/\\/g, "/");
      if (!filePath.startsWith(prefix.replace(/^\.\//, ""))) continue;
      if (!best || prefix.length > best.path.length) best = { path: prefix, context: c.context };
    }
    return best?.context ?? null;
  };

  return {
    async list() {
      const rows = await store.listCollections();
      return rows
        .filter((r) => r.name.startsWith(COLLECTION_PREFIX))
        .map((r) => ({ name: r.name, path: r.pwd, files: r.active_count ?? r.doc_count ?? 0 }));
    },

    async add(name, opts) {
      await store.addCollection(name, {
        path: path.resolve(opts.path),
        pattern: opts.pattern ?? DEFAULT_PATTERN,
        ignore: opts.ignore ?? DEFAULT_IGNORE,
      });
    },

    async remove(name) {
      return store.removeCollection(name);
    },

    async index(name) {
      const result = await store.update(name ? { collections: [name] } : undefined);
      // Embedding is what makes a question work that shares no words with the
      // file; without it the collection is grep with extra steps.
      await store.embed(name ? { collection: name } : undefined);
      return { indexed: result.indexed, updated: result.updated, removed: result.removed };
    },

    async query(query, opts = {}) {
      const collections = opts.collection ? [opts.collection] : (await this.list()).map((c) => c.name);
      if (collections.length === 0) return [];
      const limit = Math.min(50, Math.max(1, opts.limit ?? 10));
      // Keyword-only when asked: the hybrid path loads an embedding model and a
      // reranker, and loading either blocks the event loop for about a minute.
      // A server that must stay responsive takes BM25 and says what it did.
      const rows = opts.keywordOnly
        ? await store.searchLex(query, { limit, collection: collections })
        : await store.search({
            query,
            collections,
            limit,
            minScore: opts.minScore,
            rerank: opts.rerank !== false,
          });

      const out: DocHit[] = [];
      for (const r of rows) {
        const display = String(r.displayPath ?? r.file ?? r.path ?? "");
        // `displayPath` is `<collection>/<path>`, but `file` is a qmd:// URI
        // whose first segment is the scheme. Splitting the wrong one names the
        // collection "qmd:" and every note lookup quietly misses.
        const named = typeof r.collection === "string" ? r.collection : "";
        const collection =
          named || display.replace(/^qmd:[/][/]/, "").split("/")[0] || collections[0] || "";
        const file = relativePath(String(r.file ?? r.path ?? display), collection);
        out.push({
          collection,
          path: file,
          title: typeof r.title === "string" ? r.title : null,
          score: Number(r.score ?? 0),
          snippet: snippetOf(r).replace(/\s+/g, " ").trim().slice(0, 300),
          note: await noteFor(collection, file),
          docid: typeof r.docid === "string" ? r.docid : null,
        });
      }
      return out;
    },

    async get(pathOrDocid) {
      const doc = await store.get(pathOrDocid, { includeBody: true });
      if (!doc || "error" in doc) return null;
      const body = doc.body ?? doc.text ?? doc.content;
      return { path: String(doc.path ?? doc.filepath ?? pathOrDocid), text: typeof body === "string" ? body : "" };
    },

    async note(collection, pathPrefix, text) {
      return store.addContext(collection, pathPrefix, text);
    },

    async unnote(collection, pathPrefix) {
      return store.removeContext(collection, pathPrefix);
    },

    async notes(collection) {
      const all = await store.listContexts();
      return all
        .filter((c) => c.collection.startsWith(COLLECTION_PREFIX) && (!collection || c.collection === collection))
        .map((c) => ({ collection: c.collection, path: c.path, note: c.context }));
    },
  };
}

export function formatDocHits(hits: ReadonlyArray<DocHit>, query: string): string {
  if (hits.length === 0) return `No files matched: ${query}`;
  const lines: string[] = [];
  for (const h of hits) {
    lines.push(`${h.score.toFixed(2)}  ${h.collection}  ${h.path}${h.title ? `  · ${h.title}` : ""}`);
    if (h.note) lines.push(`  note: ${h.note}`);
    if (h.snippet) lines.push(`  ${h.snippet}`);
    lines.push("");
  }
  lines.push(`${hits.length} file(s).`);
  return lines.join("\n");
}

export function formatNotes(notes: ReadonlyArray<{ collection: string; path: string; note: string }>): string {
  if (notes.length === 0) return "No file notes yet. Add one with: cam note add <file> \"<what it is for>\"";
  return notes.map((n) => `${n.collection}  ${n.path}\n  ${n.note}`).join("\n\n");
}
