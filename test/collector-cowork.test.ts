import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coworkCollector } from "../src/collectors/cowork.js";
import { claudeDesktopCollector } from "../src/collectors/claude-desktop.js";
import { claudeCodeCollector } from "../src/collectors/claude-code.js";
import { artifactsCollector } from "../src/collectors/artifacts.js";
import { jline, makeHarness, realisticRecords, writeTranscript, type Harness } from "./helpers/fixtures.js";

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

const ACCT = "bb10755c-08bc-4e6b-8eae-e2b1da6c34a7";
const ORG = "89be31e7-42ae-49f5-b8e5-2e202829781d";
const SID = "local_2195e936-3541-40a0-bd94-26f8d46e02e2";
const CLI = "43959a73-0cbc-4e7c-9f8e-6c4189910373";

function writeCowork(opts: {
  folders?: string[];
  withTranscript?: boolean;
  initialMessage?: string;
  outputs?: Array<[string, string]>;
}): void {
  const dir = path.join(h.roots.coworkSessions, ACCT, ORG);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${SID}.json`),
    JSON.stringify({
      sessionId: SID,
      cliSessionId: CLI,
      // Inside the sandbox the working directory is a generated name.
      cwd: "/sessions/happy-great-cray",
      userSelectedFolders: opts.folders ?? ["C:\\work\\demo"],
      initialMessage: opts.initialMessage ?? "Nézd meg a projektet és írj összefoglalót",
      model: "claude-opus-5",
      createdAt: 1_776_268_565_664,
      lastActivityAt: 1_776_270_000_000,
    }),
    "utf8",
  );

  if (opts.withTranscript !== false) {
    const tdir = path.join(dir, SID, ".claude", "projects", "-sessions-happy-great-cray");
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(
      path.join(tdir, `${CLI}.jsonl`),
      [
        {
          type: "user",
          sessionId: CLI,
          cwd: "/sessions/happy-great-cray",
          timestamp: "2026-04-15T16:00:00.000Z",
          message: { content: "Cowork kérdés a projektről" },
        },
        {
          type: "assistant",
          sessionId: CLI,
          timestamp: "2026-04-15T16:00:10.000Z",
          message: { content: [{ type: "text", text: "Cowork válasz" }] },
        },
      ]
        .map(jline)
        .join(""),
      "utf8",
    );
  }

  for (const [name, body] of opts.outputs ?? []) {
    const odir = path.join(dir, SID, "outputs");
    fs.mkdirSync(odir, { recursive: true });
    fs.writeFileSync(path.join(odir, name), body, "utf8");
  }
}

const sessions = () =>
  h.hub.prepare("select * from sessions order by tool, ext_id").all() as Array<{
    id: number;
    tool: string;
    ext_id: string;
    title: string | null;
    title_origin: string | null;
    cwd_norm: string | null;
    turn_count: number;
  }>;

describe("cowork collector", () => {
  it("indexes the transcript and titles the session from its opening message", async () => {
    writeCowork({});
    const stat = await coworkCollector.sync(h.ctx);
    expect(stat).toMatchObject({ sessions: 1, turns: 2, errors: 0 });
    const s = sessions()[0]!;
    expect(s.tool).toBe("cowork");
    expect(s.title).toBe("Nézd meg a projektet és írj összefoglalót");
    expect(s.turn_count).toBe(2);
  });

  it("takes the project from the selected folders, never the sandbox path", async () => {
    writeCowork({ folders: ["C:\\work\\demo", "C:\\work\\other"] });
    await coworkCollector.sync(h.ctx);

    const s = sessions()[0]!;
    // The sandbox cwd must not become a project signal.
    expect(s.cwd_norm).toBeNull();

    const ev = h.hub.prepare("select origin, raw_path, weight from path_evidence order by origin, raw_path").all() as
      Array<{ origin: string; raw_path: string; weight: number }>;
    const folders = ev.filter((e) => e.origin === "user_selected_folders");
    expect(folders.map((f) => f.raw_path)).toEqual(["c:/work/demo", "c:/work/other"]);
    expect(folders.every((f) => f.weight === 3)).toBe(true);
    // recorded, but weightless
    expect(ev.find((e) => e.origin === "sandbox_cwd")?.weight).toBe(0);
  });

  it("keeps a session with no transcript on the timeline", async () => {
    writeCowork({ withTranscript: false });
    const stat = await coworkCollector.sync(h.ctx);
    expect(stat.skipped).toBe(1);
    const s = sessions()[0]!;
    expect(s.turn_count).toBe(0);
    expect(s.title).toBeTruthy();
  });

  it("skips an unchanged session on the next run", async () => {
    writeCowork({});
    await coworkCollector.sync(h.ctx);
    expect(await coworkCollector.sync(h.ctx)).toMatchObject({ sessions: 0, turns: 0 });
  });

  it("does nothing when Cowork is not installed", async () => {
    fs.rmSync(h.roots.coworkSessions, { recursive: true, force: true });
    expect(await coworkCollector.sync(h.ctx)).toMatchObject({ sessions: 0, turns: 0, errors: 0 });
  });
});

describe("claude desktop collector", () => {
  function writeDesktop(cliSessionId: string, title: string): void {
    const dir = path.join(h.roots.desktopSessions, ACCT, ORG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `local_${cliSessionId}.json`),
      JSON.stringify({
        sessionId: `local_${cliSessionId}`,
        cliSessionId,
        cwd: "C:\\work\\demo",
        title,
        model: "claude-sonnet-4-6",
        completedTurns: 13,
        createdAt: 1_773_407_611_217,
        lastActivityAt: 1_773_413_456_194,
      }),
      "utf8",
    );
  }

  it("gives a title to a transcript that has none", async () => {
    const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    writeTranscript(h.roots, "C--work-demo", sid, [
      {
        type: "user",
        sessionId: sid,
        cwd: "C:\\work\\demo",
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { content: "cím nélküli session" },
      },
    ]);
    await claudeCodeCollector.sync(h.ctx);
    expect(sessions()[0]!.title).toBeNull();

    writeDesktop(sid, "Komplex workflow bemutató");
    const stat = await claudeDesktopCollector.sync(h.ctx);
    expect(stat.skipped).toBe(1); // enrichment, not a new session

    const s = sessions()[0]!;
    expect(s.title).toBe("Komplex workflow bemutató");
    expect(s.title_origin).toBe("desktop_index");
  });

  it("never overwrites a title the transcript itself carries", async () => {
    const sid = "11111111-2222-3333-4444-555555555555";
    writeTranscript(h.roots, "C--work-demo", sid, realisticRecords("C:\\work\\demo", sid));
    await claudeCodeCollector.sync(h.ctx);
    expect(sessions()[0]!.title).toBe("Kézi cím");

    writeDesktop(sid, "Desktop cím");
    await claudeDesktopCollector.sync(h.ctx);
    expect(sessions()[0]!.title).toBe("Kézi cím");
  });

  it("records a desktop session whose transcript is gone", async () => {
    writeDesktop("nincs-ilyen-transcript", "Elveszett beszélgetés");
    const stat = await claudeDesktopCollector.sync(h.ctx);
    expect(stat.sessions).toBe(1);
    const s = sessions()[0]!;
    expect(s.tool).toBe("claude_desktop");
    expect(s.turn_count).toBe(0);
    expect(s.cwd_norm).toBe("c:/work/demo");
  });

  it("does nothing when Claude Desktop is not installed", async () => {
    fs.rmSync(h.roots.desktopSessions, { recursive: true, force: true });
    expect(await claudeDesktopCollector.sync(h.ctx)).toMatchObject({ sessions: 0, turns: 0, errors: 0 });
  });
});

describe("artifacts collector", () => {
  it("copies volatile scratchpad files and references stable plans", async () => {
    const sid = "11111111-2222-3333-4444-555555555555";
    writeTranscript(h.roots, "C--work-demo", sid, realisticRecords("C:\\work\\demo", sid));
    await claudeCodeCollector.sync(h.ctx);

    const scratch = path.join(h.roots.claudeTemp, "C--work-demo", sid, "scratchpad");
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, "notes.md"), "átmeneti jegyzet", "utf8");
    const tasks = path.join(h.roots.claudeTemp, "C--work-demo", sid, "tasks");
    fs.mkdirSync(tasks, { recursive: true });
    fs.writeFileSync(path.join(tasks, "b1.output"), "alügynök kimenet", "utf8");

    fs.mkdirSync(h.roots.claudePlans, { recursive: true });
    fs.writeFileSync(path.join(h.roots.claudePlans, "terv-steady-bear.md"), "# Terv\n\nrészletek", "utf8");

    await artifactsCollector.sync(h.ctx);

    const rows = h.hub.prepare("select kind, path, inline_text, sha256, session_id from artifacts order by kind").all() as
      Array<{ kind: string; path: string; inline_text: string | null; sha256: string | null; session_id: number | null }>;
    const byKind = new Map(rows.map((r) => [r.kind, r]));

    // Temp is reaped by the OS, so its content is copied.
    expect(byKind.get("scratchpad")!.inline_text).toBe("átmeneti jegyzet");
    expect(byKind.get("subagent_output")!.inline_text).toBe("alügynök kimenet");
    // A plan lives in the user's own home: referenced, not copied.
    expect(byKind.get("plan")!.inline_text).toBeNull();
    expect(byKind.get("plan")!.sha256).toBeTruthy();
    // The session id in the temp path links the artifact to its conversation.
    expect(byKind.get("scratchpad")!.session_id).toBeTruthy();
  });

  it("attaches a plan to the session whose transcript mentions its filename", async () => {
    const sid = "11111111-2222-3333-4444-555555555555";
    writeTranscript(h.roots, "C--work-demo", sid, [
      {
        type: "user",
        sessionId: sid,
        cwd: "C:\\work\\demo",
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { content: "a terv a plans/terv-steady-bear.md fájlban van" },
      },
    ]);
    await claudeCodeCollector.sync(h.ctx);

    fs.mkdirSync(h.roots.claudePlans, { recursive: true });
    fs.writeFileSync(path.join(h.roots.claudePlans, "terv-steady-bear.md"), "# Terv", "utf8");
    await artifactsCollector.sync(h.ctx);

    const plan = h.hub.prepare("select session_id from artifacts where kind = 'plan'").get() as {
      session_id: number | null;
    };
    expect(plan.session_id).not.toBeNull();
  });

  it("collects Cowork deliverables", async () => {
    writeCowork({ outputs: [["osszefoglalo.md", "# Kész anyag"]] });
    await coworkCollector.sync(h.ctx);
    await artifactsCollector.sync(h.ctx);

    const out = h.hub.prepare("select * from artifacts where kind = 'cowork_output'").get() as {
      inline_text: string;
      session_id: number | null;
    };
    expect(out.inline_text).toBe("# Kész anyag");
    expect(out.session_id).not.toBeNull();
  });

  it("does nothing when no store is present", async () => {
    expect(await artifactsCollector.sync(h.ctx)).toMatchObject({ errors: 0 });
  });

  it("reports a plans directory it cannot read", async () => {
    // Present but unlistable. A file in the directory's place produces ENOTDIR
    // on every platform, which chmod would not on Windows.
    fs.rmSync(h.roots.claudePlans, { recursive: true, force: true });
    fs.writeFileSync(h.roots.claudePlans, "nem mappa", "utf8");

    const stat = await artifactsCollector.sync(h.ctx);

    // Counted rather than swallowed, so `cam sync` says so instead of quietly
    // reporting that there are no plans.
    expect(stat.errors).toBe(1);
    expect(h.logs.some((l) => l.includes("unreadable"))).toBe(true);
  });
});
