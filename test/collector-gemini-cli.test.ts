import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { geminiCliCollector } from "../src/collectors/gemini-cli.js";
import { Hydrator, type TurnRow } from "../src/index/hydrate.js";
import { makeHarness, type Harness } from "./helpers/fixtures.js";
import { realisticChat, writeGeminiChat, writeGeminiProject } from "./helpers/gemini-fixture.js";

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

const PROJECT = "centered-agent-memory";
const ROOT = "D:\\tool\\centered-agent-memory";
const SID = "aaaaaaaa-1111-2222-3333-444444444444";
const FILE = "session-2026-04-02T12-18-aaaaaaaa.json";

const sync = () => geminiCliCollector.sync(h.ctx);

const sessions = () =>
  h.hub.prepare("select * from sessions order by id").all() as Array<{
    id: number;
    ext_id: string;
    title: string | null;
    title_origin: string | null;
    cwd_raw: string | null;
    cwd_norm: string | null;
    turn_count: number;
    started_ms: number | null;
    ended_ms: number | null;
    role: string;
    parent_ext_id: string | null;
  }>;

const turnsOf = (sid: number) =>
  h.hub.prepare("select * from turns where session_id = ? order by seq").all(sid) as TurnRow[];

describe("gemini cli collector", () => {
  it("reports nothing at all when Gemini CLI is not installed", async () => {
    fs.rmSync(h.roots.geminiTmp, { recursive: true, force: true });
    expect(await sync()).toEqual({ sessions: 0, turns: 0, skipped: 0, errors: 0 });
    expect(sessions()).toHaveLength(0);
  });

  it("indexes only what was actually said", async () => {
    writeGeminiProject(h.roots, PROJECT, ROOT);
    writeGeminiChat(h.roots, PROJECT, FILE, realisticChat(SID));

    const stat = await sync();
    expect(stat).toMatchObject({ sessions: 1, turns: 3, errors: 0 });

    const s = sessions()[0]!;
    expect(s.ext_id).toBe(SID);
    expect(s.turn_count).toBe(3);
    expect(s.role).toBe("main");

    const rows = turnsOf(s.id);
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant", "user"]);
    // The `info` notice and the `error` quota message are the CLI talking to
    // itself, and the assistant's `thoughts` are working notes: none is speech.
    const texts = rows.map((r) => new Hydrator(h.hub).resolve(r).text);
    expect(texts[0]).toBe("Az árvíztűrő tükörfúrógép hol akad el?");
    expect(texts[1]).toBe("Megnézem a naplófájlokat és a gyorsítótárat.");
    expect(texts.join("\n")).not.toContain("extensions update");
    expect(texts.join("\n")).not.toContain("exhausted your daily quota");
    expect(texts.join("\n")).not.toContain("CCC");
  });

  it("addresses a turn inside the document, and reads it back", async () => {
    writeGeminiProject(h.roots, PROJECT, ROOT);
    const file = writeGeminiChat(h.roots, PROJECT, FILE, realisticChat(SID));
    await sync();

    const rows = turnsOf(sessions()[0]!.id);
    expect(rows[0]!.locator_kind).toBe("file_range");
    expect(rows[0]!.loc_path).toBe(file);
    expect(rows[0]!.loc_field).toBe("messages[0].content[*].text");
    expect(rows[1]!.loc_field).toBe("messages[2].content");
    // No copy of the text was kept.
    expect(rows.every((r) => r.inline_text === null)).toBe(true);

    const hy = new Hydrator(h.hub);
    for (const r of rows) expect(hy.resolve(r).status).toBe("ok");
    hy.close();
  });

  it("takes the working directory from .project_root, and nowhere else", async () => {
    writeGeminiProject(h.roots, PROJECT, ROOT);
    writeGeminiChat(h.roots, PROJECT, FILE, realisticChat(SID));
    await sync();

    const s = sessions()[0]!;
    expect(s.cwd_raw).toBe(ROOT);
    expect(s.cwd_norm).toBe("d:/tool/centered-agent-memory");

    const evidence = h.hub
      .prepare("select origin, raw_path, weight from path_evidence where session_id = ?")
      .all(s.id) as Array<{ origin: string; raw_path: string; weight: number }>;
    expect(evidence).toEqual([{ origin: "cwd", raw_path: ROOT, weight: 3 }]);
  });

  it("leaves a hash-named project unattributed rather than guessing", async () => {
    // These directories carry no .project_root, and `projectHash` is not the
    // SHA-256 of the working directory, so there is nothing to resolve.
    const hashed = "0000000000000000000000000000000000000000000000000000000000000000";
    writeGeminiProject(h.roots, hashed, null);
    writeGeminiChat(h.roots, hashed, FILE, realisticChat(SID));

    expect(await sync()).toMatchObject({ sessions: 1, errors: 0 });
    const s = sessions()[0]!;
    expect(s.cwd_raw).toBeNull();
    expect(s.cwd_norm).toBeNull();
    expect(h.hub.prepare("select count(*) c from path_evidence").get()).toEqual({ c: 0 });
  });

  it("titles a session from its first user message", async () => {
    writeGeminiProject(h.roots, PROJECT, ROOT);
    writeGeminiChat(h.roots, PROJECT, FILE, realisticChat(SID));
    await sync();
    const s = sessions()[0]!;
    expect(s.title).toBe("Az árvíztűrő tükörfúrógép hol akad el?");
    expect(s.title_origin).toBe("first-user-message");
    expect(s.started_ms).toBe(Date.parse("2026-04-02T12:18:00.000Z"));
    expect(s.ended_ms).toBe(Date.parse("2026-04-02T12:20:00.000Z"));
  });

  it("records that a session is a subagent without inventing its parent", async () => {
    writeGeminiProject(h.roots, PROJECT, ROOT);
    writeGeminiChat(h.roots, PROJECT, FILE, { ...realisticChat(SID), kind: "subagent" });
    await sync();
    const s = sessions()[0]!;
    expect(s.role).toBe("subagent");
    expect(s.parent_ext_id).toBeNull();
  });

  it("skips a chat that has not changed", async () => {
    writeGeminiProject(h.roots, PROJECT, ROOT);
    writeGeminiChat(h.roots, PROJECT, FILE, realisticChat(SID));
    await sync();
    expect(await sync()).toEqual({ sessions: 0, turns: 0, skipped: 1, errors: 0 });
  });

  it("re-reads the whole document when it grows, without doubling the turns", async () => {
    writeGeminiProject(h.roots, PROJECT, ROOT);
    const file = writeGeminiChat(h.roots, PROJECT, FILE, realisticChat(SID));
    await sync();

    const grown = realisticChat(SID);
    grown.lastUpdated = "2026-04-02T12:25:00.000Z";
    grown.messages.push({
      id: "m5",
      timestamp: "2026-04-02T12:24:00.000Z",
      type: "gemini",
      content: "A gyorsítótár volt a bűnös.",
    });
    fs.writeFileSync(file, JSON.stringify(grown, null, 2), "utf8");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));

    const stat = await sync();
    expect(stat).toMatchObject({ sessions: 1, turns: 4, errors: 0 });

    const s = sessions()[0]!;
    expect(sessions()).toHaveLength(1);
    expect(s.turn_count).toBe(4);
    const rows = turnsOf(s.id);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    const hy = new Hydrator(h.hub);
    expect(hy.resolve(rows[3]!).text).toBe("A gyorsítótár volt a bűnös.");
    hy.close();
  });

  it("counts a malformed document instead of swallowing it", async () => {
    writeGeminiProject(h.roots, PROJECT, ROOT);
    const file = path.join(h.roots.geminiTmp, PROJECT, "chats", FILE);
    fs.writeFileSync(file, "{ this is not json", "utf8");

    const stat = await sync();
    expect(stat.errors).toBe(1);
    expect(stat.sessions).toBe(0);
    expect(h.logs.join("\n")).toContain("malformed JSON");
  });

  it("ignores a directory that holds no chats", async () => {
    fs.mkdirSync(path.join(h.roots.geminiTmp, "background-processes"), { recursive: true });
    fs.mkdirSync(path.join(h.roots.geminiTmp, "bin"), { recursive: true });
    expect(await sync()).toEqual({ sessions: 0, turns: 0, skipped: 0, errors: 0 });
  });
});
