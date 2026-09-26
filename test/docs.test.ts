import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_PATTERN,
  DocsError,
  fingerprint,
  collectionName,
  docsDbPath,
  openDocs,
  planKnown,
  rememberKey,
  scanFolder,
  type DocsIndex,
} from "../src/docs/files.js";
import { EXIT_FAILED, EXIT_OK, run } from "../src/cli.js";
import { createServer } from "../src/mcp/server.js";
import { initSchema, openHub } from "../src/db/open.js";

/**
 * Project file search runs against the real qmd: it is keyword-only, so there
 * is no model to fake, and indexing a handful of files takes milliseconds.
 */

let dir: string;
let project: string;
let dbPath: string;
let docs: DocsIndex | null;

function write(rel: string, text: string): void {
  const file = path.join(project, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-docs-"));
  project = path.join(dir, "demo-app");
  dbPath = path.join(dir, "docs.sqlite");
  docs = null;
  write("src/billing/invoice.ts", "export function computeInvoiceTotal(lines: number[]) {\n  return lines.reduce((a, b) => a + b, 0);\n}\n");
  write("src/billing/invoice.test.ts", "import { computeInvoiceTotal } from './invoice';\n// rounding regression for the invoice total\n");
  write("src/doc/readme.md", "# Doc helpers\n\nNothing about billing here.\n");
  write("src/docs/guide.md", "# Guide\n\nThe quarterly reconciliation runs every Monday.\n");
  write("node_modules/dep/index.js", "export const computeInvoiceTotal = 'vendored copy';\n");
  write("dist/billing/invoice.js", "function computeInvoiceTotal(){}\n");
});

afterEach(async () => {
  await docs?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function indexed(): Promise<DocsIndex> {
  docs = (await openDocs(dbPath, { create: true }))!;
  await docs.add(project);
  await docs.refresh();
  return docs;
}

describe("project file index", () => {
  it("does not exist, and does not load qmd, until something is added", async () => {
    expect(await openDocs(dbPath)).toBeNull();
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("lives next to the hub unless the config moves it", () => {
    expect(docsDbPath(path.join(dir, "hub.sqlite"))).toBe(path.join(dir, "docs.sqlite"));
    expect(docsDbPath(path.join(dir, "hub.sqlite"), { dbPath: path.join(dir, "x", "files.sqlite") })).toBe(
      path.join(dir, "x", "files.sqlite"),
    );
  });

  it("names a collection after the project folder", () => {
    expect(collectionName("Demo App!")).toBe("demo-app");
    expect(collectionName("___")).toBe("___");
    expect(collectionName("!!!")).toBe("project");
  });

  it("indexes the project's own code and prose, not vendored or built files", async () => {
    const d = await indexed();
    const [c] = await d.list();
    expect(c!.name).toBe("demo-app");
    expect(c!.files).toBe(4);
    const hits = await d.search("computeInvoiceTotal");
    expect(hits.map((h) => h.path).sort()).toEqual(["src/billing/invoice.test.ts", "src/billing/invoice.ts"]);
  });

  it("reports a hit by its name on disk, with an absolute file, a line and a snippet", async () => {
    const d = await indexed();
    const [hit] = await d.search("rounding regression");
    expect(hit!.path).toBe("src/billing/invoice.test.ts");
    expect(path.normalize(hit!.file).toLowerCase()).toBe(path.join(project, "src", "billing", "invoice.test.ts").toLowerCase());
    expect(hit!.line).toBeGreaterThan(0);
    expect(hit!.snippet).toContain("rounding regression");
    expect(hit!.snippet).not.toMatch(/^@@/);
  });

  it("carries every note on the path, the folder's before the file's", async () => {
    const d = await indexed();
    await d.note(path.join(project, "src", "billing"), "Money: every change needs a second reviewer.");
    await d.note(path.join(project, "src", "billing", "invoice.ts"), "The single source of invoice totals.");
    const [hit] = await d.search("reduce", { limit: 1 });
    expect(hit!.path).toBe("src/billing/invoice.ts");
    expect(hit!.note).toBe("Money: every change needs a second reviewer.\n\nThe single source of invoice totals.");
  });

  it("keeps a folder's note inside that folder", async () => {
    const d = await indexed();
    await d.note(path.join(project, "src", "doc"), "Small helpers.");
    const [guide] = await d.search("quarterly reconciliation");
    expect(guide!.path).toBe("src/docs/guide.md");
    expect(guide!.note).toBeNull();
  });

  it("lists and removes notes by the path the user wrote", async () => {
    const d = await indexed();
    await d.note(path.join(project, "src", "billing"), "Money.");
    await d.note("demo-app/src/billing/invoice.test.ts", "Regression tests.");
    expect(await d.notes()).toEqual([
      { collection: "demo-app", path: "src/billing/", note: "Money." },
      { collection: "demo-app", path: "src/billing/invoice.test.ts", note: "Regression tests." },
    ]);
    expect(await d.unnote(path.join(project, "src", "billing"))).toBe(true);
    expect(await d.unnote(path.join(project, "src", "billing"))).toBe(false);
    expect((await d.notes()).map((n) => n.path)).toEqual(["src/billing/invoice.test.ts"]);
  });

  it("reads a file by collection path, absolute path or docid", async () => {
    const d = await indexed();
    const byName = await d.read("demo-app/src/billing/invoice.test.ts");
    expect(byName!.text).toContain("rounding regression");
    const byPath = await d.read(path.join(project, "src", "docs", "guide.md"));
    expect(byPath!.path).toBe("src/docs/guide.md");
    const [hit] = await d.search("quarterly");
    const byId = await d.read(`#${hit!.docid}`);
    expect(byId!.path).toBe("src/docs/guide.md");
    expect(await d.read("demo-app/src/nope.ts")).toBeNull();
  });

  it("picks up changed and deleted files on refresh", async () => {
    const d = await indexed();
    write("src/docs/guide.md", "# Guide\n\nReconciliation moved to Fridays.\n");
    fs.rmSync(path.join(project, "src", "doc", "readme.md"));
    const r = await d.refresh();
    expect(r).toMatchObject({ updated: 1, removed: 1 });
    expect(await d.search("Monday")).toEqual([]);
    expect((await d.search("Fridays"))[0]!.path).toBe("src/docs/guide.md");
  });

  it("asks which collection when a relative path could belong to several", async () => {
    const d = await indexed();
    const other = path.join(dir, "other");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "a.md"), "other project\n");
    await d.add(other);
    await expect(d.note("missing/file.ts", "x")).rejects.toBeInstanceOf(DocsError);
    await expect(d.note("missing/file.ts", "x", { collection: "other" })).resolves.toMatchObject({ collection: "other" });
    await expect(d.search("x", { collection: "nope" })).rejects.toThrow(/No such collection: nope/);
  });
});

describe("ignore files", () => {
  it("leaves out what .gitignore, nested .gitignore and .vercelignore exclude", async () => {
    // Anchored: only the root one. Unanchored, git would drop other/ too.
    write(".gitignore", "*.log\ngenerated/\n/secrets.json\n");
    write(".vercelignore", "fixtures/\n");
    write("src/.gitignore", "*.snap.ts\n!keep.snap.ts\n");
    write("app.log", "computeInvoiceTotal in a log\n");
    write("generated/api.ts", "export const computeInvoiceTotal = 1;\n");
    write("secrets.json", '{"computeInvoiceTotal": "key"}\n');
    write("fixtures/big.json", '{"computeInvoiceTotal": 1}\n');
    write("src/billing/total.snap.ts", "computeInvoiceTotal snapshot\n");
    write("src/billing/keep.snap.ts", "computeInvoiceTotal kept snapshot\n");
    write("other/secrets.json", '{"computeInvoiceTotal": "not the root one"}\n');

    const scan = await scanFolder(project);
    expect(scan.ignored).toEqual(
      expect.arrayContaining(["app.log", "generated/**", "secrets.json", "fixtures/**", "src/billing/total.snap.ts"]),
    );
    expect(scan.ignored).not.toContain("src/billing/keep.snap.ts");

    const d = await indexed();
    const paths = (await d.search("computeInvoiceTotal", { limit: 20 })).map((h) => h.path).sort();
    expect(paths).toEqual([
      "other/secrets.json",
      "src/billing/invoice.test.ts",
      "src/billing/invoice.ts",
      "src/billing/keep.snap.ts",
    ]);
  });

  it("applies a new ignore rule on the next refresh, and keeps the notes", async () => {
    const d = await indexed();
    await d.note(path.join(project, "src", "docs"), "Written by hand.");
    write(".gitignore", "src/doc/\n");
    const r = await d.refresh();
    expect(r.removed).toBe(1);
    expect(await d.search("helpers")).toEqual([]);
    // qmd's upsert replaces the whole collection row; the notes must survive it.
    expect((await d.notes()).map((n) => n.note)).toEqual(["Written by hand."]);
    await d.add(project);
    expect((await d.notes()).map((n) => n.note)).toEqual(["Written by hand."]);
  });
});

describe("change detection", () => {
  const hasGit = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const sh = (...args: string[]): void =>
    void execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: project,
      stdio: "ignore",
    });
  /** mtime is what the fingerprint reads; a rewrite within the same millisecond would not show. */
  const touchLater = (rel: string, text: string): void => {
    write(rel, text);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(project, ...rel.split("/")), later, later);
  };

  it("does not read an unchanged folder again, and notices an edit (no git)", async () => {
    const d = await indexed();
    expect((await d.refresh()).checked).toBe(0);
    touchLater("src/docs/guide.md", "# Guide\n\nNow on Tuesdays.\n");
    const r = await d.refresh();
    expect(r).toMatchObject({ checked: 1, updated: 1 });
    expect((await d.search("Tuesdays"))[0]!.path).toBe("src/docs/guide.md");
    expect((await fingerprint(project, DEFAULT_PATTERN, DEFAULT_MAX_FILE_BYTES)).method).toBe("walk");
    expect((await d.refresh(undefined, { force: true })).checked).toBe(1);
  });

  it.skipIf(!hasGit)("asks git in a repository: commits, repeated edits, new files, not ignored ones", async () => {
    write(".gitignore", "scratch/\n");
    sh("init", "-q");
    sh("add", "-A");
    sh("commit", "-q", "-m", "init");
    const d = await indexed();
    expect((await fingerprint(project, DEFAULT_PATTERN, DEFAULT_MAX_FILE_BYTES)).method).toBe("git");
    expect((await d.refresh()).checked).toBe(0);

    // Dirty, and dirty again: the status line is the same both times.
    touchLater("src/docs/guide.md", "# Guide\n\nFirst edit.\n");
    expect((await d.refresh()).checked).toBe(1);
    touchLater("src/docs/guide.md", "# Guide\n\nSecond edit, same status line.\n");
    expect((await d.refresh()).checked).toBe(1);
    expect((await d.search("status line"))[0]!.path).toBe("src/docs/guide.md");

    // Committed: the working tree is clean again, but HEAD moved.
    sh("commit", "-q", "-am", "edit");
    expect((await d.refresh()).checked).toBe(1);
    expect((await d.refresh()).checked).toBe(0);

    write("src/new-module.ts", "export const freshlyAddedHelper = 1;\n");
    expect((await d.refresh()).checked).toBe(1);
    expect((await d.search("freshlyAddedHelper"))[0]!.path).toBe("src/new-module.ts");

    // Ignored by git: nothing qmd would read has changed.
    write("scratch/tmp.md", "noise\n");
    expect((await d.refresh()).checked).toBe(0);
  });

  it("leaves out files past the size limit", async () => {
    write("src/bundle.html", `<p>${"computeInvoiceTotal ".repeat(60_000)}</p>`);
    const scan = await scanFolder(project);
    expect(scan.tooLarge).toBe(1);
    expect(scan.ignored).toContain("src/bundle.html");
    const d = await indexed();
    expect((await d.search("computeInvoiceTotal", { limit: 20 })).map((h) => h.path)).not.toContain("src/bundle.html");
  });

  it("gives the space of removed files back", async () => {
    const d = await indexed();
    fs.rmSync(path.join(project, "src", "billing"), { recursive: true });
    expect((await d.refresh()).removed).toBe(2);
    const c = await d.compact();
    expect(c.after).toBeGreaterThan(0);
    expect(await d.search("computeInvoiceTotal")).toEqual([]);
  });
});

describe("known projects", () => {
  const NOW = Date.UTC(2026, 8, 26);
  const recent = NOW - 24 * 60 * 60 * 1000;
  const opts = { sinceDays: 90, maxFiles: 50 };

  function folder(rel: string, files: Record<string, string> = { "index.ts": "export {};\n" }): string {
    const root = path.join(dir, "work", ...rel.split("/"));
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), text);
    }
    return root;
  }

  it("keeps a project whole, indexes a shelf's projects one by one, and says why for the rest", async () => {
    const mono = folder("mono", { "package.json": "{}", "index.ts": "x" });
    const pkg = folder("mono/packages/game");
    const shelf = folder("shelf", { "notes.md": "x" });
    const a = folder("shelf/a");
    const b = folder("shelf/b");
    const old = folder("old");
    const hidden = folder("mono/.cache-runs/t1");
    const big = folder("big", Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}.ts`, "x"])));
    const empty = folder("empty", { "photo.png": "x" });
    const removed = folder("removed");

    const plan = await planKnown(
      [
        { key: "game", root: pkg, lastMs: recent },
        { key: "mono", root: mono, lastMs: recent },
        { key: "shelf", root: shelf, lastMs: recent },
        { key: "a", root: a, lastMs: recent },
        { key: "b", root: b, lastMs: recent },
        { key: "old", root: old, lastMs: NOW - 200 * 24 * 60 * 60 * 1000 },
        { key: "t1", root: hidden, lastMs: recent },
        { key: "big", root: big, lastMs: recent },
        { key: "empty", root: empty, lastMs: recent },
        { key: "gone", root: path.join(dir, "nowhere"), lastMs: recent },
        { key: "removed", root: removed, lastMs: recent },
        { key: "nofolder", root: null, lastMs: recent },
      ],
      [],
      { [rememberKey(removed)]: "removed by the user" },
      opts,
      NOW,
    );

    expect(plan.add.map((x) => x.name).sort()).toEqual(["a", "b", "mono"]);
    const why = Object.fromEntries(plan.skip.map((x) => [x.key, x.reason]));
    expect(why).toEqual({
      game: "inside mono",
      shelf: "a folder of 2 project(s), indexed one by one",
      old: "no session in 90 days",
      t1: "inside a hidden folder",
      big: "more than 50 files",
      empty: "no text files",
      gone: "folder is gone",
      removed: "removed by the user",
      nofolder: "no folder known",
    });
    expect(plan.remember).toEqual({ [rememberKey(big)]: "more than 50 files" });
  });

  it("does not add a folder twice, and names around a clash", async () => {
    const one = folder("x/app");
    const two = folder("y/app");
    const plan = await planKnown(
      [
        { key: "app", root: one, lastMs: recent },
        { key: "app", root: two, lastMs: recent },
      ],
      [{ name: "app", root: one, pattern: "", files: 1 }],
      {},
      opts,
      NOW,
    );
    expect(plan.add).toEqual([{ name: "app-2", root: two, files: 1 }]);
  });
});

describe("cam docs / cam note", () => {
  const envBefore = { db: process.env.CAM_DB, config: process.env.CAM_CONFIG };
  let out: string[];
  let err: string[];

  beforeEach(() => {
    process.env.CAM_DB = path.join(dir, "hub.sqlite");
    process.env.CAM_CONFIG = path.join(dir, "config.json");
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => out.push(a.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => err.push(a.map(String).join(" ")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of [["CAM_DB", envBefore.db], ["CAM_CONFIG", envBefore.config]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("adds, indexes, annotates and searches in one flow", async () => {
    expect(await run(["docs", "add", project, "--project", "Billing"])).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("4 file(s) indexed");
    expect(await run(["note", "add", path.join(project, "src", "billing", "invoice.ts"), "Totals live here."])).toBe(EXIT_OK);
    out = [];
    expect(await run(["docs", "query", "computeInvoiceTotal", "--limit", "5"])).toBe(EXIT_OK);
    const text = out.join("\n");
    expect(text).toContain("billing/src/billing/invoice.ts:");
    expect(text).toContain("note: Totals live here.");
    out = [];
    expect(await run(["docs", "get", "billing/src/docs/guide.md"])).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("quarterly reconciliation");
  });

  it("fails with a message, not a stack, on a path outside every collection", async () => {
    expect(await run(["docs", "add", project])).toBe(EXIT_OK);
    const outside = path.join(dir, "elsewhere.md");
    fs.writeFileSync(outside, "x");
    expect(await run(["note", "add", outside, "nope"])).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain("is not inside any collection");
    expect(err.join("\n")).not.toContain("    at ");
  });

  it("is refreshed by a full sync", async () => {
    expect(await run(["docs", "add", project])).toBe(EXIT_OK);
    write("src/docs/new.md", "freshly written onboarding page\n");
    process.env.CAM_HOME = path.join(dir, "home");
    try {
      await run(["sync"]);
    } finally {
      delete process.env.CAM_HOME;
    }
    expect(out.join("\n")).toMatch(/project files .*new:1/);
    out = [];
    expect(await run(["docs", "query", "onboarding"])).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("src/docs/new.md");
  });

  /** A project the hub knows, with a session today in its folder. */
  function knownProject(key: string, root: string): void {
    const hub = openHub(process.env.CAM_DB!);
    try {
      initSchema(hub);
      const norm = root.split(path.sep).join("/").toLowerCase();
      hub.prepare("insert into projects(key, display_name, root_path) values (?, ?, ?)").run(key, key, norm);
      hub
        .prepare(
          "insert into sessions(tool, ext_id, cwd_norm, started_ms, ended_ms, project_id) values ('codex', ?, ?, ?, ?, (select id from projects where key = ?))",
        )
        .run(`s-${key}`, norm, Date.now() - 1000, Date.now(), key);
    } finally {
      hub.close();
    }
  }

  it("adds the known projects, and a removed one stays removed", async () => {
    knownProject("demo-app", project);
    expect(await run(["docs", "add", "--known", "--dry-run"])).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("would add  demo-app");
    expect(fs.existsSync(path.join(dir, "docs.sqlite"))).toBe(false);

    out = [];
    expect(await run(["docs", "add", "--known"])).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("added      demo-app");
    out = [];
    expect(await run(["docs", "query", "quarterly"])).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("demo-app/src/docs/guide.md");

    expect(await run(["docs", "remove", "demo-app"])).toBe(EXIT_OK);
    err = [];
    expect(await run(["docs", "add", "--known"])).toBe(EXIT_OK);
    expect(err.join("\n") + out.join("\n")).toContain("removed by the user");
    out = [];
    expect(await run(["docs", "list"])).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("No file collections");

    // By hand it comes back, and the verdict is forgotten.
    expect(await run(["docs", "add", project])).toBe(EXIT_OK);
    expect(await run(["docs", "remove", "demo-app"])).toBe(EXIT_OK);
  });

  it("adds known projects during sync when autoAdd is on", async () => {
    fs.writeFileSync(process.env.CAM_CONFIG!, JSON.stringify({ docs: { autoAdd: true } }));
    knownProject("demo-app", project);
    // Sync re-attributes from scratch; a manual attribution is the one it keeps.
    expect(await run(["attribute", "codex:s-demo-app", "demo-app"])).toBe(EXIT_OK);
    out = [];
    process.env.CAM_HOME = path.join(dir, "home");
    try {
      await run(["sync"]);
    } finally {
      delete process.env.CAM_HOME;
    }
    expect(out.join("\n")).toMatch(/project files .*\(\+1\)/);
    out = [];
    expect(await run(["docs", "list"])).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("demo-app");
  });

  it("can be switched off in the config", async () => {
    fs.writeFileSync(process.env.CAM_CONFIG!, JSON.stringify({ docs: { enabled: false } }));
    expect(await run(["docs", "add", project])).toBe(EXIT_FAILED);
    expect(fs.existsSync(path.join(dir, "docs.sqlite"))).toBe(false);
  });
});

describe("cam_docs", () => {
  async function call(args: Record<string, unknown>, docsPath: string | null): Promise<{ text: string; isError: boolean }> {
    const hub = openHub(path.join(dir, "hub.sqlite"));
    initSchema(hub);
    const server = createServer(hub, { docsDbPath: docsPath });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      const res = await client.callTool({ name: "cam_docs", arguments: args });
      const blocks = (res.content ?? []) as Array<{ text?: string }>;
      return { text: blocks.map((x) => x.text ?? "").join("\n"), isError: Boolean(res.isError) };
    } finally {
      await client.close();
      await server.close();
      hub.close();
    }
  }

  it("says plainly that nothing is indexed, without an error", async () => {
    const res = await call({ query: "anything" }, dbPath);
    expect(res.isError).toBe(false);
    expect(res.text).toContain("No project files are indexed");
  });

  it("searches, reads and lists notes", async () => {
    const d = await indexed();
    await d.note(path.join(project, "src", "billing"), "Money.");
    await d.close();
    docs = null;

    const hits = await call({ query: "computeInvoiceTotal" }, dbPath);
    expect(hits.isError).toBe(false);
    expect(hits.text).toContain("demo-app/src/billing/invoice.ts");
    expect(hits.text).toContain("note: Money.");

    const file = await call({ action: "get", path: "demo-app/src/docs/guide.md" }, dbPath);
    expect(file.text).toContain("quarterly reconciliation");

    expect((await call({ action: "notes" }, dbPath)).text).toContain("demo-app/src/billing/");
    expect((await call({ action: "get" }, dbPath)).isError).toBe(true);
  });
});
