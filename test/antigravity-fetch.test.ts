import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bodyIsCurrent, fetchConversation } from "../src/sources/antigravity-fetch.js";
import { DaemonSession } from "../src/sources/language-server.js";
import { antigravityCollector } from "../src/collectors/antigravity.js";
import { Hydrator, type TurnRow } from "../src/index/hydrate.js";
import { makeHarness, type Harness } from "./helpers/fixtures.js";
import { writeSummaries, type Summary } from "./helpers/antigravity-fixture.js";

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

const CID = "aaaaaaaa-1111-2222-3333-444444444444";

const SUMMARY: Summary = {
  conversation_id: CID,
  preview: "Demo eszköz fejlesztése",
  step_count: 110,
  last_modified_time: "2026-07-02 14:39:06.8014141+00:00",
  workspace_uris: JSON.stringify(["file:///D:/work/demo"]),
};

/** A trajectory as the daemon returns it: mostly steps that are not speech. */
const trajectory = (userText: string, assistantText: string) => ({
  trajectory: {
    trajectoryId: "bbbbbbbb-1111-2222-3333-555555555555",
    cascadeId: CID,
    metadata: {
      createdAt: "2026-07-02T14:00:45.438063200Z",
      workspaces: [{ workspaceFolderAbsoluteUri: "file:///D:/work/demo" }],
    },
    steps: [
      {
        type: "CORTEX_STEP_TYPE_USER_INPUT",
        metadata: { createdAt: "2026-07-02T14:02:04.817881200Z" },
        userInput: { items: [{ text: userText }] },
      },
      {
        type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        metadata: { createdAt: "2026-07-02T14:02:05.000000000Z" },
        plannerResponse: { thinking: "belső gondolatmenet", toolCalls: [{ name: "view_file" }] },
      },
      {
        type: "CORTEX_STEP_TYPE_NOTIFY_USER",
        metadata: { createdAt: "2026-07-02T14:22:17.873178800Z" },
        notifyUser: { notificationContent: assistantText },
      },
    ],
  },
});

/** A machine with one language server on port 55027. */
const daemonRunning = (respond: (method: string) => { ok: boolean; status: number; text: string }) => {
  const run = ((_cmd: string, args: string[]) => {
    const script = args.join(" ");
    if (script.includes("Win32_Process") || script.includes("-eo")) {
      return { status: 0, stdout: "46680\tlanguage_server.exe --csrf_token tok", stderr: "" };
    }
    return { status: 0, stdout: "55027\n55026\n", stderr: "" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const method = url.slice(url.lastIndexOf("/") + 1);
    calls.push(method);
    const r = respond(method);
    return { ok: r.ok, status: r.status, text: async () => r.text };
  }) as unknown as typeof globalThis.fetch;

  return { run, fetchImpl, calls };
};

const answerWith = (doc: unknown) => (method: string) =>
  method === "GetCascadeTrajectory"
    ? { ok: true, status: 200, text: JSON.stringify(doc) }
    : { ok: true, status: 200, text: "{}" };

const noDaemon = (() => ({ status: 0, stdout: "", stderr: "" })) as never;

const turnsOf = (extId: string) =>
  h.hub
    .prepare(
      "select t.* from turns t join sessions s on s.id = t.session_id where s.ext_id = ? order by t.seq",
    )
    .all(extId) as TurnRow[];

describe("fetching one antigravity conversation", () => {
  beforeEach(async () => {
    writeSummaries(h.roots, [SUMMARY]);
    await antigravityCollector.sync(h.ctx);
  });

  it("brings back only the speech, out of a trajectory that is mostly not", async () => {
    const { run, fetchImpl, calls } = daemonRunning(
      answerWith(trajectory("Hol akad el a folyamat?", "Készítettem egy tervet.")),
    );
    const session = new DaemonSession({ run, fetchImpl });

    const outcome = await fetchConversation(h.hub, CID, { session, fetchImpl });
    expect(outcome).toEqual({ status: "fetched", turns: 2, steps: 3 });
    expect(calls).toContain("GetCascadeTrajectory");

    const hy = new Hydrator(h.hub);
    const texts = turnsOf(CID).map((t) => hy.resolve(t).text);
    hy.close();
    expect(texts).toEqual(["Hol akad el a folyamat?", "Készítettem egy tervet."]);
    expect(texts.join("\n")).not.toContain("belső gondolatmenet");
  });

  it("keeps the text, because there is no readable file to point at", async () => {
    const { run, fetchImpl } = daemonRunning(answerWith(trajectory("kérdés", "válasz")));
    await fetchConversation(h.hub, CID, { session: new DaemonSession({ run, fetchImpl }), fetchImpl });

    const rows = turnsOf(CID);
    expect(rows.every((r) => r.locator_kind === "inline")).toBe(true);
    // And it reads back without the daemon, which is the point of keeping it.
    const hy = new Hydrator(h.hub);
    expect(rows.map((r) => hy.resolve(r).status)).toEqual(["ok", "ok"]);
    hy.close();
  });

  it("asks once, then never again while the summary has not moved", async () => {
    const first = daemonRunning(answerWith(trajectory("kérdés", "válasz")));
    await fetchConversation(h.hub, CID, {
      session: new DaemonSession({ run: first.run, fetchImpl: first.fetchImpl }),
      fetchImpl: first.fetchImpl,
    });
    expect(bodyIsCurrent(h.hub, CID)).toBe(true);

    const second = daemonRunning(answerWith(trajectory("kérdés", "válasz")));
    const outcome = await fetchConversation(h.hub, CID, {
      session: new DaemonSession({ run: second.run, fetchImpl: second.fetchImpl }),
      fetchImpl: second.fetchImpl,
    });
    expect(outcome).toEqual({ status: "cached", turns: 2 });
    // A conversation is 5.2 MB on the reference machine. Not asking is the
    // whole point.
    expect(second.calls).toEqual([]);
  });

  it("asks again once the conversation has moved on", async () => {
    const first = daemonRunning(answerWith(trajectory("kérdés", "válasz")));
    await fetchConversation(h.hub, CID, {
      session: new DaemonSession({ run: first.run, fetchImpl: first.fetchImpl }),
      fetchImpl: first.fetchImpl,
    });

    // The summaries pass sees more steps and a later time.
    writeSummaries(h.roots, [{ ...SUMMARY, step_count: 140, last_modified_time: "2026-07-03 09:00:00.0000000+00:00" }]);
    await antigravityCollector.sync(h.ctx);
    expect(bodyIsCurrent(h.hub, CID)).toBe(false);

    const second = daemonRunning(answerWith(trajectory("kérdés", "új válasz")));
    const outcome = await fetchConversation(h.hub, CID, {
      session: new DaemonSession({ run: second.run, fetchImpl: second.fetchImpl }),
      fetchImpl: second.fetchImpl,
    });
    expect(outcome).toMatchObject({ status: "fetched" });

    const hy = new Hydrator(h.hub);
    const texts = turnsOf(CID).map((t) => hy.resolve(t).text);
    hy.close();
    // Replaced, not appended: two turns, and the new answer.
    expect(texts).toEqual(["kérdés", "új válasz"]);
  });

  it("says Antigravity is closed rather than treating it as a failure", async () => {
    const session = new DaemonSession({ run: noDaemon, fetchImpl: (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof globalThis.fetch });

    expect(await fetchConversation(h.hub, CID, { session })).toEqual({ status: "no-daemon" });
  });

  it("reports a daemon that answers with something else", async () => {
    const { run, fetchImpl } = daemonRunning(() => ({ ok: true, status: 200, text: '{"unexpected":true}' }));
    const outcome = await fetchConversation(h.hub, CID, {
      session: new DaemonSession({ run, fetchImpl }),
      fetchImpl,
    });
    expect(outcome).toMatchObject({ status: "failed" });
  });

  it("has nothing to fetch for a conversation the index never saw", async () => {
    const { run, fetchImpl } = daemonRunning(answerWith(trajectory("x", "y")));
    const outcome = await fetchConversation(h.hub, "dddddddd-9999-8888-7777-666666666666", {
      session: new DaemonSession({ run, fetchImpl }),
      fetchImpl,
    });
    expect(outcome).toEqual({ status: "not-found" });
  });
});
