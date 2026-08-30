import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, SPECS, isEntryPoint, run } from "../src/cli.js";
import { openHub, initSchema, type Db } from "../src/db/open.js";
import { defaultRoots, type ResolvedRoots } from "../src/paths.js";
import { claudeCodeCollector } from "../src/collectors/claude-code.js";
import { recall } from "../src/query/recall.js";
import { collectCwdEvidence, learnRoots, reattribute } from "../src/attribution/resolve.js";
import { writeTranscript } from "./helpers/fixtures.js";
import { openSourceReadonly } from "../src/db/open.js";

/**
 * The CLI is exercised through `run()` rather than a subprocess: the exit code
 * is the contract, and it is the return value here.
 *
 * Most tests sync `--tool codex` only, because its store hangs off the profile
 * directory and `CAM_HOME` therefore isolates it completely. Every other
 * profile-based store is isolated the same way; the one exception is the Claude
 * scratchpad, which lives under the OS temp directory, so a test that runs all
 * collectors has to pin the roots through the config file as well.
 */

let dir: string;
let home: string;
let dbPath: string;
let roots: ResolvedRoots;
let out: string[];
let err: string[];
const envBefore = { db: process.env.CAM_DB, home: process.env.CAM_HOME, config: process.env.CAM_CONFIG };

const stdout = (): string => out.join("\n");
const stderr = (): string => err.join("\n");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cam-cli-"));
  home = path.join(dir, "home");
  dbPath = path.join(dir, "hub.sqlite");
  roots = defaultRoots(home);
  fs.mkdirSync(roots.claudeProjects, { recursive: true });
  process.env.CAM_DB = dbPath;
  process.env.CAM_HOME = home;
  // Point at a file that does not exist, so the machine's own config cannot
  // reach the tests — the dream phase reads its model from there.
  process.env.CAM_CONFIG = path.join(dir, "config.json");

  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => out.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => err.push(a.map(String).join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (envBefore.db === undefined) delete process.env.CAM_DB;
  else process.env.CAM_DB = envBefore.db;
  if (envBefore.home === undefined) delete process.env.CAM_HOME;
  else process.env.CAM_HOME = envBefore.home;
  if (envBefore.config === undefined) delete process.env.CAM_CONFIG;
  else process.env.CAM_CONFIG = envBefore.config;
  fs.rmSync(dir, { recursive: true, force: true });
});

const SID = "11111111-2222-3333-4444-555555555555";
const SID2 = "22222222-3333-4444-5555-666666666666";

/** Index a two-project corpus straight into the hub the CLI will open. */
async function seed(): Promise<void> {
  writeTranscript(roots, "C--work-demo", SID, [
    { type: "ai-title", sessionId: SID, title: "Árvíztűrő teszt" },
    {
      type: "user",
      sessionId: SID,
      cwd: "C:\\work\\demo",
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { content: "Hogyan javítsuk a tükörfúrógép hibát?" },
    },
    {
      type: "assistant",
      sessionId: SID,
      cwd: "C:\\work\\demo",
      timestamp: "2026-08-01T10:00:30.000Z",
      message: { content: [{ type: "text", text: "Az árvíztűrő megoldás a docker-compose átírása." }] },
    },
  ]);
  writeTranscript(roots, "C--work-masik", SID2, [
    {
      type: "user",
      sessionId: SID2,
      cwd: "C:\\work\\masik",
      timestamp: "2026-08-05T10:00:00.000Z",
      message: { content: "Teljesen más téma: adatbázis migráció." },
    },
  ]);

  const hub = openHub(dbPath);
  initSchema(hub);
  await claudeCodeCollector.sync({
    hub,
    roots,
    openSource: openSourceReadonly,
    now: () => 1_700_000_000_000,
    log: () => {},
    maxInlineBytes: 256 * 1024,
  });
  collectCwdEvidence(hub);
  learnRoots(hub);
  for (const key of ["demo", "masik"]) {
    hub
      .prepare("insert or replace into projects(key, display_name, root_path) values (?,?,?)")
      .run(key, key, `c:/work/${key}`);
  }
  reattribute(hub);
  hub.close();
}

function withHub<T>(fn: (db: Db) => T): T {
  const db = openHub(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe("entry point", () => {
  it("recognises itself through a symlinked install directory", () => {
    // What a Node version manager leaves in every global path: `nodejs` is a
    // link, so `import.meta.url` arrives resolved and `process.argv[1]` does
    // not. Compared raw, the installed CLI ran nothing and exited zero.
    const real = path.join(dir, "versions", "v22");
    const link = path.join(dir, "current");
    fs.mkdirSync(real, { recursive: true });
    const cli = path.join(real, "cli.js");
    fs.writeFileSync(cli, "");
    fs.symlinkSync(real, link, "junction");

    expect(isEntryPoint(pathToFileURL(cli).href, path.join(link, "cli.js"))).toBe(true);
  });

  it("still tells an import apart from a run", () => {
    const a = path.join(dir, "a.js");
    const b = path.join(dir, "b.js");
    fs.writeFileSync(a, "");
    fs.writeFileSync(b, "");

    expect(isEntryPoint(pathToFileURL(a).href, b)).toBe(false);
    expect(isEntryPoint(pathToFileURL(a).href, undefined)).toBe(false);
  });
});

describe("argument handling", () => {
  it("does not let a bool flag swallow the question", async () => {
    await seed();
    expect(await run(["recall", "--json", "arvizturo"])).toBe(EXIT_OK);
    const hits = JSON.parse(stdout()) as Array<{ snippet: string }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(stderr()).not.toContain("Usage");
  });

  it("does not let --subagents swallow the project name", async () => {
    await seed();
    expect(await run(["timeline", "--subagents", "demo"])).toBe(EXIT_OK);
    expect(stdout()).toContain("demo");
    expect(stderr()).toBe("");
  });

  it("accepts a flag both before and after the positional", async () => {
    await seed();
    expect(await run(["recall", "arvizturo", "--json"])).toBe(EXIT_OK);
    expect(JSON.parse(stdout())).toBeInstanceOf(Array);
  });

  it("rejects an unknown flag instead of ignoring the typo", async () => {
    await seed();
    expect(await run(["recall", "--projct", "demo", "arvizturo"])).toBe(EXIT_USAGE);
    expect(stderr()).toContain("unknown flag: --projct");
  });

  it("reports a value flag left without a value", async () => {
    await seed();
    expect(await run(["recall", "arvizturo", "--project"])).toBe(EXIT_USAGE);
    expect(stderr()).toContain("--project requires a value");
  });

  it("rejects a --limit that is not a positive integer", async () => {
    await seed();
    expect(await run(["timeline", "demo", "--limit", "nulla"])).toBe(EXIT_USAGE);
    expect(stderr()).toContain("--limit");
  });
});

describe("--db", () => {
  it("names the index explicitly, above CAM_DB", async () => {
    await seed();
    const other = path.join(dir, "masik.sqlite");
    expect(await run(["projects", "--json", "--db", other])).toBe(EXIT_OK);
    expect(JSON.parse(stdout())).toEqual([]); // a fresh, empty index
    expect(fs.existsSync(other)).toBe(true);

    // and the default one is untouched
    out = [];
    expect(await run(["projects", "--json"])).toBe(EXIT_OK);
    expect((JSON.parse(stdout()) as unknown[]).length).toBeGreaterThan(0);
  });

  it("is accepted by every command, not only the query ones", async () => {
    const other = path.join(dir, "sync.sqlite");
    expect(await run(["sync", "--tool", "codex", "--db", other])).toBe(EXIT_OK);
    expect(fs.existsSync(other)).toBe(true);
  });
});

describe("--limit", () => {
  it("bounds the timeline, which used to cut silently at 200", async () => {
    await seed();
    expect(await run(["timeline", "demo", "--json", "--limit", "1"])).toBe(EXIT_OK);
    expect(JSON.parse(stdout())).toHaveLength(1);
  });

  it("bounds the project list", async () => {
    await seed();
    expect(await run(["projects", "--json", "--limit", "1"])).toBe(EXIT_OK);
    expect(JSON.parse(stdout())).toHaveLength(1);
  });

  it("bounds the dossier's list sections", async () => {
    await seed();
    expect(await run(["dossier", "demo", "--json", "--limit", "1"])).toBe(EXIT_OK);
    const d = JSON.parse(stdout()) as { topSessions: unknown[]; recentTitles: unknown[] };
    expect(d.topSessions).toHaveLength(1);
    expect(d.recentTitles.length).toBeLessThanOrEqual(1);
  });
});

describe("exit codes", () => {
  it("returns a usage code for an unknown subcommand", async () => {
    expect(await run(["szinkron"])).toBe(EXIT_USAGE);
    expect(stderr()).toContain("Unknown command");
  });

  it("prints the help and succeeds when asked for it", async () => {
    expect(await run([])).toBe(EXIT_OK);
    expect(stdout()).toContain("cam sync");
    expect(await run(["--help"])).toBe(EXIT_OK);
  });

  it("fails when the project does not exist", async () => {
    await seed();
    expect(await run(["dossier", "nincs-ilyen"])).toBe(EXIT_FAILED);
  });

  it("fails when a collector cannot read its store", async () => {
    fs.mkdirSync(path.dirname(roots.codexStateDb), { recursive: true });
    fs.writeFileSync(roots.codexStateDb, "ez nem sqlite fájl");
    expect(await run(["sync", "--tool", "codex"])).toBe(EXIT_FAILED);
    expect(stderr()).toContain("error");
  });

  it("succeeds on a sync with nothing to do", async () => {
    expect(await run(["sync", "--tool", "codex"])).toBe(EXIT_OK);
  });

  it("syncs cleanly on a machine where none of the tools are installed", async () => {
    // The README says a missing tool is a supported case rather than an error,
    // and this is that claim: every collector, none of the stores present.
    // `CAM_HOME` moves the profile-based roots, but the Claude scratchpad sits
    // under the OS temp directory, so the roots are pinned through the config
    // file too — otherwise this would read the real machine on any box that
    // has the tools installed.
    const nowhere = path.join(dir, "ures-gep");
    fs.writeFileSync(
      process.env.CAM_CONFIG!,
      JSON.stringify({ roots: { ...defaultRoots(nowhere), claudeTemp: path.join(nowhere, "temp") } }),
      "utf8",
    );

    expect(await run(["sync"])).toBe(EXIT_OK);

    // Each collector reported for itself, so the run walked all of them
    // instead of stopping at the first absent store.
    for (const name of ["claude_code", "codex", "cowork", "cursor", "claude-desktop", "cursor-history", "artifacts"]) {
      expect(stdout()).toMatch(new RegExp(`^${name}\\s+session:\\s*0\\b.*error:0`, "m"));
    }
    expect(stderr()).not.toContain("ERROR");

    // And the run is on record as clean, which is what a scheduled sync reads.
    const last = withHub((db) => db.prepare("select errors, ended_ms from sync_runs order by id desc limit 1").get()) as {
      errors: number;
      ended_ms: number | null;
    };
    expect(last).toMatchObject({ errors: 0 });
    expect(last.ended_ms).not.toBeNull();
  });
});

describe("concurrency", () => {
  it("steps back from a sync that is already running", async () => {
    await seed();
    // A live holder: our own pid is treated as dead, so borrow the parent's.
    withHub((db) =>
      db
        .prepare("insert or replace into meta(key, value) values ('sync_lock', ?)")
        .run(JSON.stringify({ pid: process.ppid, host: os.hostname(), startedMs: Date.now(), what: "sync" })),
    );
    expect(await run(["sync", "--tool", "codex"])).toBe(EXIT_OK);
    expect(stderr()).toContain("Already running: sync");
    // The first run's lock is left alone.
    const held = withHub((db) => db.prepare("select value from meta where key = 'sync_lock'").get());
    expect(held).toBeDefined();
  });

  it("releases its own lock when it finishes", async () => {
    await seed();
    expect(await run(["sync", "--tool", "codex"])).toBe(EXIT_OK);
    const held = withHub((db) => db.prepare("select value from meta where key = 'sync_lock'").get());
    expect(held).toBeUndefined();
  });
});

/** Three questions on three days is the smallest trace that can be promoted. */
async function trace(): Promise<void> {
  const day = 24 * 60 * 60 * 1000;
  // Anchored to the real clock: the CLI consolidates with Date.now(), and the
  // recency term would decay a fixed date away from the promotion floor.
  const t0 = Date.now() - 2 * day;
  withHub((db) => {
    for (const [i, q] of ["arvizturo", "tukorfurogep", "docker compose"].entries()) {
      recall(db, { query: q, nowMs: t0 + i * day, minConfidence: "weak" });
    }
    // bm25 has no spread in a two-chunk fixture; use the value measured on a
    // real index (see test/memory.test.ts).
    db.prepare("update recall_events set score = 0.95").run();
  });
}

describe("memory", () => {
  it("says plainly that there is nothing to show yet", async () => {
    await seed();
    expect(await run(["memory", "list"])).toBe(EXIT_OK);
    expect(stdout()).toContain("No promoted memories");
  });

  it("consolidates, lists, and shows a memory with its evidence", async () => {
    await seed();
    await trace();

    expect(await run(["memory", "consolidate"])).toBe(EXIT_OK);
    expect(stdout()).toContain("promoted:");

    out = [];
    expect(await run(["memory", "list", "--json"])).toBe(EXIT_OK);
    const facts = JSON.parse(stdout()) as Array<{ id: number; score: number }>;
    expect(facts.length).toBeGreaterThan(0);

    out = [];
    expect(await run(["memory", "show", String(facts[0]!.id)])).toBe(EXIT_OK);
    expect(stdout()).toContain("Evidence");
    expect(stdout()).toContain("docker compose");
    expect(stdout()).toContain("árvíztűrő");
  });

  it("reports the recurring topics and the collected trace", async () => {
    await seed();
    await trace();
    expect(await run(["memory", "consolidate"])).toBe(EXIT_OK);

    out = [];
    expect(await run(["memory", "topics"])).toBe(EXIT_OK);
    out = [];
    expect(await run(["memory", "status", "--json"])).toBe(EXIT_OK);
    const st = JSON.parse(stdout()) as { events: number; queries: number; facts: number };
    expect(st.queries).toBe(3);
    expect(st.facts).toBeGreaterThan(0);
  });

  it("fails on an unknown subcommand or a missing memory", async () => {
    await seed();
    expect(await run(["memory", "nincsilyen"])).toBe(EXIT_USAGE);
    expect(await run(["memory", "show", "999"])).toBe(EXIT_FAILED);
  });
});

/**
 * The dream is the only command that can hand conversation text to a model, so
 * the CLI wiring is worth testing separately from the phase itself
 * (`test/dream.test.ts`): what it refuses to do without configuration, what it
 * discloses before sending, and whether the disclosure survives `--quiet`.
 *
 * The "model" is a node process reading stdin, which is exactly what the
 * command provider promises to accept.
 */
describe("memory dream", () => {
  const STUB = [
    process.execPath,
    "-e",
    "let s='';process.stdin.on('data',(d)=>(s+=d)).on('end',()=>process.stdout.write('Álomszöveg '+s.length+' karakterről'))",
  ];

  function configure(command: string[]): void {
    fs.writeFileSync(
      process.env.CAM_CONFIG!,
      JSON.stringify({ memory: { dream: { provider: "command", model: "stub", command } } }),
    );
  }

  async function promoted(): Promise<void> {
    await seed();
    await trace();
    expect(await run(["memory", "consolidate"])).toBe(EXIT_OK);
    out = [];
    err = [];
  }

  const dreams = (): number => withHub((db) => (db.prepare("select count(*) c from memory_dreams").get() as { c: number }).c);

  it("refuses to send anything until a model is configured", async () => {
    await promoted();
    expect(await run(["memory", "dream"])).toBe(EXIT_USAGE);
    expect(stderr()).toContain("none is configured");
    expect(dreams()).toBe(0);
  });

  it("shows what would leave the machine without leaving the machine", async () => {
    await promoted();
    // A command that cannot exist: the dry run must not reach the spawn.
    configure(["cam-nincs-ilyen-parancs-xyz"]);

    expect(await run(["memory", "dream", "--dry-run"])).toBe(EXIT_OK);
    expect(stderr()).toContain("characters would go out");
    expect(stdout()).toContain("the first prompt");
    expect(stdout()).toContain("Invent nothing");
    expect(dreams()).toBe(0);
  });

  it("discloses the transfer even when told to be quiet", async () => {
    await promoted();
    configure(["cam-nincs-ilyen-parancs-xyz"]);
    expect(await run(["memory", "dream", "--dry-run", "--quiet"])).toBe(EXIT_OK);
    expect(stderr()).toContain("characters would go out");
  });

  it("writes a digest, names its author, and does not pay for it twice", async () => {
    await promoted();
    configure(STUB);

    expect(await run(["memory", "dream", "--json"])).toBe(EXIT_OK);
    const first = JSON.parse(stdout()) as { generated: number; cached: number; sentChars: number; model: string };
    expect(first.generated).toBeGreaterThan(0);
    expect(first.sentChars).toBeGreaterThan(0);
    expect(first.model).toBe("stub");
    expect(dreams()).toBe(first.generated);

    out = [];
    expect(await run(["memory", "dream", "--json"])).toBe(EXIT_OK);
    const second = JSON.parse(stdout()) as { generated: number; cached: number; sentChars: number };
    expect(second.generated).toBe(0);
    expect(second.cached).toBe(first.generated);
    expect(second.sentChars).toBe(0);

    out = [];
    expect(await run(["memory", "list"])).toBe(EXIT_OK);
    expect(stdout()).toContain("Álomszöveg");
    expect(stdout()).toContain("[stub]");
  });

  it("reports a model that fails instead of calling the run a success", async () => {
    await promoted();
    configure([process.execPath, "-e", "process.exit(3)"]);
    expect(await run(["memory", "dream"])).toBe(EXIT_FAILED);
    expect(stderr() + stdout()).toContain("exited with code 3");
    expect(dreams()).toBe(0);
  });

  it("drops every dream on request and leaves the promotions alone", async () => {
    await promoted();
    configure(STUB);
    expect(await run(["memory", "dream"])).toBe(EXIT_OK);
    expect(dreams()).toBeGreaterThan(0);

    out = [];
    err = [];
    expect(await run(["memory", "dream", "forget"])).toBe(EXIT_OK);
    expect(stdout()).toContain("dream(s) dropped");
    expect(dreams()).toBe(0);
    expect(withHub((db) => (db.prepare("select count(*) c from memory_facts").get() as { c: number }).c)).toBeGreaterThan(0);
  });
});

/**
 * Every command, once, through the same entry point a shell would use. The
 * point is coverage of the surface rather than of the behaviour — each command
 * has its own tests below and in the ops suite — so this checks that the
 * dispatch, the flag spec and the exit code line up for all of them.
 *
 * The list is compared against `SPECS`, so a command added later fails this
 * test until it is exercised here.
 */
describe("every command", () => {
  const CASES: Array<{ argv: string[]; exit?: number }> = [
    { argv: ["sync", "--tool", "codex"] },
    { argv: ["projects"] },
    { argv: ["projects", "--unattributed"] },
    { argv: ["timeline", "demo"] },
    { argv: ["dossier", "demo"] },
    { argv: ["recall", "arvizturo"] },
    { argv: ["get", `claude_code:${SID}`] },
    { argv: ["alias", "demo-mappa", "demo"] },
    { argv: ["attribute", `claude_code:${SID}`, "demo"] },
    { argv: ["reattribute"] },
    { argv: ["rebuild"] },
    { argv: ["memory", "status"] },
    { argv: ["memory", "dream", "--dry-run"] },
    { argv: ["status"] },
    { argv: ["doctor"] },
    { argv: ["prune", "--dry-run"] },
    { argv: ["forget", "--project", "masik"] },
    { argv: ["backup"] },
    // Dry runs only: these two are the commands that touch other people's
    // config files and the machine's scheduler. `--no-schedule` because even a
    // dry run asks the real scheduler who owns the jobs, and the answer on a
    // developer's own machine is not something a test may depend on.
    { argv: ["install", "--dry-run", "--no-schedule"] },
    { argv: ["uninstall", "--dry-run", "--no-schedule"] },
  ];

  it("covers the whole command surface", () => {
    const covered = new Set(CASES.map((c) => c.argv[0]!));
    expect([...covered].sort()).toEqual(Object.keys(SPECS).sort());
  });

  for (const c of CASES) {
    it(`runs: cam ${c.argv.join(" ")}`, async () => {
      await seed();
      out = [];
      err = [];
      expect(await run(c.argv)).toBe(c.exit ?? EXIT_OK);
      expect(stderr()).not.toContain("Unknown command");
      expect(stderr()).not.toContain("Usage:");
    });
  }

  it("accepts --json wherever it is offered", async () => {
    await seed();
    for (const argv of [
      ["projects", "--json"],
      ["timeline", "demo", "--json"],
      ["dossier", "demo", "--json"],
      ["recall", "arvizturo", "--json"],
      ["get", `claude_code:${SID}`, "--json"],
      ["memory", "list", "--json"],
      ["memory", "status", "--json"],
      ["memory", "topics", "--json"],
      ["status", "--json"],
      ["prune", "--dry-run", "--json"],
      ["forget", "--project", "masik", "--json"],
    ]) {
      out = [];
      expect(await run(argv), argv.join(" ")).toBe(EXIT_OK);
      expect(() => JSON.parse(stdout()) as unknown, argv.join(" ")).not.toThrow();
    }
  });
});

/**
 * `cam recall` prints citations, so something has to be able to open them. The
 * round trip is the test: take what recall printed, hand it back to get.
 */
describe("get", () => {
  it("opens the citation cam recall just printed", async () => {
    await seed();
    expect(await run(["recall", "arvizturo", "--json"])).toBe(EXIT_OK);
    const [hit] = JSON.parse(stdout()) as Array<{ citation: string }>;
    expect(hit).toBeDefined();

    out = [];
    expect(await run(["get", hit!.citation])).toBe(EXIT_OK);
    expect(stdout()).toContain("árvíztűrő");
    expect(stdout()).toMatch(/^\[\d+] (user|assistant):/m);
  });

  it("returns the whole session when the citation has no range", async () => {
    await seed();
    expect(await run(["get", `claude_code:${SID}`, "--json"])).toBe(EXIT_OK);
    const turns = JSON.parse(stdout()) as Array<{ seq: number; role: string; availability: string }>;
    expect(turns.length).toBe(2);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns.every((t) => t.availability === "ok")).toBe(true);
  });

  it("separates a malformed citation from one that simply is not there", async () => {
    await seed();
    expect(await run(["get", "ez-nem-hivatkozás"])).toBe(EXIT_USAGE);
    expect(stderr()).toContain("Unreadable citation");

    err = [];
    expect(await run(["get", "claude_code:00000000-0000-0000-0000-000000000000"])).toBe(EXIT_FAILED);
    expect(stderr()).toContain("No such session");
  });

  it("says which turn lost its source instead of dropping it", async () => {
    await seed();
    fs.rmSync(path.join(roots.claudeProjects, "C--work-demo", `${SID}.jsonl`));
    expect(await run(["get", `claude_code:${SID}`])).toBe(EXIT_OK);
    expect(stdout()).toContain("(missing)");
    expect(stdout()).toContain("[source missing]");
  });
});

describe("status", () => {
  it("admits that a never-synced index has no age", async () => {
    await seed();
    expect(await run(["status"])).toBe(EXIT_OK);
    expect(stdout()).toContain("no finished run yet");
  });

  it("reports the age of the last finished sync", async () => {
    await seed();
    withHub((db) =>
      db
        .prepare("insert into sync_runs(started_ms, ended_ms, turns_added) values (?,?,?)")
        .run(Date.now() - 70_000, Date.now() - 60_000, 4),
    );
    expect(await run(["status", "--json"])).toBe(EXIT_OK);
    const f = JSON.parse(stdout()) as { ageMs: number; stale: boolean; sessions: number };
    expect(f.ageMs).toBeGreaterThan(0);
    expect(f.stale).toBe(false);
    expect(f.sessions).toBe(2);
  });
});

describe("prune", () => {
  it("removes the old trace and the surplus run log, and says how much", async () => {
    await seed();
    const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
    withHub((db) => {
      const chunk = db.prepare("select id from chunks limit 1").get() as { id: number };
      for (let i = 0; i < 5; i++) {
        db.prepare("insert into recall_events(chunk_id, query_hash, score, ts_ms) values (?,?,?,?)").run(
          chunk.id,
          `h${i}`,
          0.9,
          old,
        );
      }
      for (let i = 0; i < 10; i++) {
        db.prepare("insert into sync_runs(started_ms, ended_ms) values (?,?)").run(old + i, old + i + 1);
      }
    });

    expect(await run(["prune", "--keep-runs", "2", "--json"])).toBe(EXIT_OK);
    const stat = JSON.parse(stdout()) as { recallEvents: number; syncRuns: number };
    expect(stat.recallEvents).toBe(5);
    expect(stat.syncRuns).toBe(8);
    expect(withHub((db) => db.prepare("select count(*) c from recall_events").get() as { c: number }).c).toBe(0);
  });

  it("reclaims the file's free space only when asked", async () => {
    await seed();
    expect(await run(["prune"])).toBe(EXIT_OK);
    expect(stdout()).toContain("--vacuum reclaims the space");

    out = [];
    expect(await run(["prune", "--vacuum"])).toBe(EXIT_OK);
    expect(stdout()).toMatch(/size: .* MB → .* MB/);
  });

  it("rejects a retention setting that is not a number", async () => {
    await seed();
    expect(await run(["prune", "--recall-days", "tegnap"])).toBe(EXIT_USAGE);
    expect(stderr()).toContain("--recall-days");
  });
});

describe("forget", () => {
  it("removes a project from the index and leaves the transcript on disk", async () => {
    await seed();
    const file = withHub(
      (db) =>
        db.prepare("select loc_path from turns join sessions s on s.id = turns.session_id where s.ext_id = ?").get(SID) as {
          loc_path: string;
        },
    ).loc_path;

    expect(await run(["forget", "--project", "demo"])).toBe(EXIT_OK);
    expect(stdout()).toContain("forgotten");
    expect(fs.existsSync(file)).toBe(true);

    out = [];
    expect(await run(["projects", "--json"])).toBe(EXIT_OK);
    expect((JSON.parse(stdout()) as Array<{ key: string }>).map((p) => p.key)).not.toContain("demo");
  });

  it("takes a session by the citation cam recall prints", async () => {
    await seed();
    expect(await run(["forget", `claude_code:${SID}`, "--json"])).toBe(EXIT_OK);
    expect((JSON.parse(stdout()) as { sessions: number }).sessions).toBe(1);
  });

  it("insists on exactly one target", async () => {
    await seed();
    expect(await run(["forget"])).toBe(EXIT_USAGE);
    expect(await run(["forget", "--project", "demo", "--session", "claude_code:x"])).toBe(EXIT_USAGE);
  });

  it("fails on something that is not in the index", async () => {
    await seed();
    expect(await run(["forget", "--project", "nincs-ilyen"])).toBe(EXIT_FAILED);
    expect(stderr()).toContain("No such project");
  });
});

describe("backup", () => {
  it("writes a verified copy that opens as a working index", async () => {
    await seed();
    const target = path.join(dir, "mentes.sqlite");
    expect(await run(["backup", target])).toBe(EXIT_OK);
    expect(stdout()).toContain(target);
    expect(fs.existsSync(target)).toBe(true);

    // The proof that it is a usable index and not just a file of the right size.
    out = [];
    expect(await run(["recall", "arvizturo", "--json", "--db", target])).toBe(EXIT_OK);
    expect((JSON.parse(stdout()) as unknown[]).length).toBeGreaterThan(0);
  });

  it("puts it in a dated file beside the index when not told where", async () => {
    await seed();
    expect(await run(["backup", "--json"])).toBe(EXIT_OK);
    const res = JSON.parse(stdout()) as { file: string; bytes: number; problems: string[] };
    expect(res.problems).toEqual([]);
    expect(res.bytes).toBeGreaterThan(0);
    expect(res.file).toContain("backups");
    expect(fs.existsSync(res.file)).toBe(true);
  });
});

/**
 * An unattended sync should be silent unless something went wrong — that is
 * what makes a nightly job's mail worth reading. What `--quiet` must never
 * suppress is the answer itself, or a failure.
 */
describe("output level", () => {
  it("says nothing on a clean quiet sync", async () => {
    expect(await run(["sync", "--tool", "codex", "--quiet"])).toBe(EXIT_OK);
    expect(stdout()).toBe("");
    expect(stderr()).toBe("");
  });

  it("still reports the failure that made the exit code non-zero", async () => {
    fs.mkdirSync(path.dirname(roots.codexStateDb), { recursive: true });
    fs.writeFileSync(roots.codexStateDb, "ez nem sqlite fájl");
    expect(await run(["sync", "--tool", "codex", "--quiet"])).toBe(EXIT_FAILED);
    expect(stdout()).toBe("");
    expect(stderr()).toContain("error");
  });

  it("never swallows the answer, which is what the command was run for", async () => {
    await seed();
    expect(await run(["recall", "arvizturo", "--json", "--quiet"])).toBe(EXIT_OK);
    expect((JSON.parse(stdout()) as unknown[]).length).toBeGreaterThan(0);
  });

  it("adds per-phase detail under --verbose", async () => {
    expect(await run(["sync", "--tool", "codex", "--verbose"])).toBe(EXIT_OK);
    expect(stdout()).toContain("attribution");
    expect(stdout()).toContain("path-cache");
  });

  it("does not carry a level over to the next command", async () => {
    await seed();
    expect(await run(["projects", "--quiet"])).toBe(EXIT_OK);
    out = [];
    expect(await run(["projects"])).toBe(EXIT_OK);
    expect(stdout()).toContain("with no project");
  });

  it("refuses to be both quiet and verbose", async () => {
    expect(await run(["projects", "--quiet", "--verbose"])).toBe(EXIT_USAGE);
  });
});

describe("doctor", () => {
  it("reports a healthy hub", async () => {
    await seed();
    expect(await run(["doctor"])).toBe(EXIT_OK);
    expect(stdout()).toContain("integrity         ok");
    expect(stdout()).toContain("fts: ok");
  });

  it("diagnoses a damaged file instead of throwing a stack trace", async () => {
    fs.writeFileSync(dbPath, "SQLite format 3 ez nem az\u0000" + "x".repeat(4096));
    expect(await run(["doctor"])).toBe(EXIT_FAILED);
    expect(stderr()).toMatch(/corrupt|cannot be opened/);
    expect(stderr()).not.toContain("at Object.");
  });

  it("points at rebuild when the text index is empty but chunks exist", async () => {
    await seed();
    withHub((db) => db.exec("insert into chunks_fts(chunks_fts) values('delete-all')"));
    expect(await run(["doctor"])).toBe(EXIT_FAILED);
    expect(stdout()).toContain("cam rebuild");
  });
});

describe("rebuild", () => {
  it("puts a wiped text index back from the sources", async () => {
    await seed();
    withHub((db) => db.exec("insert into chunks_fts(chunks_fts) values('delete-all')"));
    expect(await run(["recall", "--json", "arvizturo"])).toBe(EXIT_OK);
    expect(JSON.parse(stdout())).toHaveLength(0);

    out = [];
    expect(await run(["rebuild"])).toBe(EXIT_OK);
    expect(stdout()).toContain("reindexed");

    out = [];
    expect(await run(["recall", "--json", "arvizturo"])).toBe(EXIT_OK);
    expect((JSON.parse(stdout()) as unknown[]).length).toBeGreaterThan(0);
  });

  it("survives a dropped FTS table, which no content table could rebuild", async () => {
    await seed();
    withHub((db) => db.exec("drop table chunks_fts"));
    expect(await run(["rebuild"])).toBe(EXIT_OK);
    out = [];
    expect(await run(["recall", "--json", "arvizturo"])).toBe(EXIT_OK);
    expect((JSON.parse(stdout()) as unknown[]).length).toBeGreaterThan(0);
  });

  it("leaves a chunk out of the index when its source is gone, and says so", async () => {
    await seed();
    const p = withHub((db) => db.prepare("select distinct loc_path from turns").get()) as { loc_path: string };
    fs.rmSync(p.loc_path);
    expect(await run(["rebuild"])).toBe(EXIT_OK);
    expect(stdout()).toMatch(/missing: [1-9]/);
    // The turns learned about it, so a later query is honest about the gap.
    const missing = withHub(
      (db) => db.prepare("select count(*) c from turns where availability = 'missing'").get() as { c: number },
    );
    expect(missing.c).toBeGreaterThan(0);
  });
});
