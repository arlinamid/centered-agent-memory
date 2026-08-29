import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMeta, initSchema, openHub, sqliteVersion, type Db } from "../src/db/open.js";
import { SCHEMA_VERSION, TOOL_IDS } from "../src/db/schema.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-test-"));
  db = openHub(path.join(dir, "hub.sqlite"));
  initSchema(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("hub database", () => {
  it("runs on an SQLite new enough for contentless FTS5 deletes", () => {
    const [maj, min] = sqliteVersion(db).split(".").map(Number);
    expect(maj! > 3 || (maj === 3 && min! >= 43)).toBe(true);
  });

  it("creates the schema and seeds only the tool list", () => {
    expect(getMeta(db, "schema_version")).toBe(String(SCHEMA_VERSION));
    const tools = db.prepare("select id from tools order by id").all() as Array<{ id: string }>;
    expect(tools.map((t) => t.id).sort()).toEqual([...TOOL_IDS].sort());
    // Nothing user- or machine-specific is baked in.
    expect((db.prepare("select count(*) c from workspace_roots").get() as { c: number }).c).toBe(0);
    expect((db.prepare("select count(*) c from project_aliases").get() as { c: number }).c).toBe(0);
  });

  it("is idempotent", () => {
    expect(() => initSchema(db)).not.toThrow();
  });

  it("stores the FTS index without storing the text", () => {
    db.prepare("insert into projects(key, display_name) values ('p','p')").run();
    db.prepare(
      "insert into sessions(tool, ext_id, project_id) values ('claude_code','s1',(select id from projects))",
    ).run();
    db.prepare(
      `insert into chunks(session_id, seq_start, seq_end, char_len, text_sha256)
       values ((select id from sessions), 0, 3, 42, 'deadbeef')`,
    ).run();
    const chunkId = (db.prepare("select id from chunks").get() as { id: number }).id;
    db.prepare("insert into chunks_fts(rowid, text) values (?, ?)").run(
      chunkId,
      "árvíztűrő tükörfúrógép a projektben",
    );

    // accent-insensitive both ways, and prefix search for agglutinative forms
    const hits = (q: string) =>
      (db.prepare("select count(*) c from chunks_fts where chunks_fts match ?").get(q) as { c: number }).c;
    expect(hits("arvizturo")).toBe(1);
    expect(hits("árvíztűrő")).toBe(1);
    expect(hits("projekt*")).toBe(1);

    // contentless: the text is not retrievable from FTS, which is the point
    const row = db.prepare("select text from chunks_fts where rowid = ?").get(chunkId) as { text: string | null };
    expect(row.text).toBeNull();

    db.prepare("delete from chunks_fts where rowid = ?").run(chunkId);
    expect(hits("arvizturo")).toBe(0);
  });

  it("cascades turns and chunks when a session goes away", () => {
    db.prepare("insert into sessions(tool, ext_id) values ('codex','t1')").run();
    const sid = (db.prepare("select id from sessions").get() as { id: number }).id;
    db.prepare(
      `insert into turns(session_id, seq, role, char_len, text_sha256, locator_kind)
       values (?, 0, 'user', 5, 'h', 'jsonl_line')`,
    ).run(sid);
    db.prepare("delete from sessions where id = ?").run(sid);
    expect((db.prepare("select count(*) c from turns").get() as { c: number }).c).toBe(0);
  });
});
