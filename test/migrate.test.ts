import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSchema, openHub, getMeta, type Db } from "../src/db/open.js";
import { migrate } from "../src/db/migrate.js";
import { SCHEMA_VERSION } from "../src/db/schema.js";

/**
 * The upgrade path for a hub created by an earlier version. Conditional DDL
 * brings new tables and indexes along on its own; columns are this module's
 * job, and nothing here may drop data.
 */

let dir: string;
let db: Db;

/**
 * A hub as an earlier version left it: same tables, minus the four columns
 * `migrate()` adds. The index over `artifacts(project_id)` is part of it,
 * because that is what the conditional DDL will try to recreate.
 */
function oldSchema(database: Db): void {
  database.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY, session_id INTEGER, project_id INTEGER,
      kind TEXT NOT NULL, path TEXT NOT NULL, size_bytes INTEGER, mtime_ms INTEGER,
      sha256 TEXT, inline_text TEXT, UNIQUE(kind, path));
    CREATE INDEX idx_artifacts_project ON artifacts(project_id);
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      first_seen_ms INTEGER, last_seen_ms INTEGER);
    CREATE TABLE workspace_roots (root TEXT PRIMARY KEY);
  `);
  database.prepare("insert into artifacts(kind, path, inline_text) values ('scratchpad','d:/tmp/a.md','régi')").run();
  database.prepare("insert into projects(key, display_name) values ('demo','demo')").run();
  database.prepare("insert into workspace_roots(root) values ('c:/work')").run();
}

const columns = (table: string): string[] =>
  (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-migrate-"));
  db = openHub(path.join(dir, "hub.sqlite"));
  oldSchema(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("migrate", () => {
  it("adds the columns an older hub is missing", () => {
    const applied = migrate(db);
    expect(applied.sort()).toEqual(
      ["artifacts.tool", "projects.root_path", "workspace_roots.children", "workspace_roots.kind"].sort(),
    );
    expect(columns("artifacts")).toContain("tool");
    expect(columns("projects")).toContain("root_path");
    expect(columns("workspace_roots")).toEqual(expect.arrayContaining(["children", "kind"]));
  });

  it("keeps every row, with a usable default for the new columns", () => {
    migrate(db);
    const a = db.prepare("select tool, inline_text from artifacts").get() as {
      tool: string | null;
      inline_text: string;
    };
    expect(a).toEqual({ tool: null, inline_text: "régi" });
    const w = db.prepare("select children, kind from workspace_roots").get() as { children: number; kind: string };
    expect(w).toEqual({ children: 0, kind: "learned" });
  });

  it("is safe to run twice", () => {
    migrate(db);
    expect(migrate(db)).toEqual([]);
    expect(getMeta(db, "schema_version")).toBe(String(SCHEMA_VERSION));
  });

  it("runs as part of opening an old hub, before anything reads it", () => {
    // initSchema is the only caller in production: the conditional DDL creates
    // what is missing, migrate() fixes what already exists but is out of date.
    initSchema(db);
    expect(columns("projects")).toContain("root_path");
    expect(() => db.prepare("select root_path from projects").all()).not.toThrow();
    expect(() => db.prepare("select count(*) from chunks_fts").get()).not.toThrow();
    const p = db.prepare("select key, root_path from projects").get() as { key: string; root_path: string | null };
    expect(p).toEqual({ key: "demo", root_path: null });
  });

  it("does not fall over on a table that is not there at all", () => {
    db.exec("drop table artifacts");
    expect(() => migrate(db)).not.toThrow();
  });
});
