import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSchema, openHub, type Db } from "../src/db/open.js";
import {
  CORRELATION_MARGIN_MS,
  RULE_VERSION,
  collectCwdEvidence,
  correlateTime,
  learnRoots,
  makeResolver,
  reattribute,
  pruneResolutionCache,
  resolveFileEvents,
} from "../src/attribution/resolve.js";

/**
 * The cascade decides which project a conversation belongs to. Every rank of it
 * is exercised here, because a wrong verdict is worse than no verdict at all —
 * and because `docs/mcp.md` promises the user exactly these rules.
 */

let dir: string;
let db: Db;

const T0 = Date.parse("2026-08-01T10:00:00.000Z");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-attr-"));
  db = openHub(path.join(dir, "hub.sqlite"));
  initSchema(db);
  // Known roots, so nothing here depends on what is on this machine's disk.
  for (const key of ["demo", "masik"]) {
    db.prepare("insert into projects(key, display_name, root_path) values (?,?,?)").run(key, key, `c:/work/${key}`);
  }
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function session(extId: string, over: { cwd?: string | null; started?: number | null; ended?: number | null } = {}): number {
  const info = db
    .prepare("insert into sessions(tool, ext_id, cwd_norm, started_ms, ended_ms) values ('cursor',?,?,?,?)")
    .run(extId, over.cwd ?? null, over.started ?? null, over.ended ?? null);
  return Number(info.lastInsertRowid);
}

function evidence(sessionId: number, origin: string, rawPath: string, weight = 1, key: string | null = null): void {
  db.prepare(
    "insert into path_evidence(session_id, origin, raw_path, project_key, weight) values (?,?,?,?,?)",
  ).run(sessionId, origin, rawPath, key, weight);
}

const verdict = (sessionId: number): { key: string | null; method: string; confidence: string; runner: string | null } => {
  const r = db
    .prepare(
      `select p.key, a.method, a.confidence, a.runner_up_key
       from attribution a left join projects p on p.id = a.project_id where a.session_id = ?`,
    )
    .get(sessionId) as { key: string | null; method: string; confidence: string; runner_up_key: string | null };
  return { key: r.key ?? null, method: r.method, confidence: r.confidence, runner: r.runner_up_key ?? null };
};

describe("cascade ranks", () => {
  it("takes the working directory over a time correlation", () => {
    const s = session("s1");
    evidence(s, "cwd", "c:/work/demo", 3);
    evidence(s, "time_correlation", "~time:9/10", 1, "masik");
    reattribute(db);
    expect(verdict(s)).toMatchObject({ key: "demo", method: "cwd", confidence: "strong" });
  });

  it("uses the Cursor ofsContent keys when there is no working directory", () => {
    const s = session("s2");
    evidence(s, "ofs_key", "c:/work/demo/src/index.ts", 2);
    reattribute(db);
    expect(verdict(s)).toMatchObject({ key: "demo", method: "ofs_votes", confidence: "strong" });
  });

  it("falls back to paths mentioned in the messages", () => {
    const s = session("s3");
    evidence(s, "bubble_scan", "c:/work/demo/README.md", 1);
    reattribute(db);
    expect(verdict(s)).toMatchObject({ key: "demo", method: "msg_votes", confidence: "strong" });

    const s2 = session("s4");
    evidence(s2, "msg_request_ctx", "c:/work/masik/app.ts", 1);
    reattribute(db);
    expect(verdict(s2).method).toBe("msg_votes");
  });

  it("stays unattributed when nothing points anywhere", () => {
    const s = session("s5");
    reattribute(db);
    expect(verdict(s)).toMatchObject({ key: null, method: "unattributed", confidence: "none" });
    const row = db.prepare("select project_id from sessions where id = ?").get(s) as { project_id: number | null };
    expect(row.project_id).toBeNull();
  });

  it("stays unattributed when the only evidence resolves to nothing", () => {
    const s = session("s6");
    evidence(s, "bubble_scan", "d:/nem-letezik-sehol/valami.ts", 1);
    reattribute(db);
    expect(verdict(s).method).toBe("unattributed");
  });

  it("ranks by weight inside a rank and records the runner-up", () => {
    const s = session("s7");
    evidence(s, "bubble_scan", "c:/work/demo/a.ts", 1);
    evidence(s, "bubble_scan", "c:/work/masik/b.ts", 5);
    reattribute(db);
    expect(verdict(s)).toMatchObject({ key: "masik", runner: "demo" });
  });

  it("stamps the rule version so doctor can spot drift", () => {
    const s = session("s8");
    evidence(s, "cwd", "c:/work/demo", 3);
    reattribute(db);
    const r = db.prepare("select rule_version from attribution where session_id = ?").get(s) as {
      rule_version: number;
    };
    expect(r.rule_version).toBe(RULE_VERSION);
  });
});

describe("manual attribution", () => {
  it("outweighs every inferred signal and survives a reattribute", () => {
    const s = session("m1");
    evidence(s, "cwd", "c:/work/demo", 3);
    evidence(s, "manual", "~manual:masik", 1000, "masik");
    reattribute(db);
    expect(verdict(s)).toMatchObject({ key: "masik", method: "manual", confidence: "strong" });

    // The whole point of the manual row: re-running the cascade must not undo
    // the user's decision.
    reattribute(db);
    reattribute(db);
    expect(verdict(s)).toMatchObject({ key: "masik", method: "manual" });
  });

  it("keeps working when the manual key names a project with no root on disk", () => {
    const s = session("m2");
    db.prepare("delete from projects where key = 'masik'").run();
    evidence(s, "manual", "~manual:masik", 1000, "masik");
    reattribute(db);
    expect(verdict(s).key).toBe("masik");
  });
});

describe("cwd evidence", () => {
  it("mirrors every session's working directory, and only replaces its own origin", () => {
    const s = session("c1", { cwd: "c:/work/demo" });
    evidence(s, "bubble_scan", "c:/work/masik/x.ts", 1);
    collectCwdEvidence(db);
    collectCwdEvidence(db); // idempotent: no duplicate votes
    const rows = db.prepare("select origin, raw_path from path_evidence where session_id = ?").all(s) as Array<{
      origin: string;
      raw_path: string;
    }>;
    expect(rows.filter((r) => r.origin === "cwd")).toHaveLength(1);
    expect(rows.filter((r) => r.origin === "bubble_scan")).toHaveLength(1);
  });
});

describe("time correlation", () => {
  const fileEvent = (key: string, tsMs: number): void => {
    db.prepare("insert into file_events(project_key, resource, ts_ms) values (?,?,?)").run(
      key,
      `c:/work/${key}/f${tsMs}.ts`,
      tsMs,
    );
  };

  it("is medium confidence when the edits are many and mostly one project", () => {
    const s = session("t1", { started: T0, ended: T0 + 60_000 });
    for (let i = 0; i < 4; i++) fileEvent("demo", T0 + i * 1000);
    fileEvent("masik", T0 + 500);
    expect(correlateTime(db)).toBe(1);
    reattribute(db);
    expect(verdict(s)).toMatchObject({ key: "demo", method: "time_correlation", confidence: "medium" });
  });

  it("drops to weak when the evidence is thin", () => {
    const s = session("t2", { started: T0 });
    fileEvent("demo", T0 + 1000);
    correlateTime(db);
    reattribute(db);
    expect(verdict(s)).toMatchObject({ key: "demo", method: "time_correlation", confidence: "weak" });
  });

  it("drops to weak when the edits are spread over several projects", () => {
    const s = session("t3", { started: T0, ended: T0 + 60_000 });
    for (let i = 0; i < 3; i++) fileEvent("demo", T0 + i * 1000);
    for (let i = 0; i < 2; i++) fileEvent("masik", T0 + i * 1000 + 100);
    for (let i = 0; i < 2; i++) fileEvent("harmadik", T0 + i * 1000 + 200);
    correlateTime(db);
    reattribute(db);
    // 3 of 7 edits is not "what the user was working on".
    expect(verdict(s)).toMatchObject({ key: "demo", confidence: "weak" });
  });

  it("counts an exact two-way tie as medium, which is where the rule draws it", () => {
    const s = session("t3b", { started: T0, ended: T0 + 60_000 });
    for (let i = 0; i < 3; i++) {
      fileEvent("demo", T0 + i * 1000);
      fileEvent("masik", T0 + i * 1000 + 100);
    }
    correlateTime(db);
    reattribute(db);
    expect(verdict(s).confidence).toBe("medium");
  });

  it("ignores edits outside the window around the conversation", () => {
    const s = session("t4", { started: T0 });
    for (let i = 0; i < 5; i++) fileEvent("demo", T0 + CORRELATION_MARGIN_MS + 60_000 + i);
    expect(correlateTime(db)).toBe(0);
    reattribute(db);
    expect(verdict(s).method).toBe("unattributed");
  });

  it("does not bother with sessions that already have a strong signal", () => {
    const s = session("t5", { started: T0 });
    evidence(s, "cwd", "c:/work/demo", 3, "demo");
    for (let i = 0; i < 5; i++) fileEvent("masik", T0 + i * 1000);
    expect(correlateTime(db)).toBe(0);
  });

  it("replaces its own verdicts instead of piling them up", () => {
    const s = session("t6", { started: T0 });
    for (let i = 0; i < 4; i++) fileEvent("demo", T0 + i * 1000);
    correlateTime(db);
    correlateTime(db);
    const n = db
      .prepare("select count(*) c from path_evidence where session_id = ? and origin like 'time_correlation%'")
      .get(s) as { c: number };
    expect(n.c).toBe(1);
  });

  it("skips a session with no timestamp at all rather than guessing", () => {
    session("t7", { started: null });
    for (let i = 0; i < 4; i++) fileEvent("demo", T0 + i * 1000);
    expect(correlateTime(db)).toBe(0);
  });
});

describe("file event resolution", () => {
  const keys = (): Array<string | null> =>
    (
      db.prepare("select resource, project_key from file_events order by resource").all() as Array<{
        resource: string;
        project_key: string | null;
      }>
    ).map((r) => r.project_key);

  const seed = (): void => {
    db.prepare("insert into file_events(project_key, resource, ts_ms) values (null, 'c:/work/demo/a.ts', ?)").run(T0);
    db.prepare("insert into file_events(project_key, resource, ts_ms) values (null, 'c:/work/demo/b.ts', ?)").run(T0);
    db.prepare("insert into file_events(project_key, resource, ts_ms) values (null, 'c:/sehol/c.ts', ?)").run(T0);
  };

  it("resolves each distinct resource once, and marks the unknown ones null", () => {
    seed();
    expect(resolveFileEvents(db, makeResolver(db))).toMatchObject({ resources: 3, resolved: 2, computed: 3 });
    expect(keys()).toEqual([null, "demo", "demo"]);
  });

  /**
   * The whole point of the cache: the history collector reloads file_events
   * every day, which nulls every project_key it holds, and re-resolving 6 000
   * paths from the filesystem was the slowest step of a sync.
   */
  it("survives the collector reloading the table, without resolving anything again", () => {
    seed();
    resolveFileEvents(db, makeResolver(db));

    db.prepare("delete from file_events").run();
    seed();
    expect(keys()).toEqual([null, null, null]);

    const second = resolveFileEvents(db, makeResolver(db));
    expect(second.computed).toBe(0);
    expect(second.cached).toBe(3);
    expect(keys()).toEqual([null, "demo", "demo"]);
  });

  it("recomputes on demand, because an alias changes what a path resolves to", () => {
    seed();
    resolveFileEvents(db, makeResolver(db));
    db.prepare("insert or replace into project_aliases(alias, key, kind) values ('demo','egyesitett','manual')").run();

    expect(resolveFileEvents(db, makeResolver(db)).computed).toBe(0);
    expect(keys()).toEqual([null, "demo", "demo"]);

    expect(resolveFileEvents(db, makeResolver(db), { recompute: true }).computed).toBe(3);
    expect(keys()).toEqual([null, "egyesitett", "egyesitett"]);
  });

  it("forgets cached resolutions for resources that are gone", () => {
    seed();
    resolveFileEvents(db, makeResolver(db));
    db.prepare("delete from file_events where resource = 'c:/sehol/c.ts'").run();
    expect(pruneResolutionCache(db)).toBe(1);
    expect((db.prepare("select count(*) c from path_keys").get() as { c: number }).c).toBe(2);
  });
});

describe("learned workspace roots", () => {
  it("keeps a manual root while replacing the learned ones", () => {
    db.prepare("insert into workspace_roots(root, children, kind) values ('d:/kezi', 1, 'manual')").run();
    for (const name of ["egy", "ketto", "harom"]) session(`r-${name}`, { cwd: `d:/munka/${name}` });
    const roots = learnRoots(db);
    expect(roots).toContain("d:/kezi");
    expect(roots).toContain("d:/munka");

    // Learned roots are recomputed from scratch; the manual one is not touched.
    db.prepare("delete from sessions").run();
    const after = learnRoots(db);
    expect(after).toEqual(["d:/kezi"]);
  });
});
