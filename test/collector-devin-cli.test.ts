import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { devinCliCollector } from "../src/collectors/devin-cli.js";
import { Hydrator, KEY_SEP, type TurnRow } from "../src/index/hydrate.js";
import { makeHarness, type Harness } from "./helpers/fixtures.js";
import { branchedSession, writeDevinStore, type DevinNode } from "./helpers/devin-fixture.js";

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.cleanup());

const SID = "demo-session";
const CWD = "D:\\tool\\centered-agent-memory";

const sync = () => devinCliCollector.sync(h.ctx);

const sessions = () =>
  h.hub.prepare("select * from sessions order by id").all() as Array<{
    id: number;
    ext_id: string;
    title: string | null;
    title_origin: string | null;
    cwd_raw: string | null;
    cwd_norm: string | null;
    turn_count: number;
    started_ms: number | null;
    ended_ms: number | null;
  }>;

const turnsOf = (sid: number) =>
  h.hub.prepare("select * from turns where session_id = ? order by seq").all(sid) as TurnRow[];

const writeBranched = () => {
  const { session, nodes } = branchedSession(SID, CWD);
  return writeDevinStore(h.roots, [session], { [SID]: nodes });
};

describe("devin cli collector", () => {
  it("reports nothing at all when Devin is not installed", async () => {
    fs.rmSync(h.roots.devinCliHome, { recursive: true, force: true });
    expect(await sync()).toEqual({ sessions: 0, turns: 0, skipped: 0, errors: 0 });
    expect(h.logs).toEqual([]);
  });

  it("says so out loud when the store is there under another name", async () => {
    // The directory exists but sessions.db does not: a renamed store, not an
    // absent tool. A quiet zero here is the failure worth catching.
    expect(await sync()).toEqual({ sessions: 0, turns: 0, skipped: 0, errors: 0 });
    expect(h.logs.join("\n")).toContain("not found");
  });

  it("follows the main chain and ignores abandoned branches", async () => {
    writeBranched();
    const stat = await sync();
    expect(stat).toMatchObject({ sessions: 1, turns: 2, errors: 0 });

    const s = sessions()[0]!;
    expect(s.ext_id).toBe(SID);
    const rows = turnsOf(s.id);
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);

    const hy = new Hydrator(h.hub);
    const texts = rows.map((r) => hy.resolve(r).text);
    hy.close();
    expect(texts).toEqual(["Miről szól ez a demo?", "Ez egy árvíztűrő demo projekt."]);
    // The dropped branch held a second copy of the same question and an answer
    // that was never part of the conversation.
    expect(texts).not.toContain("Elvetett válasz.");
    expect(texts.filter((t) => t === "Miről szól ez a demo?")).toHaveLength(1);
  });

  it("indexes speech only, never the injected environment", async () => {
    writeBranched();
    await sync();
    const hy = new Hydrator(h.hub);
    const all = turnsOf(sessions()[0]!.id)
      .map((r) => hy.resolve(r).text ?? "")
      .join("\n");
    hy.close();
    expect(all).not.toContain("system_info");
    expect(all).not.toContain("a felhasználó szabályai");
    expect(all).not.toContain("files: 42");
  });

  it("skips an assistant node that is still empty", async () => {
    writeBranched();
    await sync();
    // Node 3 is an empty assistant message written while a tool call runs.
    expect(turnsOf(sessions()[0]!.id)).toHaveLength(2);
  });

  it("addresses a turn by its row, and reads it back out of the live store", async () => {
    const file = writeBranched();
    await sync();

    const rows = turnsOf(sessions()[0]!.id);
    expect(rows[0]!.locator_kind).toBe("sqlite_row");
    expect(rows[0]!.loc_path).toBe(file);
    expect(rows[0]!.loc_table).toBe("message_nodes");
    expect(rows[0]!.loc_column).toBe("chat_message");
    expect(rows[0]!.loc_key).toBe(`${SID}${KEY_SEP}2`);
    expect(rows[0]!.loc_field).toBe("content");
    expect(rows.every((r) => r.inline_text === null)).toBe(true);

    const hy = new Hydrator(h.hub);
    for (const r of rows) expect(hy.resolve(r).status).toBe("ok");
    hy.close();
  });

  it("refuses a locator that names a table this build does not know", async () => {
    writeBranched();
    await sync();
    const row = turnsOf(sessions()[0]!.id)[0]!;
    h.hub.prepare("update turns set loc_table = 'sqlite_master' where id = ?").run(row.id);

    const hy = new Hydrator(h.hub);
    const again = turnsOf(sessions()[0]!.id)[0]!;
    // Unreadable, not executed: an unknown table is missing text, never SQL.
    expect(hy.resolve(again)).toEqual({ text: null, status: "missing" });
    hy.close();
  });

  it("takes the working directory straight from the session row", async () => {
    writeBranched();
    await sync();
    const s = sessions()[0]!;
    expect(s.cwd_raw).toBe(CWD);
    expect(s.cwd_norm).toBe("d:/tool/centered-agent-memory");
    expect(s.title).toBe("Miről szól ez a demo?");
    expect(s.title_origin).toBe("devin-title");
    // Seconds in the store, milliseconds in the hub.
    expect(s.started_ms).toBe(1_788_087_370_000);
    expect(s.ended_ms).toBe(1_788_087_420_000);

    const evidence = h.hub
      .prepare("select origin, raw_path, weight from path_evidence where session_id = ?")
      .all(s.id) as Array<{ origin: string; raw_path: string; weight: number }>;
    expect(evidence).toEqual([{ origin: "cwd", raw_path: CWD, weight: 3 }]);
  });

  it("skips a session that has not moved", async () => {
    writeBranched();
    await sync();
    expect(await sync()).toEqual({ sessions: 0, turns: 0, skipped: 1, errors: 0 });
  });

  it("notices a new branch even when last_activity_at stands still", async () => {
    const file = writeBranched();
    await sync();

    const db = new Database(file);
    db.prepare(
      "insert into message_nodes(session_id, node_id, parent_node_id, chat_message, created_at) values (?,?,?,?,?)",
    ).run(
      SID,
      8,
      5,
      JSON.stringify({ message_id: "x", role: "user", content: "És mi a következő lépés?" }),
      1_788_087_430,
    );
    db.prepare("update sessions set main_chain_id = 8 where id = ?").run(SID);
    db.close();

    const stat = await sync();
    expect(stat).toMatchObject({ sessions: 1, turns: 3, errors: 0 });
    const hy = new Hydrator(h.hub);
    expect(hy.resolve(turnsOf(sessions()[0]!.id)[2]!).text).toBe("És mi a következő lépés?");
    hy.close();
  });

  it("drops turns that a shortened main chain no longer contains", async () => {
    const file = writeBranched();
    await sync();
    expect(turnsOf(sessions()[0]!.id)).toHaveLength(2);

    // The user reverts to before the answer: the chain now ends at the question.
    const db = new Database(file);
    db.prepare("update sessions set main_chain_id = 2, last_activity_at = ? where id = ?").run(1_788_087_500, SID);
    db.close();

    await sync();
    const rows = turnsOf(sessions()[0]!.id);
    expect(rows).toHaveLength(1);
    expect(sessions()[0]!.turn_count).toBe(1);
  });

  it("keeps the conversation when one row is damaged", async () => {
    const { session, nodes } = branchedSession(SID, CWD);
    const damaged: DevinNode[] = nodes.map((n) =>
      n.node_id === 2 ? { ...n, rawChatMessage: "{ not json" } : n,
    );
    writeDevinStore(h.roots, [session], { [SID]: damaged });

    const stat = await sync();
    expect(stat).toMatchObject({ sessions: 1, turns: 1, errors: 0 });
    const hy = new Hydrator(h.hub);
    expect(hy.resolve(turnsOf(sessions()[0]!.id)[0]!).text).toBe("Ez egy árvíztűrő demo projekt.");
    hy.close();
  });

  it("survives a session whose chain loops back on itself", async () => {
    const { session, nodes } = branchedSession(SID, CWD);
    const looped = nodes.map((n) => (n.node_id === 0 ? { ...n, parent_node_id: 5 } : n));
    writeDevinStore(h.roots, [session], { [SID]: looped });
    // A cycle in a foreign store must end the walk, not hang the sync.
    expect(await sync()).toMatchObject({ sessions: 1, errors: 0 });
  });

  it("reads a turn that is still only in the WAL of a running Devin", async () => {
    const file = writeBranched();
    await sync();

    // Devin is open and holding the store: its writes sit in an uncheckpointed
    // WAL. A reader that only looked at the database file would report the
    // conversation as it was an hour ago and never say anything was wrong.
    const live = new Database(file);
    live.pragma("journal_mode = WAL");
    live.prepare(
      "insert into message_nodes(session_id, node_id, parent_node_id, chat_message, created_at) values (?,?,?,?,?)",
    ).run(
      SID,
      9,
      5,
      JSON.stringify({ message_id: "y", role: "user", content: "Ez még csak a WAL-ban van." }),
      1_788_087_440,
    );
    live.prepare("update sessions set main_chain_id = 9, last_activity_at = ? where id = ?").run(1_788_087_440, SID);
    try {
      expect(fs.statSync(file + "-wal").size).toBeGreaterThan(0);
      expect(await sync()).toMatchObject({ sessions: 1, turns: 3, errors: 0 });
      const hy = new Hydrator(h.hub);
      expect(hy.resolve(turnsOf(sessions()[0]!.id)[2]!).text).toBe("Ez még csak a WAL-ban van.");
      hy.close();
    } finally {
      live.close();
    }
  });

  it("records paths from workspace_dirs as their own evidence", async () => {
    const { session, nodes } = branchedSession(SID, CWD);
    writeDevinStore(
      h.roots,
      [{ ...session, workspace_dirs: JSON.stringify([CWD, "D:\\work\\other"]) }],
      { [SID]: nodes },
    );
    await sync();

    const origins = h.hub
      .prepare("select origin, count(*) c from path_evidence group by origin order by origin")
      .all() as Array<{ origin: string; c: number }>;
    expect(origins).toEqual([
      { origin: "cwd", c: 1 },
      { origin: "workspace_dirs", c: 2 },
    ]);
  });

  it("counts an unreadable store instead of throwing", async () => {
    const file = path.join(h.roots.devinCliHome, "sessions.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "this is not a database", "utf8");

    const stat = await sync();
    expect(stat.errors).toBe(1);
    expect(stat.sessions).toBe(0);
  });
});
