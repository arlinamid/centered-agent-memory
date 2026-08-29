import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeCollector } from "../src/collectors/claude-code.js";
import { Hydrator } from "../src/index/hydrate.js";
import { appendRecords, makeHarness, realisticRecords, writeTranscript, type Harness } from "./helpers/fixtures.js";

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

const SLUG = "C--work-demo";
const SID = "11111111-2222-3333-4444-555555555555";
const CWD = "C:\\work\\demo";

const turnsOf = (sid: number) =>
  h.hub.prepare("select * from turns where session_id = ? order by seq").all(sid) as Array<{
    seq: number;
    role: string;
    char_len: number;
    loc_off: number;
    loc_len: number;
    loc_field: string;
    inline_text: string | null;
  }>;

const session = () =>
  h.hub.prepare("select * from sessions").get() as {
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
  };

describe("claude code collector", () => {
  it("indexes only real conversation text", async () => {
    writeTranscript(h.roots, SLUG, SID, realisticRecords(CWD, SID));
    const stat = await claudeCodeCollector.sync(h.ctx);

    expect(stat).toMatchObject({ sessions: 1, errors: 0 });
    const s = session();
    expect(s.ext_id).toBe(SID);
    expect(s.turn_count).toBe(3); // 2 user + 1 assistant; the rest is not conversation

    const rows = turnsOf(s.id);
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant", "user"]);
    // the thinking block's 4 KiB signature never reaches the index
    expect(rows[1]!.char_len).toBeLessThan(100);
    expect(rows[1]!.loc_field).toBe("message.content[*type=text].text");
    expect(rows[0]!.loc_field).toBe("message.content");
  });

  it("stores locators, not copies", async () => {
    writeTranscript(h.roots, SLUG, SID, realisticRecords(CWD, SID));
    await claudeCodeCollector.sync(h.ctx);
    for (const r of turnsOf(session().id)) {
      expect(r.inline_text).toBeNull();
      expect(r.loc_len).toBeGreaterThan(0);
    }
  });

  it("rehydrates every turn back to the exact indexed text", async () => {
    writeTranscript(h.roots, SLUG, SID, realisticRecords(CWD, SID));
    await claudeCodeCollector.sync(h.ctx);

    const hydrator = new Hydrator(h.hub);
    const rows = h.hub.prepare("select * from turns order by seq").all() as never[];
    const resolved = rows.map((r) => hydrator.resolve(r));
    hydrator.close();

    expect(resolved.every((r) => r.status === "ok")).toBe(true);
    expect(resolved[1]!.text).toBe("Az árvíztűrő tükörfúrógép rendben van.");
  });

  it("prefers a user-set title over a generated one", async () => {
    writeTranscript(h.roots, SLUG, SID, realisticRecords(CWD, SID));
    await claudeCodeCollector.sync(h.ctx);
    const s = session();
    expect(s.title).toBe("Kézi cím");
    expect(s.title_origin).toBe("custom-title");
  });

  it("takes the project from the cwd field, never the lossy folder slug", async () => {
    writeTranscript(h.roots, "C--Users-x-Documents-tervek-v-zlatok", SID, [
      {
        type: "user",
        sessionId: SID,
        cwd: "C:\\Users\\x\\Documents\\tervek\\vázlatok",
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { content: "szia" },
      },
    ]);
    await claudeCodeCollector.sync(h.ctx);
    expect(session().cwd_raw).toBe("C:\\Users\\x\\Documents\\tervek\\vázlatok");
    expect(session().cwd_norm).toBe("c:/users/x/documents/tervek/vázlatok");
  });

  it("re-syncs an unchanged store without reading anything", async () => {
    writeTranscript(h.roots, SLUG, SID, realisticRecords(CWD, SID));
    await claudeCodeCollector.sync(h.ctx);
    const second = await claudeCodeCollector.sync(h.ctx);
    expect(second).toMatchObject({ sessions: 0, turns: 0, skipped: 1 });
    expect(session().turn_count).toBe(3);
  });

  it("appends only the new turns when the transcript grows", async () => {
    const file = writeTranscript(h.roots, SLUG, SID, realisticRecords(CWD, SID));
    await claudeCodeCollector.sync(h.ctx);

    // mtime must move for the cheap check to notice
    const later = new Date(Date.now() + 5000);
    appendRecords(file, [
      {
        type: "user",
        sessionId: SID,
        cwd: CWD,
        timestamp: "2026-08-01T11:00:00.000Z",
        message: { content: "Harmadik kérdés." },
      },
    ]);
    fs.utimesSync(file, later, later);

    const stat = await claudeCodeCollector.sync(h.ctx);
    expect(stat.turns).toBe(1);
    const rows = turnsOf(session().id);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
  });

  it("starts over when the transcript is rewritten in place", async () => {
    const file = writeTranscript(h.roots, SLUG, SID, realisticRecords(CWD, SID));
    await claudeCodeCollector.sync(h.ctx);

    writeTranscript(h.roots, SLUG, SID, [
      {
        type: "user",
        sessionId: SID,
        cwd: CWD,
        timestamp: "2026-08-02T09:00:00.000Z",
        message: { content: "Teljesen más tartalom." },
      },
    ]);
    const later = new Date(Date.now() + 9000);
    fs.utimesSync(file, later, later);

    await claudeCodeCollector.sync(h.ctx);
    const rows = turnsOf(session().id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seq).toBe(0);
  });

  it("links subagent transcripts to their parent session", async () => {
    writeTranscript(h.roots, SLUG, SID, realisticRecords(CWD, SID));
    const subDir = path.join(h.roots.claudeProjects, SLUG, SID, "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, "agent-abc.jsonl"),
      JSON.stringify({
        type: "assistant",
        sessionId: "agent-abc",
        cwd: CWD,
        timestamp: "2026-08-01T10:00:30.000Z",
        message: { content: "alügynök válasza" },
      }) + "\n",
      "utf8",
    );

    await claudeCodeCollector.sync(h.ctx);
    const sub = h.hub.prepare("select * from sessions where role = 'subagent'").get() as {
      parent_ext_id: string;
      turn_count: number;
    };
    expect(sub.parent_ext_id).toBe(SID);
    expect(sub.turn_count).toBe(1);
  });

  it("reports a vanished transcript instead of dropping the turn silently", async () => {
    const file = writeTranscript(h.roots, SLUG, SID, realisticRecords(CWD, SID));
    await claudeCodeCollector.sync(h.ctx);
    fs.rmSync(file);

    const hydrator = new Hydrator(h.hub);
    const row = h.hub.prepare("select * from turns order by seq limit 1").get() as never;
    const r = hydrator.resolve(row);
    hydrator.close();

    expect(r.status).toBe("missing");
    expect(r.text).toBeNull();
    const stored = h.hub.prepare("select availability from turns order by seq limit 1").get() as {
      availability: string;
    };
    expect(stored.availability).toBe("missing");
  });

  it("survives a malformed line", async () => {
    const dir = path.join(h.roots.claudeProjects, SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${SID}.jsonl`),
      JSON.stringify({ type: "user", sessionId: SID, cwd: CWD, message: { content: "első" } }) +
        "\n{ nem json\n" +
        JSON.stringify({ type: "user", sessionId: SID, cwd: CWD, message: { content: "második" } }) +
        "\n",
      "utf8",
    );
    const stat = await claudeCodeCollector.sync(h.ctx);
    expect(stat.errors).toBe(0);
    expect(session().turn_count).toBe(2);
  });

  it("builds a searchable contentless index", async () => {
    writeTranscript(h.roots, SLUG, SID, realisticRecords(CWD, SID));
    await claudeCodeCollector.sync(h.ctx);

    const hits = (q: string) =>
      (h.hub.prepare("select count(*) c from chunks_fts where chunks_fts match ?").get(q) as { c: number }).c;
    expect(hits("arvizturo")).toBeGreaterThan(0); // accent-folded
    expect(hits("projekt*")).toBeGreaterThan(0); // prefix, for agglutination
    expect(hits("thinking")).toBe(0); // never indexed
  });
});
