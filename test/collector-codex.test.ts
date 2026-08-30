import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexCollector, parseSource, titleFromText } from "../src/collectors/codex.js";
import { Hydrator } from "../src/index/hydrate.js";
import { makeHarness, type Harness } from "./helpers/fixtures.js";
import { writeCodexState, writeRollout } from "./helpers/codex-fixture.js";

let h: Harness;
let rollDir: string;

beforeEach(() => {
  h = makeHarness();
  rollDir = path.join(h.dir, "codex", "sessions", "2026", "08", "01");
});
afterEach(() => h.cleanup());

const CWD = "\\\\?\\C:\\code\\demo";
const MAIN = "019d4cd9-275c-7251-a831-ed4719505b07";
const SUB = "01a04bea-1111-2222-3333-444444444444";

const sessions = () =>
  h.hub.prepare("select * from sessions order by ext_id").all() as Array<{
    id: number;
    ext_id: string;
    title: string | null;
    title_origin: string | null;
    cwd_raw: string | null;
    cwd_norm: string | null;
    role: string;
    parent_ext_id: string | null;
    agent_role: string | null;
    agent_nickname: string | null;
    turn_count: number;
    started_ms: number | null;
  }>;

describe("parseSource", () => {
  it("passes literals through", () => {
    expect(parseSource("exec")).toMatchObject({ kind: "exec", parentId: null });
    expect(parseSource("vscode")).toMatchObject({ kind: "vscode" });
  });

  it("reads a thread_spawn descriptor", () => {
    const raw = JSON.stringify({
      subagent: {
        thread_spawn: { parent_thread_id: MAIN, depth: 1, agent_nickname: "Feynman", agent_role: "worker" },
      },
    });
    expect(parseSource(raw)).toEqual({ kind: "subagent", parentId: MAIN, role: "worker", nickname: "Feynman" });
  });

  it("reads the guardian shape", () => {
    expect(parseSource(JSON.stringify({ subagent: { other: "guardian" } }))).toMatchObject({
      kind: "subagent",
      role: "guardian",
    });
  });

  it("does not throw on malformed JSON", () => {
    expect(parseSource("{broken")).toMatchObject({ kind: "subagent" });
  });
});

describe("titleFromText", () => {
  it("uses the first meaningful line and strips markdown headings", () => {
    expect(titleFromText("# Codex scene — write prose\nYou are a master…")).toBe("Codex scene — write prose");
  });
  it("truncates a long line", () => {
    expect(titleFromText("x".repeat(300))!.length).toBe(118);
  });
});

describe("codex collector", () => {
  it("indexes conversation from the rollout and metadata from the index", async () => {
    const roll = writeRollout(rollDir, "rollout-main.jsonl", {
      id: MAIN,
      cwd: "C:\\code\\demo",
      turns: [
        { role: "user", text: "Nézd meg a codex-runs témagenerálást." },
        { role: "agent", text: "Az árvíztűrő tükörfúrógép rendben." },
      ],
      withResponseItems: true,
    });
    writeCodexState(h.roots, [{ id: MAIN, cwd: CWD, title: "Codex runs cleanup", rolloutPath: roll }]);

    const stat = await codexCollector.sync(h.ctx);
    expect(stat).toMatchObject({ sessions: 1, turns: 2, errors: 0 });

    const s = sessions()[0]!;
    expect(s.title).toBe("Codex runs cleanup");
    expect(s.title_origin).toBe("thread_title");
    // \\?\ prefix normalized away; the clean cwd from session_meta wins
    expect(s.cwd_norm).toBe("c:/code/demo");
    // created_at is stored in SECONDS by Codex
    expect(s.started_ms).toBe(1_773_854_260_000);
  });

  it("ignores response_item, which duplicates the text and adds boilerplate", async () => {
    const roll = writeRollout(rollDir, "rollout-dup.jsonl", {
      id: MAIN,
      cwd: "C:\\code\\demo",
      turns: [{ role: "user", text: "egyetlen kérdés" }],
      withResponseItems: true,
    });
    writeCodexState(h.roots, [{ id: MAIN, cwd: CWD, rolloutPath: roll }]);

    await codexCollector.sync(h.ctx);
    expect(sessions()[0]!.turn_count).toBe(1);
  });

  it("indexes current Codex item_completed UserMessage and AgentMessage records", async () => {
    fs.mkdirSync(rollDir, { recursive: true });
    const roll = path.join(rollDir, "rollout-item-completed.jsonl");

    const records = [
      {
        timestamp: "2026-08-27T05:31:45.406Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          thread_id: MAIN,
          turn_id: "turn-1",
          item: {
            type: "UserMessage",
            id: "user-1",
            content: [
              {
                type: "text",
                text: "szia\n",
                text_elements: [],
              },
            ],
          },
        },
      },
      {
        timestamp: "2026-08-27T05:31:47.931Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          thread_id: MAIN,
          turn_id: "turn-1",
          item: {
            type: "AgentMessage",
            id: "agent-1",
            content: [
              {
                type: "Text",
                text: "Szia! Miben segíthetek?",
              },
            ],
            phase: "final_answer",
          },
        },
      },
      {
        timestamp: "2026-08-27T05:31:48.000Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          thread_id: MAIN,
          turn_id: "turn-1",
          item: {
            type: "Reasoning",
            id: "reasoning-1",
            content: [{ type: "Text", text: "ezt nem szabad indexelni" }],
          },
        },
      },
    ];

    fs.writeFileSync(
      roll,
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf8",
    );

    writeCodexState(h.roots, [{ id: MAIN, cwd: CWD, rolloutPath: roll }]);

    const stat = await codexCollector.sync(h.ctx);
    expect(stat).toMatchObject({ sessions: 1, turns: 2, errors: 0 });

    const rows = h.hub
      .prepare("select * from turns order by seq")
      .all() as Array<{ role: string }>;

    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);

    const hydrator = new Hydrator(h.hub);
    const user = hydrator.resolve(rows[0] as never);
    const assistant = hydrator.resolve(rows[1] as never);
    hydrator.close();

    expect(user).toMatchObject({
      status: "ok",
      text: "szia\n",
    });
    expect(assistant).toMatchObject({
      status: "ok",
      text: "Szia! Miben segíthetek?",
    });
  });

  it("rejects a prompt masquerading as a title and falls back to the first user line", async () => {
    const prompt = "## Context files (in this working directory)\n" + "Read every file listed.\n".repeat(40);
    const roll = writeRollout(rollDir, "rollout-longtitle.jsonl", {
      id: MAIN,
      cwd: "C:\\code\\demo",
      turns: [{ role: "user", text: "Generálj témákat a fejezethez.\nRészletek jönnek." }],
    });
    writeCodexState(h.roots, [{ id: MAIN, cwd: CWD, title: prompt, rolloutPath: roll }]);

    await codexCollector.sync(h.ctx);
    const s = sessions()[0]!;
    expect(s.title).toBe("Generálj témákat a fejezethez.");
    expect(s.title_origin).toBe("first_user_msg");
  });

  it("keeps a subagent separate from its parent", async () => {
    const mainRoll = writeRollout(rollDir, "rollout-main.jsonl", {
      id: MAIN,
      cwd: "C:\\code\\demo",
      turns: [{ role: "user", text: "indíts alügynököt" }],
    });
    // The subagent's session_meta carries the PARENT id in session_id.
    const subRoll = writeRollout(rollDir, "rollout-sub.jsonl", {
      id: SUB,
      sessionId: MAIN,
      parentThreadId: MAIN,
      cwd: "C:\\code\\demo",
      turns: [{ role: "agent", text: "alügynök eredménye" }],
    });
    writeCodexState(
      h.roots,
      [
        { id: MAIN, cwd: CWD, rolloutPath: mainRoll },
        {
          id: SUB,
          cwd: CWD,
          rolloutPath: subRoll,
          source: JSON.stringify({
            subagent: { thread_spawn: { parent_thread_id: MAIN, agent_role: "explorer", agent_nickname: "Gauss" } },
          }),
        },
      ],
      [[MAIN, SUB]],
    );

    await codexCollector.sync(h.ctx);
    const all = sessions();
    expect(all).toHaveLength(2);
    const sub = all.find((s) => s.ext_id === SUB)!;
    expect(sub.role).toBe("subagent");
    expect(sub.parent_ext_id).toBe(MAIN);
    expect(sub.agent_role).toBe("explorer");
    expect(sub.agent_nickname).toBe("Gauss");
    expect(sub.turn_count).toBe(1);
    expect(all.find((s) => s.ext_id === MAIN)!.turn_count).toBe(1);
  });

  it("picks up a parent from thread_spawn_edges when source says nothing", async () => {
    const mainRoll = writeRollout(rollDir, "m.jsonl", { id: MAIN, cwd: "C:\\code\\demo", turns: [] });
    const subRoll = writeRollout(rollDir, "s.jsonl", {
      id: SUB,
      cwd: "C:\\code\\demo",
      turns: [{ role: "agent", text: "gyerek" }],
    });
    writeCodexState(
      h.roots,
      [
        { id: MAIN, cwd: CWD, rolloutPath: mainRoll },
        { id: SUB, cwd: CWD, rolloutPath: subRoll, source: "exec" },
      ],
      [[MAIN, SUB]],
    );

    await codexCollector.sync(h.ctx);
    expect(sessions().find((s) => s.ext_id === SUB)!.parent_ext_id).toBe(MAIN);
  });

  it("re-syncs an unchanged corpus without reading the rollouts", async () => {
    const roll = writeRollout(rollDir, "r.jsonl", {
      id: MAIN,
      cwd: "C:\\code\\demo",
      turns: [{ role: "user", text: "kérdés" }],
    });
    writeCodexState(h.roots, [{ id: MAIN, cwd: CWD, rolloutPath: roll }]);
    await codexCollector.sync(h.ctx);

    const second = await codexCollector.sync(h.ctx);
    expect(second).toMatchObject({ sessions: 0, turns: 0, skipped: 1 });
  });

  it("appends new turns as a rollout grows", async () => {
    const roll = writeRollout(rollDir, "r.jsonl", {
      id: MAIN,
      cwd: "C:\\code\\demo",
      turns: [{ role: "user", text: "első" }],
    });
    writeCodexState(h.roots, [{ id: MAIN, cwd: CWD, rolloutPath: roll }]);
    await codexCollector.sync(h.ctx);

    fs.appendFileSync(
      roll,
      JSON.stringify({
        timestamp: "2026-08-01T07:00:00.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "második" },
      }) + "\n",
      "utf8",
    );
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(roll, later, later);

    const stat = await codexCollector.sync(h.ctx);
    expect(stat.turns).toBe(1);
    expect(sessions()[0]!.turn_count).toBe(2);
  });

  it("keeps the thread in the timeline when its rollout was pruned", async () => {
    writeCodexState(h.roots, [
      { id: MAIN, cwd: CWD, title: "Elveszett szál", rolloutPath: path.join(rollDir, "nincs-ilyen.jsonl") },
    ]);
    const stat = await codexCollector.sync(h.ctx);
    expect(stat.skipped).toBe(1);
    const s = sessions()[0]!;
    expect(s.title).toBe("Elveszett szál");
    expect(s.turn_count).toBe(0);
    const src = h.hub.prepare("select status from sources").get() as { status: string };
    expect(src.status).toBe("missing");
  });

  it("rehydrates a turn from the rollout by byte offset", async () => {
    const roll = writeRollout(rollDir, "r.jsonl", {
      id: MAIN,
      cwd: "C:\\code\\demo",
      turns: [{ role: "user", text: "ékezetes kérdés: őűáé" }],
    });
    writeCodexState(h.roots, [{ id: MAIN, cwd: CWD, rolloutPath: roll }]);
    await codexCollector.sync(h.ctx);

    const hydrator = new Hydrator(h.hub);
    const row = h.hub.prepare("select * from turns limit 1").get() as never;
    const r = hydrator.resolve(row);
    hydrator.close();
    expect(r.status).toBe("ok");
    expect(r.text).toBe("ékezetes kérdés: őűáé");
  });

  it("does nothing when Codex is not installed", async () => {
    const stat = await codexCollector.sync(h.ctx);
    expect(stat).toMatchObject({ sessions: 0, errors: 0 });
  });
});
