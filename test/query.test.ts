import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { claudeCodeCollector } from "../src/collectors/claude-code.js";
import { collectCwdEvidence, learnRoots, reattribute } from "../src/attribution/resolve.js";
import { dossier, listProjects, timeline } from "../src/query/dossier.js";
import { getTurns, recall } from "../src/query/recall.js";
import { excerpt, highlight, parseQuery } from "../src/search/keywords.js";
import { formatDossier, formatRecall } from "../src/query/format.js";
import { jline, makeHarness, writeTranscript, type Harness } from "./helpers/fixtures.js";

let h: Harness;

const SID = "11111111-2222-3333-4444-555555555555";
const SID2 = "22222222-3333-4444-5555-666666666666";

async function seed(): Promise<void> {
  writeTranscript(h.roots, "C--work-demo", SID, [
    { type: "ai-title", sessionId: SID, title: "Árvíztűrő teszt" },
    {
      type: "user",
      sessionId: SID,
      cwd: "C:\\work\\demo",
      timestamp: "2026-08-01T10:00:00.000Z",
      message: { content: "Hogyan javítsuk a projektben a tükörfúrógép hibát?" },
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
  h.hub
    .prepare("insert or replace into projects(key, display_name, root_path) values ('demo','demo','c:/work/demo')")
    .run();
  h.hub
    .prepare("insert or replace into projects(key, display_name, root_path) values ('masik','masik','c:/work/masik')")
    .run();
  reattribute(h.hub);
}

beforeEach(async () => {
  h = makeHarness();
  await seed();
});
afterEach(() => h.cleanup());

describe("parseQuery", () => {
  it("drops stopwords and keeps meaningful terms", () => {
    const q = parseQuery("hogyan javítsuk a tükörfúrógép hibát");
    expect(q.terms).toContain("tükörfúrógép");
    expect(q.terms).not.toContain("hogyan");
  });

  it("uses prefix matching for long tokens, exact for short ones", () => {
    const q = parseQuery("projekt fix");
    expect(q.match).toContain('"projekt"*');
    expect(q.match).toContain('"fix"');
    expect(q.match).not.toContain('"fix"*');
  });

  it("turns a date word into a time bound and drops it from the terms", () => {
    const now = Date.parse("2026-08-10T12:00:00.000Z");
    const q = parseQuery("tegnap docker", now);
    expect(q.sinceMs).not.toBeNull();
    expect(q.terms).toEqual(["docker"]);
  });

  it("still searches when the query is only stopwords", () => {
    expect(parseQuery("a hogy van").match.length).toBeGreaterThan(0);
  });

  it("cannot be broken out of by FTS syntax in the query", () => {
    // The tokenizer keeps only word-like segments, so quotes, operators and
    // column filters never reach the MATCH expression at all.
    // The whole expression must be nothing but quoted terms joined by OR.
    const SAFE = /^"(?:[^"]|"")*"\*?(?: OR "(?:[^"]|"")*"\*?)*$/;
    for (const evil of ['foo" OR "bar', 'x" AND chunks_fts MATCH "y', "a: b* NEAR/2 c", '"'.repeat(20)]) {
      const q = parseQuery(evil);
      if (q.match.length > 0) expect(q.match).toMatch(SAFE);
      expect(() => recall(h.hub, { query: evil })).not.toThrow();
    }
  });
});

describe("highlight and excerpt", () => {
  it("marks accent-insensitively and extends over the whole word", () => {
    expect(highlight("Az árvíztűrő tükörfúrógép", ["arvizturo"])).toContain("«árvíztűrő»");
  });
  it("returns the text untouched when nothing matches", () => {
    expect(highlight("semmi", ["xyz"])).toBe("semmi");
  });

  it("does not drift when accents precede the match", () => {
    // Folding must preserve length: é is one character, not e + combining mark,
    // or every offset after it would be wrong.
    expect(highlight("Hozzáadunk hibakezelést a témagenerálásához", ["témagenerálás"])).toBe(
      "Hozzáadunk hibakezelést a «témagenerálásához»",
    );
    expect(highlight("őőő célszó", ["celszo"])).toBe("őőő «célszó»");
  });

  it("marks every occurrence, not just the first", () => {
    expect(highlight("alma és alma", ["alma"])).toBe("«alma» és «alma»");
  });
  it("cuts a window around the first match", () => {
    const long = "eleje ".repeat(100) + "CÉLSZÓ" + " vége".repeat(100);
    const e = excerpt(long, ["célszó"], 80);
    expect(e).toContain("CÉLSZÓ");
    expect(e.length).toBeLessThan(120);
  });
});

describe("recall", () => {
  it("finds a hit without accents and cites it", () => {
    const hits = recall(h.hub, { query: "arvizturo" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.citation).toMatch(/^claude_code:.*#seq\d+-\d+$/);
    expect(hits[0]!.snippet).toContain("«");
    expect(hits[0]!.availability).toBe("ok");
    expect(hits[0]!.project).toBe("demo");
  });

  it("matches an agglutinated form by prefix", () => {
    expect(recall(h.hub, { query: "projekt" })).not.toHaveLength(0);
  });

  it("filters by project", () => {
    expect(recall(h.hub, { query: "migráció", project: "masik" })).toHaveLength(1);
    expect(recall(h.hub, { query: "migráció", project: "demo" })).toHaveLength(0);
  });

  it("filters by tool and by time", () => {
    expect(recall(h.hub, { query: "arvizturo", tool: "codex" })).toHaveLength(0);
    expect(recall(h.hub, { query: "arvizturo", sinceMs: Date.parse("2026-09-01") })).toHaveLength(0);
  });

  it("respects the limit", () => {
    expect(recall(h.hub, { query: "a", limit: 1 }).length).toBeLessThanOrEqual(1);
  });

  it("logs what it surfaced, so a memory layer has something to promote later", () => {
    recall(h.hub, { query: "arvizturo" });
    const n = h.hub.prepare("select count(*) c from recall_events").get() as { c: number };
    expect(n.c).toBeGreaterThan(0);
  });

  it("reports a vanished source instead of hiding the hit", () => {
    const p = h.hub.prepare("select distinct loc_path from turns").get() as { loc_path: string };
    fs.rmSync(p.loc_path);
    const hits = recall(h.hub, { query: "arvizturo" });
    expect(hits[0]!.availability).toBe("missing");
    expect(hits[0]!.snippet).toContain("source missing");
  });

  it("returns nothing for an empty query rather than everything", () => {
    expect(recall(h.hub, { query: "   " })).toEqual([]);
  });
});

describe("recall confidence", () => {
  /** Push one session's verdict down to a given confidence. */
  const setConfidence = (extId: string, confidence: string, attributed: boolean): void => {
    const s = h.hub.prepare("select id from sessions where ext_id = ?").get(extId) as { id: number };
    h.hub.prepare("update attribution set confidence = ?, method = 'time_correlation' where session_id = ?").run(
      confidence,
      s.id,
    );
    if (!attributed) {
      h.hub.prepare("update attribution set project_id = null, confidence = 'none', method = 'unattributed' where session_id = ?").run(s.id);
      h.hub.prepare("update sessions set project_id = null where id = ?").run(s.id);
      h.hub.prepare("update chunks set project_id = null where session_id = ?").run(s.id);
    }
  };

  it("hides a weak hit by default but keeps an unattributed one", () => {
    // The rule that surprises people most: 'weak' means we guessed and are not
    // sure, 'none' means we did not guess at all — and only the guess is hidden.
    setConfidence(SID, "weak", true);
    expect(recall(h.hub, { query: "arvizturo" })).toHaveLength(0);
    expect(recall(h.hub, { query: "arvizturo", minConfidence: "weak" })).toHaveLength(1);

    setConfidence(SID, "none", false);
    const hits = recall(h.hub, { query: "arvizturo" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ confidence: "none", project: null });
  });

  it("applies the floor without exception once a project is named", () => {
    setConfidence(SID, "weak", true);
    expect(recall(h.hub, { query: "arvizturo", project: "demo" })).toHaveLength(0);
    expect(recall(h.hub, { query: "arvizturo", project: "demo", minConfidence: "weak" })).toHaveLength(1);
  });

  it("keeps a medium hit, which is the default floor", () => {
    setConfidence(SID, "medium", true);
    expect(recall(h.hub, { query: "arvizturo" })).toHaveLength(1);
    expect(recall(h.hub, { query: "arvizturo", project: "demo" })).toHaveLength(1);
  });
});

describe("a source that changed under us", () => {
  it("reports the hit as stale and shows what the source says now", () => {
    const row = h.hub.prepare("select loc_path from turns where seq = 1").get() as { loc_path: string };
    // Same byte length, different text: the locator still resolves, the hash
    // no longer matches. This is the 'stale' path end to end.
    const before = fs.readFileSync(row.loc_path, "utf8");
    expect(before).toContain("docker-compose");
    fs.writeFileSync(row.loc_path, before.replace("docker-compose", "docker-kompoze"), "utf8");

    const hits = recall(h.hub, { query: "arvizturo" });
    expect(hits[0]!.availability).toBe("stale");
    expect(hits[0]!.snippet).toContain("docker-kompoze");
    expect(formatRecall(hits, "arvizturo")).toContain("source changed");

    // What we learned at read time is written back, so doctor can count it.
    const t = h.hub.prepare("select count(*) c from turns where availability = 'stale'").get() as { c: number };
    expect(t.c).toBeGreaterThan(0);
  });

  it("goes back to ok once the source matches again", () => {
    const row = h.hub.prepare("select loc_path from turns where seq = 1").get() as { loc_path: string };
    const before = fs.readFileSync(row.loc_path, "utf8");
    fs.writeFileSync(row.loc_path, before.replace("docker-compose", "docker-kompoze"), "utf8");
    expect(recall(h.hub, { query: "arvizturo" })[0]!.availability).toBe("stale");
    fs.writeFileSync(row.loc_path, before, "utf8");
    expect(recall(h.hub, { query: "arvizturo" })[0]!.availability).toBe("ok");
  });
});

describe("getTurns", () => {
  it("expands a session range", () => {
    const turns = getTurns(h.hub, "claude_code", SID, 0, 5);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.role).toBe("user");
    expect(turns[1]!.text).toContain("árvíztűrő");
  });
  it("returns nothing for an unknown session", () => {
    expect(getTurns(h.hub, "codex", "nope")).toEqual([]);
  });
});

describe("timeline and dossier", () => {
  it("lists sessions in time order with their attribution", () => {
    const t = timeline(h.hub, { project: "demo" });
    expect(t).toHaveLength(1);
    expect(t[0]!.confidence).toBe("strong");
    expect(t[0]!.method).toBe("cwd");
    expect(t[0]!.title).toBe("Árvíztűrő teszt");
  });

  it("hides subagents unless asked", async () => {
    const subDir = path.join(h.roots.claudeProjects, "C--work-demo", SID, "subagents");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, "agent-x.jsonl"),
      jline({
        type: "assistant",
        sessionId: "agent-x",
        cwd: "C:\\work\\demo",
        timestamp: "2026-08-01T10:01:00.000Z",
        message: { content: "alügynök" },
      }),
      "utf8",
    );
    await claudeCodeCollector.sync(h.ctx);
    collectCwdEvidence(h.hub);
    reattribute(h.hub);

    expect(timeline(h.hub, { project: "demo" })).toHaveLength(1);
    expect(timeline(h.hub, { project: "demo", includeSubagents: true })).toHaveLength(2);
  });

  it("summarizes a project", () => {
    const d = dossier(h.hub, "demo")!;
    expect(d.project).toBe("demo");
    expect(d.totals.turns).toBe(2);
    expect(d.byTool[0]!.tool).toBe("claude_code");
    expect(d.attribution.strong).toBe(1);
    expect(formatDossier(d)).toContain("# demo");
  });

  it("returns null for an unknown project", () => {
    expect(dossier(h.hub, "nincs-ilyen")).toBeNull();
  });

  it("lists projects by size", () => {
    const p = listProjects(h.hub);
    expect(p.map((x) => x.key).sort()).toEqual(["demo", "masik"]);
  });

  it("renders an empty result honestly", () => {
    expect(formatRecall([], "semmi")).toContain("No hits");
  });
});
