import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cursorHistoryCollector } from "../src/collectors/cursor-history.js";
import { makeHarness, type Harness } from "./helpers/fixtures.js";

/**
 * Cursor's local file history is the only input the time correlation has, and
 * the collector replaces the whole `file_events` table on every run. Both facts
 * make it worth testing: a bad run leaves the attribution cascade with nothing.
 */

let h: Harness;

const NOW = 1_700_000_000_000;

beforeEach(() => {
  h = makeHarness(() => NOW);
});

afterEach(() => {
  h.cleanup();
});

/** One `User/History/<hash>/entries.json`, the shape Cursor writes. */
function historyDir(name: string, resource: string | null, timestamps: unknown[]): void {
  const dir = path.join(h.roots.cursorHistory, name);
  fs.mkdirSync(dir, { recursive: true });
  const body: Record<string, unknown> = { entries: timestamps.map((t) => ({ id: "x", timestamp: t })) };
  if (resource !== null) body.resource = resource;
  fs.writeFileSync(path.join(dir, "entries.json"), JSON.stringify(body), "utf8");
}

const events = (): Array<{ resource: string; ts_ms: number }> =>
  h.hub.prepare("select resource, ts_ms from file_events order by ts_ms").all() as Array<{
    resource: string;
    ts_ms: number;
  }>;

describe("cursor history collector", () => {
  it("does nothing when Cursor is not installed", async () => {
    fs.rmSync(h.roots.cursorHistory, { recursive: true, force: true });
    const stat = await cursorHistoryCollector.sync(h.ctx);
    expect(stat.errors).toBe(0);
    expect(events()).toEqual([]);
  });

  it("records one event per entry, with the path normalized", async () => {
    historyDir("aaa", "file:///c%3A/work/demo/src/index.ts", [NOW - 1000, NOW - 500]);
    await cursorHistoryCollector.sync(h.ctx);
    const rows = events();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.resource).toBe("c:/work/demo/src/index.ts");
  });

  it("skips a directory with no resource, a broken file, or no entries.json", async () => {
    historyDir("ok", "c:/work/demo/a.ts", [NOW]);
    historyDir("no-resource", null, [NOW]);
    fs.mkdirSync(path.join(h.roots.cursorHistory, "empty"), { recursive: true });
    fs.mkdirSync(path.join(h.roots.cursorHistory, "torn"), { recursive: true });
    fs.writeFileSync(path.join(h.roots.cursorHistory, "torn", "entries.json"), '{"resource": "d:/x', "utf8");

    const stat = await cursorHistoryCollector.sync(h.ctx);
    expect(stat.errors).toBe(0);
    expect(events()).toHaveLength(1);
  });

  it("ignores an entry whose timestamp is not a number", async () => {
    historyDir("aaa", "c:/work/demo/a.ts", [NOW, "tegnap", null]);
    await cursorHistoryCollector.sync(h.ctx);
    expect(events()).toHaveLength(1);
  });

  it("ignores a resource that is not a local path", async () => {
    historyDir("aaa", "untitled:Untitled-1", [NOW]);
    historyDir("bbb", "https://example.com/x.ts", [NOW]);
    await cursorHistoryCollector.sync(h.ctx);
    expect(events()).toEqual([]);
  });

  it("replaces the table rather than appending to it", async () => {
    historyDir("aaa", "c:/work/demo/a.ts", [NOW - 1000]);
    await cursorHistoryCollector.sync(h.ctx);
    await cursorHistoryCollector.sync({ ...h.ctx, repair: true });
    expect(events()).toHaveLength(1);
  });

  it("skips the rebuild when the directory count has not moved today", async () => {
    historyDir("aaa", "c:/work/demo/a.ts", [NOW - 1000]);
    await cursorHistoryCollector.sync(h.ctx);

    // Same run count, same clock: nothing to do, and the table is left alone.
    const stat = await cursorHistoryCollector.sync(h.ctx);
    expect(stat.skipped).toBe(1);
    expect(events()).toHaveLength(1);
  });

  it("rebuilds when a new history directory appears", async () => {
    historyDir("aaa", "c:/work/demo/a.ts", [NOW - 1000]);
    await cursorHistoryCollector.sync(h.ctx);
    historyDir("bbb", "c:/work/masik/b.ts", [NOW - 900]);
    const stat = await cursorHistoryCollector.sync(h.ctx);
    expect(stat.skipped).toBe(0);
    expect(events()).toHaveLength(2);
  });

  it("rebuilds once a day even when the directory count is unchanged", async () => {
    historyDir("aaa", "c:/work/demo/a.ts", [NOW - 1000]);
    await cursorHistoryCollector.sync(h.ctx);
    historyDir("aaa", "c:/work/demo/a.ts", [NOW - 1000, NOW - 900]);

    const later = NOW + 25 * 60 * 60 * 1000;
    const stat = await cursorHistoryCollector.sync({ ...h.ctx, now: () => later });
    expect(stat.skipped).toBe(0);
    expect(events()).toHaveLength(2);
  });

  it("reports a history it cannot read, and does not wipe the events over it", async () => {
    historyDir("aaa", "c:/work/demo/a.ts", [NOW - 1000]);
    await cursorHistoryCollector.sync(h.ctx);
    expect(events()).toHaveLength(1);

    // A directory that exists but cannot be listed. Replacing it with a file
    // is the portable way to arrange that: `readdirSync` fails with ENOTDIR
    // everywhere, whereas chmod means nothing on Windows.
    fs.rmSync(h.roots.cursorHistory, { recursive: true, force: true });
    fs.writeFileSync(h.roots.cursorHistory, "nem mappa", "utf8");

    const stat = await cursorHistoryCollector.sync({ ...h.ctx, repair: true });

    // Counted, not swallowed: a store that is present but unreadable is a
    // different fact from one that was never installed, and only the second
    // deserves silence.
    expect(stat.errors).toBe(1);
    expect(h.logs.some((l) => l.includes("unreadable"))).toBe(true);
    expect(events()).toHaveLength(1);
  });

  it("leaves the old events in place when the rebuild throws mid-way", async () => {
    historyDir("aaa", "c:/work/demo/a.ts", [NOW - 1000]);
    await cursorHistoryCollector.sync(h.ctx);
    expect(events()).toHaveLength(1);

    // The refill runs in one transaction, so a failure inside it cannot leave
    // the attribution cascade looking at an empty table.
    historyDir("bbb", "c:/work/masik/b.ts", [NOW - 900]);
    const boom = {
      ...h.ctx,
      hub: new Proxy(h.hub, {
        get(target, prop, receiver) {
          if (prop === "transaction") {
            return () => () => {
              throw new Error("megszakadt");
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }),
    };
    await expect(cursorHistoryCollector.sync(boom)).rejects.toThrow("megszakadt");
    expect(events()).toHaveLength(1);
  });
});
