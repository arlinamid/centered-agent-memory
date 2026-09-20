import { describe, expect, it } from "vitest";
import {
  COLLECTION_PREFIX,
  DEFAULT_IGNORE,
  DEFAULT_PATTERN,
  collectionName,
  docsApi,
  formatDocHits,
  formatNotes,
} from "../src/qmd/docs.js";
import { QMD_MODELS, type QmdRuntime, type QmdStoreLike } from "../src/qmd/runtime.js";

/** A qmd store made of plain objects: no index, no models, no filesystem. */
function stubStore(over: Partial<QmdStoreLike> = {}): QmdStoreLike {
  const collections: Array<{ name: string; pwd: string; glob_pattern: string; doc_count: number; active_count: number }> = [];
  const contexts: Array<{ collection: string; path: string; context: string }> = [];
  return {
    internal: {
      expandQuery: async () => [],
      rerank: async () => [],
    },
    close: async () => {},
    addCollection: async (name, opts) => {
      collections.push({
        name,
        pwd: opts.path,
        glob_pattern: opts.pattern ?? "",
        doc_count: 0,
        active_count: 0,
      });
    },
    removeCollection: async (name) => {
      const i = collections.findIndex((c) => c.name === name);
      if (i >= 0) collections.splice(i, 1);
      return i >= 0;
    },
    listCollections: async () => collections,
    update: async () => ({ indexed: 2, updated: 1, unchanged: 0, removed: 0, skipped: 0 }),
    embed: async () => undefined,
    search: async () => [],
    get: async () => ({}),
    addContext: async (collection, path, text) => {
      contexts.push({ collection, path, context: text });
      return true;
    },
    removeContext: async (collection, path) => {
      const i = contexts.findIndex((c) => c.collection === collection && c.path === path);
      if (i >= 0) contexts.splice(i, 1);
      return i >= 0;
    },
    listContexts: async () => contexts,
    ...over,
  };
}

function runtimeWith(store: QmdStoreLike): QmdRuntime {
  return {
    store,
    dbPath: "(stub)",
    ready: true,
    models: () => QMD_MODELS,
    embed: async () => [1, 0],
    expand: async () => [],
    rerank: async () => [],
    warmUp: async () => {},
    close: async () => {},
  };
}

describe("collection naming", () => {
  it("is derived from the project and says where it came from", () => {
    expect(collectionName("centered-agent-memory")).toBe(`${COLLECTION_PREFIX}centered-agent-memory`);
    expect(collectionName("My Project (v2)")).toBe(`${COLLECTION_PREFIX}my-project-v2`);
    expect(collectionName("///")).toBe(`${COLLECTION_PREFIX}project`);
  });
});

describe("what gets indexed", () => {
  it("covers code, not just prose — the point of file-level notes", () => {
    for (const ext of ["ts", "tsx", "js", "jsx", "py", "go", "rs", "md"]) {
      expect(DEFAULT_PATTERN).toContain(ext);
    }
  });

  it("leaves out what a project did not write", () => {
    expect(DEFAULT_IGNORE).toContain("**/node_modules/**");
    expect(DEFAULT_IGNORE).toContain("**/dist/**");
    expect(DEFAULT_IGNORE).toContain("**/package-lock.json");
  });
});

describe("notes on a path", () => {
  it("attaches to a hit even though qmd reports a qmd:// URI", async () => {
    // The bug this pins: a note is stored against `src/a.ts` and the hit comes
    // back as `qmd://cam-demo/src/a.ts`. Compared as-is they never match, and
    // every file looks like it has no note.
    const store = stubStore({
      search: async () => [
        { file: "qmd://cam-demo/src/a.ts", displayPath: "cam-demo/src/a.ts", title: "a", score: 0.9, body: "export const a = 1;" },
      ],
      listCollections: async () => [
        { name: "cam-demo", pwd: "/p", glob_pattern: "", doc_count: 1, active_count: 1 },
      ],
      listContexts: async () => [{ collection: "cam-demo", path: "src/a.ts", context: "The entry point." }],
    });
    const hits = await docsApi(runtimeWith(store)).query("anything");
    expect(hits[0]!.path).toBe("src/a.ts");
    expect(hits[0]!.note).toBe("The entry point.");
    expect(hits[0]!.snippet).toContain("export const a");
  });

  it("prefers the most specific note when a folder also has one", async () => {
    const store = stubStore({
      search: async () => [{ file: "qmd://cam-demo/src/qmd/runtime.ts", score: 0.5 }],
      listCollections: async () => [
        { name: "cam-demo", pwd: "/p", glob_pattern: "", doc_count: 1, active_count: 1 },
      ],
      listContexts: async () => [
        { collection: "cam-demo", path: "src/", context: "Sources." },
        { collection: "cam-demo", path: "src/qmd/runtime.ts", context: "Borrows the models." },
      ],
    });
    const hits = await docsApi(runtimeWith(store)).query("anything");
    expect(hits[0]!.note).toBe("Borrows the models.");
  });

  it("does not borrow another collection's note", async () => {
    const store = stubStore({
      search: async () => [{ file: "qmd://cam-demo/src/a.ts", score: 0.5 }],
      listCollections: async () => [
        { name: "cam-demo", pwd: "/p", glob_pattern: "", doc_count: 1, active_count: 1 },
      ],
      listContexts: async () => [{ collection: "cam-other", path: "src/a.ts", context: "Somebody else's." }],
    });
    const hits = await docsApi(runtimeWith(store)).query("anything");
    expect(hits[0]!.note).toBeNull();
  });

  it("round-trips a note and lists only cam's own collections", async () => {
    const store = stubStore({
      listContexts: async () => [
        { collection: "cam-demo", path: "src/a.ts", context: "Mine." },
        { collection: "somebody-elses", path: "x.md", context: "Not mine." },
      ],
    });
    const docs = docsApi(runtimeWith(store));
    expect((await docs.notes()).map((n) => n.note)).toEqual(["Mine."]);
  });
});

describe("collections", () => {
  it("adds with the defaults, and lists only its own", async () => {
    const store = stubStore();
    const docs = docsApi(runtimeWith(store));
    await docs.add("cam-demo", { path: "." });
    await store.addCollection("someone-elses", { path: "/x" });
    const listed = await docs.list();
    expect(listed.map((c) => c.name)).toEqual(["cam-demo"]);
  });

  it("indexing embeds as well, or the collection is grep with extra steps", async () => {
    let embedded = false;
    const store = stubStore({ embed: async () => { embedded = true; } });
    const stat = await docsApi(runtimeWith(store)).index("cam-demo");
    expect(stat).toEqual({ indexed: 2, updated: 1, removed: 0 });
    expect(embedded).toBe(true);
  });

  it("answers nothing rather than searching everything when there are no collections", async () => {
    expect(await docsApi(runtimeWith(stubStore())).query("anything")).toEqual([]);
  });
});

describe("rendering", () => {
  it("puts the note above the snippet, because it is the part a file cannot say", () => {
    const out = formatDocHits(
      [{ collection: "cam-demo", path: "src/a.ts", title: "a", score: 0.91, snippet: "export const a = 1;", note: "The entry point.", docid: null }],
      "entry",
    );
    expect(out.indexOf("note:")).toBeLessThan(out.indexOf("export const a"));
    expect(out).toContain("0.91");
    expect(out).toContain("1 file(s).");
  });

  it("says how to start when there is nothing yet", () => {
    expect(formatDocHits([], "x")).toContain("No files matched");
    expect(formatNotes([])).toContain("cam note add");
  });
});
