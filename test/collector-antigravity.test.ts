import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { antigravityCollector, parseDotNetTime } from "../src/collectors/antigravity.js";
import { Hydrator, type TurnRow } from "../src/index/hydrate.js";
import { makeHarness, type Harness } from "./helpers/fixtures.js";
import {
  appendHistory,
  writeBrainDoc,
  writeHistory,
  writeSummaries,
  type Summary,
} from "./helpers/antigravity-fixture.js";

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

const CID = "aaaaaaaa-1111-2222-3333-444444444444";
const OTHER = "cccccccc-1111-2222-3333-666666666666";

const sync = () => antigravityCollector.sync(h.ctx);

const sessions = () =>
  h.hub.prepare("select * from sessions order by ext_id").all() as Array<{
    id: number;
    ext_id: string;
    title: string | null;
    title_origin: string | null;
    cwd_raw: string | null;
    cwd_norm: string | null;
    turn_count: number;
    started_ms: number | null;
    role: string;
    parent_ext_id: string | null;
  }>;

const one = (extId: string) => sessions().find((s) => s.ext_id === extId)!;

const SUMMARY: Summary = {
  conversation_id: CID,
  preview: "Demo eszköz fejlesztése",
  step_count: 110,
  last_modified_time: "2026-07-02 14:39:06.8014141+00:00",
  workspace_uris: JSON.stringify(["file:///D:/work/demo"]),
};

describe("parseDotNetTime", () => {
  it("reads the seven-decimal round-trip form", () => {
    expect(parseDotNetTime("2026-07-02 14:39:06.8014141+00:00")).toBe(Date.parse("2026-07-02T14:39:06.801Z"));
  });

  it("refuses the year-1 sentinel instead of reading it as 2001", () => {
    // Date.parse("0001-01-01 00:00:00+00:00") returns 978307200000 — the year
    // 2001. Stored as a timestamp it would silently misdate the conversation.
    expect(Date.parse("0001-01-01 00:00:00+00:00")).toBeGreaterThan(0);
    expect(parseDotNetTime("0001-01-01 00:00:00+00:00")).toBeNull();
  });

  it("has nothing to say about an empty value", () => {
    expect(parseDotNetTime(null)).toBeNull();
    expect(parseDotNetTime("")).toBeNull();
    expect(parseDotNetTime("not a time")).toBeNull();
  });
});

describe("antigravity collector", () => {
  it("reports nothing at all when Antigravity is not installed", async () => {
    for (const d of [h.roots.antigravityCli, h.roots.antigravityHome, h.roots.antigravityIde]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    expect(await sync()).toEqual({ sessions: 0, turns: 0, skipped: 0, errors: 0 });
  });

  it("records a conversation it cannot read the body of", async () => {
    writeSummaries(h.roots, [SUMMARY]);
    const stat = await sync();
    expect(stat).toMatchObject({ sessions: 1, turns: 0, errors: 0 });

    const s = one(CID);
    // The bodies are encrypted; what we can honestly say is that this
    // conversation happened, when, where, and what it was about.
    expect(s.title).toBe("Demo eszköz fejlesztése");
    expect(s.title_origin).toBe("preview");
    expect(s.turn_count).toBe(0);
    expect(s.started_ms).toBe(Date.parse("2026-07-02T14:39:06.801Z"));
  });

  it("decodes a percent-encoded workspace URI into a project path", async () => {
    writeSummaries(h.roots, [
      { ...SUMMARY, workspace_uris: JSON.stringify(["file:///c%3A/Users/me/Documents/%C3%81rv%C3%ADzt%C5%B1r%C5%91%20mappa"]) },
    ]);
    await sync();
    expect(one(CID).cwd_norm).toBe("c:/users/me/documents/árvíztűrő mappa");
  });

  it("counts the workspace as evidence strong enough to bind a project", async () => {
    writeSummaries(h.roots, [SUMMARY]);
    await sync();
    const evidence = h.hub
      .prepare("select origin, raw_path, weight from path_evidence where session_id = ?")
      .all(one(CID).id) as Array<{ origin: string; raw_path: string; weight: number }>;
    expect(evidence).toEqual([{ origin: "workspace_uris", raw_path: "file:///D:/work/demo", weight: 3 }]);
  });

  it("leaves a conversation with no workspace unattributed", async () => {
    writeSummaries(h.roots, [{ ...SUMMARY, workspace_uris: "" }]);
    await sync();
    expect(one(CID).cwd_norm).toBeNull();
    expect(h.hub.prepare("select count(*) c from path_evidence").get()).toEqual({ c: 0 });
  });

  it("links a nested conversation to its parent", async () => {
    writeSummaries(h.roots, [
      SUMMARY,
      { ...SUMMARY, conversation_id: OTHER, preview: "Alfeladat", parent_conversation_id: CID },
    ]);
    await sync();
    expect(one(OTHER).role).toBe("subagent");
    expect(one(OTHER).parent_ext_id).toBe(CID);
    expect(one(CID).role).toBe("main");
  });

  it("counts one conversation once even when two surfaces hold it", async () => {
    writeSummaries(h.roots, [SUMMARY], "cli");
    writeSummaries(h.roots, [SUMMARY], "ide");
    const stat = await sync();
    expect(stat.sessions).toBe(1);
    expect(sessions()).toHaveLength(1);
  });

  it("indexes the prompts the user typed", async () => {
    writeSummaries(h.roots, [SUMMARY]);
    writeHistory(h.roots, [
      { display: "/exit", timestamp: 1_783_001_340_297, workspace: "C:\\Users\\me", type: "slash_command" },
      { display: "gyökértelen prompt", timestamp: 1_783_002_246_513, workspace: "D:\\work\\demo" },
      { display: "Mi a következő lépés?", timestamp: 1_783_003_128_162, workspace: "D:\\work\\demo", conversationId: CID },
    ]);

    const stat = await sync();
    expect(stat.turns).toBe(1);

    const rows = h.hub.prepare("select * from turns where session_id = ? order by seq").all(one(CID).id) as TurnRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("user");
    expect(rows[0]!.locator_kind).toBe("jsonl_line");
    expect(rows[0]!.loc_field).toBe("display");

    const hy = new Hydrator(h.hub);
    expect(hy.resolve(rows[0]!).text).toBe("Mi a következő lépés?");
    hy.close();
  });

  it("files nothing under a guess when a prompt names no conversation", async () => {
    writeHistory(h.roots, [
      { display: "gyökértelen prompt", timestamp: 1_783_002_246_513, workspace: "D:\\work\\demo" },
    ]);
    const stat = await sync();
    // The line has a workspace but no conversation to attach it to.
    expect(stat.turns).toBe(0);
    expect(sessions()).toHaveLength(0);
    expect(stat.skipped).toBeGreaterThan(0);
  });

  it("keeps the preview as the title rather than the first thing typed", async () => {
    writeSummaries(h.roots, [SUMMARY]);
    writeHistory(h.roots, [
      { display: "Mi a következő lépés?", timestamp: 1_783_003_128_162, workspace: "D:\\work\\demo", conversationId: CID },
    ]);
    await sync();
    expect(one(CID).title).toBe("Demo eszköz fejlesztése");
    expect(one(CID).title_origin).toBe("preview");
  });

  it("titles a conversation from its prompt when no summary knows better", async () => {
    writeHistory(h.roots, [
      { display: "Mi a következő lépés?", timestamp: 1_783_003_128_162, workspace: "D:\\work\\demo", conversationId: CID },
    ]);
    await sync();
    expect(one(CID).title).toBe("Mi a következő lépés?");
    expect(one(CID).title_origin).toBe("first-user-message");
    expect(one(CID).cwd_norm).toBe("d:/work/demo");
  });

  it("continues the numbering when more prompts arrive", async () => {
    const file = writeHistory(h.roots, [
      { display: "Első kérdés", timestamp: 1_783_003_128_162, workspace: "D:\\work\\demo", conversationId: CID },
    ]);
    await sync();

    appendHistory(file, [
      { display: "Második kérdés", timestamp: 1_783_003_228_162, workspace: "D:\\work\\demo", conversationId: CID },
    ]);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));

    expect((await sync()).turns).toBe(1);
    const rows = h.hub.prepare("select seq from turns where session_id = ? order by seq").all(one(CID).id);
    expect(rows).toEqual([{ seq: 0 }, { seq: 1 }]);
  });

  it("keeps the agent's plan documents and nothing else from the brain", async () => {
    writeSummaries(h.roots, [SUMMARY]);
    writeBrainDoc(h.roots, CID, "task.md", "# Task: Enable Session Export\n\nÁrvíztűrő terv.");
    writeBrainDoc(h.roots, CID, "implementation_plan.md", "# Plan\n\n1. Lépés");
    // The same directories hold thousands of screenshots and the `.resolved.N`
    // history of every document.
    writeBrainDoc(h.roots, CID, "task.md.resolved.3", "korábbi változat");
    writeBrainDoc(h.roots, CID, "uploaded_media_1770127282467.png", "\u0089PNG binary");

    await sync();
    const arts = h.hub
      .prepare("select path, session_id, inline_text from artifacts where kind = 'antigravity-brain' order by path")
      .all() as Array<{ path: string; session_id: number | null; inline_text: string | null }>;

    expect(arts.map((a) => path.basename(a.path))).toEqual(["implementation_plan.md", "task.md"]);
    expect(arts.every((a) => a.session_id === one(CID).id)).toBe(true);
    expect(arts[1]!.inline_text).toContain("Árvíztűrő terv.");
  });

  it("skips a brain document that has not changed", async () => {
    writeSummaries(h.roots, [SUMMARY]);
    writeBrainDoc(h.roots, CID, "task.md", "# Task");
    await sync();
    const before = h.hub.prepare("select mtime_ms from artifacts where kind = 'antigravity-brain'").get();
    await sync();
    expect(h.hub.prepare("select mtime_ms from artifacts where kind = 'antigravity-brain'").get()).toEqual(before);
    expect(h.hub.prepare("select count(*) c from artifacts").get()).toEqual({ c: 1 });
  });

  it("skips a conversation that has not moved", async () => {
    writeSummaries(h.roots, [SUMMARY]);
    await sync();
    const stat = await sync();
    expect(stat.sessions).toBe(0);
    expect(stat.skipped).toBeGreaterThan(0);
  });

  it("re-reads a conversation once its step count grows", async () => {
    writeSummaries(h.roots, [SUMMARY]);
    await sync();
    writeSummaries(h.roots, [{ ...SUMMARY, step_count: 120, preview: "Új összefoglaló" }]);
    expect((await sync()).sessions).toBe(1);
    expect(one(CID).title).toBe("Új összefoglaló");
  });

  it("says so out loud when the schema is not the one it knows", async () => {
    const file = path.join(h.roots.antigravityCli, "conversation_summaries.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(file);
    db.exec("create table conversation_summaries (conversation_id text, something_else text)");
    db.close();

    const stat = await sync();
    expect(stat.errors).toBe(1);
    expect(h.logs.join("\n")).toContain("unexpected schema");
  });
});
