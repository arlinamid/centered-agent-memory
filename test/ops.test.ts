import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { claudeCodeCollector } from "../src/collectors/claude-code.js";
import { collectCwdEvidence, learnRoots, reattribute } from "../src/attribution/resolve.js";
import { checkPortability, stampPlatform } from "../src/db/portability.js";
import { openSourceReadonly } from "../src/db/open.js";
import { consolidate } from "../src/memory/consolidate.js";
import { backup, defaultBackupPath } from "../src/ops/backup.js";
import { describeFreshness, formatFreshness, freshness, humanAge } from "../src/ops/freshness.js";
import { ForgetTargetError, forget, prune, vacuum } from "../src/ops/prune.js";
import { recall } from "../src/query/recall.js";
import { CASE_INSENSITIVE_FS } from "../src/paths.js";
import { makeHarness, writeTranscript, type Harness } from "./helpers/fixtures.js";

/**
 * Operations: how old the index is, what retention removes, and whether a copy
 * of it is usable somewhere else. M4's own conditions, in the same order.
 */

let h: Harness;

const SID = "11111111-2222-3333-4444-555555555555";
const SID2 = "22222222-3333-4444-5555-666666666666";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-08-01T10:00:00.000Z");
const NOW = T0 + 10 * DAY;

async function seed(): Promise<void> {
  writeTranscript(h.roots, "C--work-demo", SID, [
    { type: "ai-title", sessionId: SID, title: "Árvíztűrő teszt" },
    {
      type: "user",
      sessionId: SID,
      cwd: "C:\\work\\demo",
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { content: "Hogyan javítsuk a tükörfúrógép hibát a docker-compose alatt?" },
    },
    {
      type: "assistant",
      sessionId: SID,
      cwd: "C:\\work\\demo",
      timestamp: "2026-08-01T10:00:30.000Z",
      message: { content: [{ type: "text", text: "Az árvíztűrő megoldás a docker-compose átírása." }] },
    },
  ]);
  writeTranscript(h.roots, "C--work-masik", SID2, [
    {
      type: "user",
      sessionId: SID2,
      cwd: "C:\\work\\masik",
      timestamp: "2026-08-05T10:00:00.000Z",
      message: { content: "Teljesen más téma: adatbázis migráció." },
    },
  ]);
  await claudeCodeCollector.sync(h.ctx);
  collectCwdEvidence(h.hub);
  learnRoots(h.hub);
  for (const key of ["demo", "masik"]) {
    h.hub
      .prepare("insert or replace into projects(key, display_name, root_path) values (?,?,?)")
      .run(key, key, `c:/work/${key}`);
  }
  reattribute(h.hub);
}

function recordRun(endedMs: number | null, errors = 0, startedMs = (endedMs ?? NOW) - 5000): number {
  return Number(
    h.hub
      .prepare("insert into sync_runs(started_ms, ended_ms, errors, turns_added) values (?,?,?,?)")
      .run(startedMs, endedMs, errors, 12).lastInsertRowid,
  );
}

const count = (sql: string, ...p: unknown[]): number =>
  (h.hub.prepare(sql).get(...p) as { c: number }).c;

beforeEach(async () => {
  h = makeHarness();
  await seed();
});

afterEach(() => h.cleanup());

describe("freshness", () => {
  it("has no age before the first run finishes, and does not pretend otherwise", () => {
    const f = freshness(h.hub, NOW);
    expect(f.lastEndedMs).toBeNull();
    expect(f.ageMs).toBeNull();
    expect(f.stale).toBe(true);
    expect(formatFreshness(f)).toContain("még nem futott végig szinkron");
  });

  it("takes its age from the newest finished run, not the newest row", () => {
    recordRun(NOW - 5 * DAY);
    recordRun(NOW - 2 * 60 * 60 * 1000);
    recordRun(null, 0, NOW - 30_000); // in flight right now

    const f = freshness(h.hub, NOW);
    expect(f.ageMs).toBe(2 * 60 * 60 * 1000);
    expect(f.stale).toBe(false);
    expect(formatFreshness(f)).toContain("2 órája");
  });

  it("counts the runs that never finished, but only once they cannot still be running", () => {
    recordRun(null, 0, NOW - 30_000);
    expect(freshness(h.hub, NOW).unfinished).toBe(0);
    recordRun(null, 0, NOW - 5 * DAY);
    expect(freshness(h.hub, NOW).unfinished).toBe(1);
  });

  it("carries the last run's errors, because a partial sync looks like a complete one", () => {
    recordRun(NOW - 60_000, 4);
    expect(formatFreshness(freshness(h.hub, NOW))).toContain("4 hiba");
  });

  it("honours a configured staleness threshold", () => {
    recordRun(NOW - 3 * 60 * 60 * 1000);
    expect(freshness(h.hub, NOW).stale).toBe(false);
    expect(freshness(h.hub, NOW, 60 * 60 * 1000).stale).toBe(true);
  });

  it("reports the content, so an empty index cannot look like a full one", () => {
    recordRun(NOW - 60_000);
    const f = freshness(h.hub, NOW);
    expect(f.sessions).toBe(2);
    expect(f.turns).toBeGreaterThan(0);
    expect(describeFreshness(f)).toContain("2 session");
  });

  it("rounds the age to the unit the decision is made in", () => {
    expect(humanAge(30_000)).toBe("épp most");
    expect(humanAge(90 * 60 * 1000)).toBe("1 órája");
    expect(humanAge(5 * DAY)).toBe("5 napja");
  });
});

describe("prune", () => {
  /** Recall events aged deliberately: retention is about time, not about count. */
  function trace(ageDays: number, queries = ["arvizturo", "tukorfurogep", "docker compose"]): void {
    for (const [i, q] of queries.entries()) {
      recall(h.hub, { query: q, nowMs: NOW - ageDays * DAY + i * DAY, minConfidence: "weak" });
    }
    h.hub.prepare("update recall_events set score = 0.95").run();
  }

  it("removes the old trace and keeps the recent one", () => {
    trace(400);
    const old = count("select count(*) c from recall_events");
    expect(old).toBeGreaterThan(0);
    trace(1);

    const stat = prune(h.hub, { nowMs: NOW, policy: { recallDays: 365 } });
    expect(stat.recallEvents).toBe(old);
    expect(count("select count(*) c from recall_events")).toBe(
      count("select count(*) c from recall_events where ts_ms >= ?", NOW - 365 * DAY),
    );
  });

  /**
   * The one rule that constrains all of retention. A promoted memory has to be
   * able to show which questions brought it back; a sweep that emptied that
   * would make the whole memory layer's claim false.
   */
  it("never removes the evidence behind a live promotion", () => {
    trace(400);
    consolidate(h.hub, { nowMs: NOW - 397 * DAY });
    expect(count("select count(*) c from memory_facts")).toBeGreaterThan(0);

    const stat = prune(h.hub, { nowMs: NOW, policy: { recallDays: 365 } });
    expect(stat.protectedEvents).toBeGreaterThan(0);
    expect(stat.recallEvents).toBe(0);

    const promoted = h.hub.prepare("select chunk_id from memory_facts limit 1").get() as { chunk_id: number };
    expect(count("select count(*) c from recall_events where chunk_id = ?", promoted.chunk_id)).toBeGreaterThan(0);
  });

  it("drops the question texts that no event points at any more", () => {
    trace(400);
    expect(count("select count(*) c from memory_queries")).toBe(3);
    const stat = prune(h.hub, { nowMs: NOW, policy: { recallDays: 365 } });
    expect(stat.queries).toBe(3);
    expect(count("select count(*) c from memory_queries")).toBe(0);
  });

  it("caps the run log at the newest N", () => {
    for (let i = 0; i < 20; i++) recordRun(NOW - i * 1000);
    const stat = prune(h.hub, { nowMs: NOW, policy: { keepRuns: 5 } });
    expect(stat.syncRuns).toBe(15);
    expect(count("select count(*) c from sync_runs")).toBe(5);
    // The newest survive, so the freshness report still has something to read.
    expect(freshness(h.hub, NOW).ageMs).toBe(0);
  });

  it("leaves a missing source alone unless asked, because an unmounted drive comes back", () => {
    h.hub.prepare("update sources set status = 'missing', last_synced_ms = ?").run(NOW - 90 * DAY);
    expect(prune(h.hub, { nowMs: NOW }).missingSessions).toBe(0);
    expect(count("select count(*) c from sessions")).toBe(2);
  });

  it("removes sessions of a long-gone source, with their turns and their text index", () => {
    const before = count("select count(*) c from chunks_fts");
    expect(before).toBeGreaterThan(0);
    h.hub.prepare("update sources set status = 'missing', last_synced_ms = ?").run(NOW - 90 * DAY);

    const stat = prune(h.hub, { nowMs: NOW, policy: { missingDays: 30 } });
    expect(stat.missingSessions).toBe(2);
    expect(stat.missingTurns).toBeGreaterThan(0);
    expect(count("select count(*) c from sessions")).toBe(0);
    expect(count("select count(*) c from turns")).toBe(0);
    // The contentless index has no foreign key of its own; the trigger is what
    // keeps it from filling up with orphans forever.
    expect(count("select count(*) c from chunks_fts")).toBe(0);
  });

  it("counts exactly what it would delete, so --dry-run is worth trusting", () => {
    trace(400);
    for (let i = 0; i < 20; i++) recordRun(NOW - i * 1000);

    const planned = prune(h.hub, { nowMs: NOW, policy: { recallDays: 365, keepRuns: 5 }, dryRun: true });
    expect(planned.dryRun).toBe(true);
    const eventsBefore = count("select count(*) c from recall_events");

    const done = prune(h.hub, { nowMs: NOW, policy: { recallDays: 365, keepRuns: 5 } });
    expect(done.recallEvents).toBe(planned.recallEvents);
    expect(done.syncRuns).toBe(planned.syncRuns);
    expect(done.queries).toBe(planned.queries);
    expect(eventsBefore - count("select count(*) c from recall_events")).toBe(planned.recallEvents);
  });

  it("changes nothing on a dry run", () => {
    trace(400);
    for (let i = 0; i < 20; i++) recordRun(NOW - i * 1000);
    const before = [
      count("select count(*) c from recall_events"),
      count("select count(*) c from sync_runs"),
      count("select count(*) c from memory_queries"),
    ];
    prune(h.hub, { nowMs: NOW, policy: { recallDays: 365, keepRuns: 5 }, dryRun: true });
    expect([
      count("select count(*) c from recall_events"),
      count("select count(*) c from sync_runs"),
      count("select count(*) c from memory_queries"),
    ]).toEqual(before);
  });

  it("is safe to run twice: the second pass finds nothing left", () => {
    trace(400);
    for (let i = 0; i < 20; i++) recordRun(NOW - i * 1000);
    prune(h.hub, { nowMs: NOW, policy: { recallDays: 365, keepRuns: 5 } });
    const second = prune(h.hub, { nowMs: NOW, policy: { recallDays: 365, keepRuns: 5 } });
    expect(second.recallEvents).toBe(0);
    expect(second.syncRuns).toBe(0);
    expect(second.queries).toBe(0);
  });
});

describe("vacuum", () => {
  it("gives the space back after a large deletion", () => {
    const ins = h.hub.prepare("insert into file_events(project_key, resource, ts_ms) values (null, ?, ?)");
    const fill = h.hub.transaction(() => {
      for (let i = 0; i < 20_000; i++) ins.run(`c:/work/demo/${"x".repeat(80)}-${i}.ts`, T0 + i);
    });
    fill();
    const grown = vacuum(h.hub).afterBytes;

    h.hub.prepare("delete from file_events").run();
    const { beforeBytes, afterBytes } = vacuum(h.hub);
    expect(beforeBytes).toBe(grown);
    expect(afterBytes).toBeLessThan(beforeBytes);
  });
});

describe("forget", () => {
  it("removes one project and leaves the other one alone", () => {
    const stat = forget(h.hub, { project: "demo" });
    expect(stat.sessions).toBe(1);
    expect(stat.turns).toBeGreaterThan(0);
    expect(count("select count(*) c from sessions")).toBe(1);
    expect(count("select count(*) c from sessions where tool='claude_code' and ext_id=?", SID2)).toBe(1);
    // Nothing is left pointing at it, so a reattribute cannot bring it back.
    expect(count("select count(*) c from projects where key='demo'")).toBe(0);
    reattribute(h.hub);
    expect(count("select count(*) c from projects where key='demo'")).toBe(0);
  });

  it("removes one session by its citation form", () => {
    const stat = forget(h.hub, { session: `claude_code:${SID}` });
    expect(stat.sessions).toBe(1);
    expect(count("select count(*) c from sessions")).toBe(1);
    // The project survives: another session may still belong to it.
    expect(count("select count(*) c from projects where key='demo'")).toBe(1);
  });

  it("takes the promoted memories of the forgotten material with it", () => {
    for (const [i, q] of ["arvizturo", "tukorfurogep", "docker compose"].entries()) {
      recall(h.hub, { query: q, nowMs: NOW - 3 * DAY + i * DAY, minConfidence: "weak" });
    }
    h.hub.prepare("update recall_events set score = 0.95").run();
    consolidate(h.hub, { nowMs: NOW });
    expect(count("select count(*) c from memory_facts")).toBeGreaterThan(0);

    const stat = forget(h.hub, { project: "demo" });
    expect(stat.facts).toBeGreaterThan(0);
    expect(count("select count(*) c from memory_facts")).toBe(0);
  });

  it("never touches the source files, so a later sync can index them again", async () => {
    const file = (h.hub.prepare("select loc_path from turns limit 1").get() as { loc_path: string }).loc_path;
    forget(h.hub, { project: "demo" });
    expect(fs.existsSync(file)).toBe(true);

    // The watermark went with the session, so the source is read from scratch.
    h.hub.prepare("delete from sources").run();
    await claudeCodeCollector.sync(h.ctx);
    expect(count("select count(*) c from sessions where ext_id = ?", SID)).toBe(1);
  });

  it("counts without deleting on a dry run", () => {
    const planned = forget(h.hub, { project: "demo" }, { dryRun: true });
    expect(planned.sessions).toBe(1);
    expect(count("select count(*) c from sessions")).toBe(2);
    expect(forget(h.hub, { project: "demo" }).turns).toBe(planned.turns);
  });

  it("names what it could not find instead of silently doing nothing", () => {
    expect(() => forget(h.hub, { project: "nincs-ilyen" })).toThrow(ForgetTargetError);
    expect(() => forget(h.hub, { session: "claude_code:nincs" })).toThrow(ForgetTargetError);
    expect(() => forget(h.hub, {})).toThrow(ForgetTargetError);
  });
});

describe("backup", () => {
  it("writes a verified copy that holds the same index", async () => {
    recordRun(NOW - 60_000);
    const target = path.join(h.dir, "mentes", "hub.sqlite");

    const res = await backup(h.hub, target);
    expect(res.problems).toEqual([]);
    expect(res.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(target)).toBe(true);

    const copy = openSourceReadonly(target);
    try {
      expect((copy.prepare("select count(*) c from sessions").get() as { c: number }).c).toBe(2);
      expect((copy.prepare("select count(*) c from chunks_fts").get() as { c: number }).c).toBeGreaterThan(0);
    } finally {
      copy.close();
    }
  });

  /**
   * The reason this uses the online backup API rather than copying the file: a
   * write that is still only in the WAL is invisible to `cp`.
   */
  it("includes writes that are still in the write-ahead log", async () => {
    h.hub.prepare("insert into projects(key, display_name) values ('friss','friss')").run();
    const target = path.join(h.dir, "wal.sqlite");
    await backup(h.hub, target);

    const copy = openSourceReadonly(target);
    try {
      expect(copy.prepare("select key from projects where key = 'friss'").get()).toBeDefined();
    } finally {
      copy.close();
    }
  });

  it("leaves no sidecar files beside the backup", async () => {
    const target = path.join(h.dir, "tiszta", "hub.sqlite");
    await backup(h.hub, target);
    expect(fs.readdirSync(path.dirname(target))).toEqual(["hub.sqlite"]);
  });

  it("puts a dated file next to the index when no name is given", () => {
    const p = defaultBackupPath("/tmp/cam/hub.sqlite", Date.parse("2026-08-29T18:04:05.000Z"));
    expect(p.replace(/\\/g, "/")).toBe("/tmp/cam/backups/hub-20260829-180405.sqlite");
  });
});

describe("portability", () => {
  it("stamps how the index spells its paths", () => {
    const p = checkPortability(h.hub);
    expect(p.stamped).toBe(true);
    expect(p.caseFold).toBe(CASE_INSENSITIVE_FS);
    expect(p.mismatch).toBe(false);
    expect(p.message).toBeNull();
  });

  it("does not re-stamp an index that already said what it is", () => {
    h.hub.prepare("update meta set value = '9' where key = 'path_case_fold'").run();
    stampPlatform(h.hub);
    expect(
      (h.hub.prepare("select value from meta where key = 'path_case_fold'").get() as { value: string }).value,
    ).toBe("9");
  });

  /**
   * A copied index whose paths were folded differently matches nothing and
   * reports no error at all — empty results that look like an empty history.
   */
  it("catches the copy that would silently find nothing", () => {
    h.hub
      .prepare("update meta set value = ? where key = 'path_case_fold'")
      .run(CASE_INSENSITIVE_FS ? "0" : "1");
    h.hub.prepare("insert or replace into meta(key, value) values ('written_on','sunos')").run();

    const p = checkPortability(h.hub);
    expect(p.mismatch).toBe(true);
    expect(p.message).toContain("sunos");
    expect(p.message).toContain("CAM_CASE_FOLD");
  });

  it("says nothing about an index written before the stamp existed", () => {
    h.hub.prepare("delete from meta where key in ('path_case_fold','written_on')").run();
    const p = checkPortability(h.hub);
    expect(p.stamped).toBe(false);
    expect(p.message).toBeNull();
  });
});
