import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bodyIsCurrent, fetchDevinCascade, isDevinCliSession } from "../src/sources/devin-fetch.js";
import { DaemonSession } from "../src/sources/language-server.js";
import { devinCascadeCollector } from "../src/collectors/devin-cascade.js";
import { devinCliCollector } from "../src/collectors/devin-cli.js";
import { Hydrator, type TurnRow } from "../src/index/hydrate.js";
import { makeHarness, type Harness } from "./helpers/fixtures.js";
import { branchedSession, writeDevinStore } from "./helpers/devin-fixture.js";
import { cascadeTrajectory, writeCascadePb } from "./helpers/cascade.js";
import { fakeLanguageServers } from "./helpers/daemon.js";
import { WINDSURF_CSRF_ENV } from "../src/sources/process-env.js";

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

const CID = "aaaaaaaa-1111-2222-3333-444444444444";

const dir = () => path.join(h.roots.windsurfHome, "cascade");

const daemonRunning = (respond: (url: string) => { ok: boolean; status: number; text: string }) => {
  const run = fakeLanguageServers([
    {
      pid: 7,
      commandLine: "language_server_windows_x64.exe --parent_pipe_path \\\\.\\pipe\\s",
      ports: [56027, 56026],
    },
  ]);
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url.slice(url.lastIndexOf("/") + 1));
    const r = respond(url);
    return { ok: r.ok, status: r.status, text: async () => r.text };
  }) as unknown as typeof globalThis.fetch;
  const envOf = (pid: number, name: string) =>
    pid === 7 && name === WINDSURF_CSRF_ENV ? "env-tok" : null;
  return { run, fetchImpl, calls, envOf };
};

const answerWith = (doc: unknown) => (_url: string) =>
  _url.endsWith("GetCascadeTrajectory")
    ? { ok: true, status: 200, text: JSON.stringify(doc) }
    : { ok: true, status: 200, text: "{}" };

const turnsOf = (extId: string) =>
  h.hub
    .prepare(
      "select t.* from turns t join sessions s on s.id = t.session_id where s.ext_id = ? order by t.seq",
    )
    .all(extId) as TurnRow[];

describe("fetching one Devin cascade conversation", () => {
  it("inserts a session that the metadata pass never saw", async () => {
    const { run, fetchImpl, envOf } = daemonRunning(answerWith(cascadeTrajectory(CID, "Hol tartunk?", "Itt.")));
    const outcome = await fetchDevinCascade(h.hub, CID, {
      session: new DaemonSession({ run, fetchImpl, envOf }),
      cascadeDir: dir(),
      fetchImpl,
    });
    expect(outcome).toEqual({ status: "fetched", turns: 2, steps: 3 });

    const hy = new Hydrator(h.hub);
    expect(turnsOf(CID).map((t) => hy.resolve(t).text)).toEqual(["Hol tartunk?", "Itt."]);
    hy.close();
    expect(turnsOf(CID).every((r) => r.locator_kind === "inline")).toBe(true);
  });

  it("asks once, then never again while the .pb file has not moved", async () => {
    writeCascadePb(h.roots, CID);
    const first = daemonRunning(answerWith(cascadeTrajectory(CID, "kérdés", "válasz")));
    await fetchDevinCascade(h.hub, CID, {
      session: new DaemonSession({ run: first.run, fetchImpl: first.fetchImpl, envOf: first.envOf }),
      cascadeDir: dir(),
      fetchImpl: first.fetchImpl,
    });
    expect(bodyIsCurrent(h.hub, CID, dir())).toBe(true);

    const second = daemonRunning(answerWith(cascadeTrajectory(CID, "kérdés", "válasz")));
    const outcome = await fetchDevinCascade(h.hub, CID, {
      session: new DaemonSession({ run: second.run, fetchImpl: second.fetchImpl, envOf: second.envOf }),
      cascadeDir: dir(),
      fetchImpl: second.fetchImpl,
    });
    expect(outcome).toEqual({ status: "cached", turns: 2 });
    expect(second.calls).toEqual([]);
  });

  it("says Devin is closed rather than treating it as a failure", async () => {
    const session = new DaemonSession({
      run: fakeLanguageServers([]),
      fetchImpl: (async () => {
        throw new Error("must not be called");
      }) as unknown as typeof globalThis.fetch,
    });
    expect(await fetchDevinCascade(h.hub, CID, { session, cascadeDir: dir() })).toEqual({
      status: "no-daemon",
    });
  });

  it("leaves a Devin CLI session alone", async () => {
    const { session, nodes } = branchedSession(CID, "D:/work/demo");
    writeDevinStore(h.roots, [session], { [CID]: nodes });
    await devinCliCollector.sync(h.ctx);
    expect(isDevinCliSession(h.hub, CID)).toBe(true);

    const { run, fetchImpl, envOf, calls } = daemonRunning(answerWith(cascadeTrajectory(CID, "x", "y")));
    const outcome = await fetchDevinCascade(h.hub, CID, {
      session: new DaemonSession({ run, fetchImpl, envOf }),
      cascadeDir: dir(),
      fetchImpl,
    });
    expect(outcome).toEqual({ status: "cli-session" });
    expect(calls).toEqual([]);
  });
});

describe("devin cascade collector", () => {
  it("records the filename and does not read the bytes", async () => {
    writeCascadePb(h.roots, CID, Buffer.from("not-a-trajectory"));
    writeCascadePb(h.roots, "bbbbbbbb-1111-2222-3333-555555555555");
    fs.writeFileSync(path.join(dir(), "notes.pb"), "not a cascade id");
    const stat = await devinCascadeCollector.sync(h.ctx);
    expect(stat.sessions).toBe(2);
    const row = h.hub.prepare("select ext_id, turn_count from sessions where tool = 'devin'").all() as Array<{
      ext_id: string;
      turn_count: number;
    }>;
    expect(row.every((r) => r.turn_count === 0)).toBe(true);
    expect(row.map((r) => r.ext_id).sort()).toEqual([CID, "bbbbbbbb-1111-2222-3333-555555555555"]);
  });

  it("skips a file that is already a CLI session", async () => {
    const { session, nodes } = branchedSession(CID, "D:/work/demo");
    writeDevinStore(h.roots, [session], { [CID]: nodes });
    await devinCliCollector.sync(h.ctx);
    writeCascadePb(h.roots, CID);
    const stat = await devinCascadeCollector.sync(h.ctx);
    expect(stat.skipped).toBe(1);
    expect(
      (h.hub.prepare("select turn_count from sessions where tool = 'devin' and ext_id = ?").get(CID) as { turn_count: number })
        .turn_count,
    ).toBeGreaterThan(0);
  });

  it("skips an unchanged file on the next pass", async () => {
    writeCascadePb(h.roots, CID);
    expect((await devinCascadeCollector.sync(h.ctx)).sessions).toBe(1);
    expect((await devinCascadeCollector.sync(h.ctx)).skipped).toBe(1);
  });
});
