import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cursorCollector, explainBubbleQuery, keyRange } from "../src/collectors/cursor.js";
import { openSourceReadonly } from "../src/db/open.js";
import { Hydrator } from "../src/index/hydrate.js";
import { extractPaths } from "../src/attribution/evidence.js";
import { makeHarness, type Harness } from "./helpers/fixtures.js";
import { setBubbleText, touchComposer, writeCursorState } from "./helpers/cursor-fixture.js";

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

const CID = "44bc9f74-ca4a-457c-85fb-127c22167e14";

const sessions = () =>
  h.hub.prepare("select * from sessions").all() as Array<{
    id: number;
    ext_id: string;
    title: string | null;
    title_origin: string | null;
    turn_count: number;
    started_ms: number | null;
    ended_ms: number | null;
    cwd_norm: string | null;
  }>;

const evidence = (origin?: string) =>
  (origin
    ? h.hub.prepare("select * from path_evidence where origin = ? order by raw_path").all(origin)
    : h.hub.prepare("select * from path_evidence order by origin, raw_path").all()) as Array<{
    origin: string;
    raw_path: string;
    weight: number;
  }>;

describe("keyRange", () => {
  it("builds a half-open range that ends right after the id", () => {
    expect(keyRange("bubbleId", "abc")).toEqual(["bubbleId:abc:", "bubbleId:abc;"]);
  });
});

describe("extractPaths", () => {
  it("finds Windows paths, escaped paths and file URIs", () => {
    const text = String.raw`{"text":"nézd meg a C:\\code\\notes-app\\backend\\app.py fájlt és a C:/w/x.ts-t"}`;
    const got = extractPaths(text);
    expect(got.some((p) => p.toLowerCase().includes("notes-app"))).toBe(true);
    expect(got.some((p) => p.toLowerCase().includes("c:/w"))).toBe(true);
  });

  it("finds POSIX project paths", () => {
    expect(extractPaths('open "/home/dev/api-gateway/main.go" now').join()).toContain("/home/dev/api-gateway");
    expect(extractPaths("a /mnt/c/work/api/main.go alatt").join()).toContain("/mnt/c/work/api");
    expect(extractPaths("nézd a /opt/tools/cam/src fájlt").join()).toContain("/opt/tools/cam");
  });

  it("finds a POSIX file URI, not only a Windows one", () => {
    // A Cursor store written on Linux never mentions a drive letter; the
    // extractor used to require one, so attribution silently fell back to time.
    expect(extractPaths('{"uri":"file:///home/dev/api-gateway/main.go"}').join()).toContain(
      "/home/dev/api-gateway",
    );
  });

  it("still refuses a path that starts nowhere in particular", () => {
    expect(extractPaths("2/3 arány és /etc/passwd")).toEqual([]);
  });

  it("returns nothing for prose without paths", () => {
    expect(extractPaths("csak sima szöveg, semmi útvonal")).toEqual([]);
  });
});

describe("cursor collector", () => {
  it("reads a conversation in bubble order with the right roles", async () => {
    writeCursorState(h.roots, [
      {
        id: CID,
        name: "Codex runs cleanup",
        bubbles: [
          { id: "b1", type: 1, text: "első kérdés" },
          { id: "b2", type: 2, text: "első válasz" },
          { id: "b3", type: 1, text: "második kérdés" },
        ],
      },
    ]);

    const stat = await cursorCollector.sync(h.ctx);
    expect(stat).toMatchObject({ sessions: 1, turns: 3, errors: 0 });

    const s = sessions()[0]!;
    expect(s.ext_id).toBe(CID);
    expect(s.title).toBe("Codex runs cleanup");
    expect(s.title_origin).toBe("composer_name");
    expect(s.cwd_norm).toBeNull(); // Cursor has no working directory

    const roles = h.hub.prepare("select role from turns order by seq").all() as Array<{ role: string }>;
    expect(roles.map((r) => r.role)).toEqual(["user", "assistant", "user"]);
  });

  it("addresses a turn by its key, because there is no byte offset", async () => {
    writeCursorState(h.roots, [{ id: CID, bubbles: [{ id: "b1", type: 1, text: "szöveg" }] }]);
    await cursorCollector.sync(h.ctx);

    const turn = h.hub.prepare("select * from turns limit 1").get() as {
      locator_kind: string;
      loc_key: string;
      loc_field: string;
      loc_off: number | null;
      inline_text: string | null;
    };
    expect(turn.locator_kind).toBe("sqlite_kv");
    expect(turn.loc_key).toBe(`bubbleId:${CID}:b1`);
    expect(turn.loc_field).toBe("text");
    expect(turn.loc_off).toBeNull();
    expect(turn.inline_text).toBeNull();
  });

  it("rehydrates a turn out of the live store", async () => {
    writeCursorState(h.roots, [{ id: CID, bubbles: [{ id: "b1", type: 1, text: "ékezetes: őűáé" }] }]);
    await cursorCollector.sync(h.ctx);

    const hydrator = new Hydrator(h.hub);
    const row = h.hub.prepare("select * from turns limit 1").get() as never;
    const r = hydrator.resolve(row);
    hydrator.close();
    expect(r).toEqual({ text: "ékezetes: őűáé", status: "ok" });
  });

  it("notices when Cursor rewrites a bubble in place", async () => {
    writeCursorState(h.roots, [{ id: CID, bubbles: [{ id: "b1", type: 1, text: "eredeti" }] }]);
    await cursorCollector.sync(h.ctx);

    setBubbleText(h.roots, CID, "b1", "átírva");
    const hydrator = new Hydrator(h.hub);
    const row = h.hub.prepare("select * from turns limit 1").get() as never;
    const r = hydrator.resolve(row);
    hydrator.close();
    expect(r.status).toBe("stale");
    expect(r.text).toBe("átírva");
  });

  it("takes the project signal from ofsContent KEYS, never the values", async () => {
    writeCursorState(h.roots, [
      {
        id: CID,
        bubbles: [{ id: "b1", type: 1, text: "nézd meg" }],
        openFiles: ["file:///c%3A/code/notes-app/backend/app.py"],
      },
    ]);
    await cursorCollector.sync(h.ctx);

    const ofs = evidence("ofs_key");
    expect(ofs).toHaveLength(1);
    expect(ofs[0]!.raw_path).toBe("file:///c%3A/code/notes-app/backend/app.py");
    expect(ofs[0]!.weight).toBe(2); // stronger than a path mentioned in prose
    // the value is a whole file in the real store and must never be indexed
    const turns = h.hub.prepare("select count(*) c from turns").get() as { c: number };
    expect(turns.c).toBe(1);
  });

  it("collects paths mentioned inside bubbles and request contexts", async () => {
    writeCursorState(h.roots, [
      {
        id: CID,
        bubbles: [{ id: "b1", type: 1, text: "javítsd a C:\\work\\ras\\manifest.json fájlt" }],
        requestContexts: ["a C:\\work\\ras\\src\\index.ts is érintett"],
      },
    ]);
    await cursorCollector.sync(h.ctx);
    const scan = evidence("bubble_scan");
    expect(scan.length).toBeGreaterThanOrEqual(2);
    expect(scan.every((e) => e.weight === 1)).toBe(true);
  });

  it("counts a repeated path once per origin", async () => {
    const p = "C:\\work\\ras\\x.ts";
    writeCursorState(h.roots, [
      {
        id: CID,
        bubbles: [
          { id: "b1", type: 1, text: `${p} ${p} ${p}` },
          { id: "b2", type: 2, text: `megnéztem: ${p}` },
        ],
      },
    ]);
    await cursorCollector.sync(h.ctx);
    expect(evidence("bubble_scan")).toHaveLength(1);
  });

  it("skips a pruned bubble instead of failing", async () => {
    writeCursorState(h.roots, [
      {
        id: CID,
        bubbles: [
          { id: "b1", type: 1, text: "megvan" },
          { id: "b2", type: 2, pruned: true },
          { id: "b3", type: 1, text: "ez is megvan" },
        ],
      },
    ]);
    const stat = await cursorCollector.sync(h.ctx);
    expect(stat.errors).toBe(0);
    expect(sessions()[0]!.turn_count).toBe(2);
  });

  it("ignores tool-only bubbles that carry no text", async () => {
    writeCursorState(h.roots, [
      {
        id: CID,
        bubbles: [
          { id: "b1", type: 1, text: "kérdés" },
          { id: "b2", type: 2, text: "" },
        ],
      },
    ]);
    await cursorCollector.sync(h.ctx);
    expect(sessions()[0]!.turn_count).toBe(1);
  });

  it("skips an unchanged conversation entirely", async () => {
    writeCursorState(h.roots, [{ id: CID, bubbles: [{ id: "b1", type: 1, text: "x" }] }]);
    await cursorCollector.sync(h.ctx);
    const second = await cursorCollector.sync(h.ctx);
    expect(second).toMatchObject({ sessions: 0, turns: 0, skipped: 1 });
  });

  it("re-reads a conversation whole once lastUpdatedAt moves", async () => {
    writeCursorState(h.roots, [
      { id: CID, lastUpdatedAt: 1000, bubbles: [{ id: "b1", type: 1, text: "egy" }] },
    ]);
    await cursorCollector.sync(h.ctx);
    expect(sessions()[0]!.turn_count).toBe(1);

    writeCursorState(h.roots, [
      {
        id: CID,
        lastUpdatedAt: 2000,
        bubbles: [
          { id: "b1", type: 1, text: "egy" },
          { id: "b2", type: 2, text: "kettő" },
        ],
      },
    ]);
    const stat = await cursorCollector.sync(h.ctx);
    expect(stat.sessions).toBe(1);
    expect(sessions()[0]!.turn_count).toBe(2);
    // no duplicated turns after the rewrite
    const seqs = h.hub.prepare("select seq from turns order by seq").all() as Array<{ seq: number }>;
    expect(seqs.map((s) => s.seq)).toEqual([0, 1]);
  });

  it("picks up a touched conversation even when nothing else changed", async () => {
    writeCursorState(h.roots, [
      { id: CID, lastUpdatedAt: 1000, bubbles: [{ id: "b1", type: 1, text: "x" }] },
    ]);
    await cursorCollector.sync(h.ctx);
    touchComposer(h.roots, CID, 5000);
    expect((await cursorCollector.sync(h.ctx)).sessions).toBe(1);
  });

  it("does not leak bubbles from other conversations", async () => {
    writeCursorState(h.roots, [{ id: CID, bubbles: [{ id: "b1", type: 1, text: "enyém" }] }]);
    await cursorCollector.sync(h.ctx);
    expect(sessions()[0]!.turn_count).toBe(1);
  });

  it("does nothing when Cursor is not installed", async () => {
    expect(await cursorCollector.sync(h.ctx)).toMatchObject({ sessions: 0, errors: 0 });
  });

  // The regression that cost the prototype ten minutes per run: SQLite turns
  // LIKE 'prefix%' into a full index scan unless case_sensitive_like is ON.
  it("uses an index SEARCH, never a SCAN", async () => {
    writeCursorState(h.roots, [{ id: CID, bubbles: [{ id: "b1", type: 1, text: "x" }] }]);
    const state = openSourceReadonly(h.roots.cursorStateDb);
    const plan = explainBubbleQuery(state, CID);
    const likePlan = (
      state
        .prepare("explain query plan select key, value from cursorDiskKV where key like ?")
        .all(`bubbleId:${CID}:%`) as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join(" | ");
    state.close();

    expect(plan).toContain("SEARCH");
    expect(plan).not.toContain("SCAN");
    expect(likePlan).toContain("SCAN"); // documents why the range form exists
  });
});
