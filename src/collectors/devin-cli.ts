import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/open.js";
import { normalizePath } from "../paths.js";
import { addTurns, clearSession, upsertSession, usableTitle, type TurnInput } from "../index/indexer.js";
import { KEY_SEP } from "../index/hydrate.js";
import { ensureSource, recordVersionSync } from "../index/watermarks.js";
import { replaceEvidence } from "../attribution/evidence.js";
import { emptyStat, type Collector, type CollectorCtx, type SyncStat } from "./types.js";

/**
 * Devin CLI sessions: `<appdata>/devin/cli/sessions.db`.
 *
 * The store keeps a FOREST per session, not a transcript. Every retry and every
 * edited prompt forks a new branch, and all of them stay in `message_nodes`, so
 * reading the table would index the same prompt once per abandoned attempt (on
 * the reference machine: four copies of one question). `sessions.main_chain_id`
 * names the leaf of the conversation as it now stands; walking its parents is
 * the only reading that matches what the user would see.
 */
export const devinCliCollector: Collector = {
  tool: "devin",
  name: "devin-cli",

  async sync(ctx: CollectorCtx): Promise<SyncStat> {
    const stat = emptyStat();
    const dbPath = path.join(ctx.roots.devinCliHome, "sessions.db");
    if (!fs.existsSync(dbPath)) {
      // A renamed store must surface as a warning, never as a quiet zero.
      if (fs.existsSync(ctx.roots.devinCliHome)) {
        ctx.log(`devin-cli: ${dbPath} not found — new Devin version with a different store name?`);
      }
      return stat;
    }

    let store: Db;
    try {
      store = ctx.openSource(dbPath);
    } catch (err) {
      stat.errors++;
      ctx.log(`devin-cli: sessions.db: ${(err as Error).message}`);
      return stat;
    }

    try {
      for (const row of readSessions(store)) {
        try {
          syncOne(ctx, store, dbPath, row, stat);
        } catch (err) {
          stat.errors++;
          ctx.log(`devin-cli: ${row.id}: ${(err as Error).message}`);
        }
      }
    } finally {
      store.close();
    }
    return stat;
  },
};

interface SessionRow {
  id: string;
  working_directory: string | null;
  title: string | null;
  main_chain_id: number | null;
  created_at: number | null;
  last_activity_at: number | null;
  workspace_dirs: string | null;
}

function readSessions(store: Db): SessionRow[] {
  return store
    .prepare(
      `select id, working_directory, title, main_chain_id, created_at, last_activity_at, workspace_dirs
       from sessions order by created_at`,
    )
    .all() as SessionRow[];
}

interface NodeRow {
  node_id: number;
  parent_node_id: number | null;
  created_at: number | null;
  chat_message: string;
}

/** Devin stores whole seconds; every other tool in the hub stores milliseconds. */
const secondsToMs = (s: number | null | undefined): number | null =>
  typeof s === "number" && Number.isFinite(s) ? Math.round(s * 1000) : null;

function syncOne(ctx: CollectorCtx, store: Db, dbPath: string, row: SessionRow, stat: SyncStat): void {
  const locator = `${dbPath}#session:${row.id}`;
  const source = ensureSource(ctx.hub, "devin", "sqlite_row", locator);

  const nodes = store
    .prepare(
      "select node_id, parent_node_id, created_at, chat_message from message_nodes where session_id = ? order by node_id",
    )
    .all(row.id) as NodeRow[];

  // There is no byte offset to watch, so the version is what the session says
  // about itself. The node count travels with it because a branch can be added
  // without `last_activity_at` moving.
  const version = (row.last_activity_at ?? 0) * 100000 + nodes.length;
  if (!ctx.repair && source.ext_version === version) {
    stat.skipped++;
    return;
  }

  const turns = buildTurns(dbPath, row, nodes);
  const workspaces = parseWorkspaceDirs(row.workspace_dirs);
  const title = usableTitle(row.title);

  const sessionId = upsertSession(ctx.hub, {
    tool: "devin",
    extId: row.id,
    sourceId: source.id,
    title,
    titleOrigin: title ? "devin-title" : null,
    cwdRaw: row.working_directory,
    cwdNorm: row.working_directory ? normalizePath(row.working_directory) : null,
    startedMs: secondsToMs(row.created_at),
    endedMs: secondsToMs(row.last_activity_at),
  });

  const tx = ctx.hub.transaction(() => {
    // A branch can be abandoned between two runs, which shortens the main
    // chain: the turns that are no longer part of the conversation have to go,
    // so the session is rebuilt rather than appended to.
    clearSession(ctx.hub, sessionId);
    stat.turns += addTurns(ctx.hub, sessionId, turns);
    if (row.working_directory) replaceEvidence(ctx.hub, sessionId, "cwd", [row.working_directory], 3);
    if (workspaces.length > 0) replaceEvidence(ctx.hub, sessionId, "workspace_dirs", workspaces, 3);
    recordVersionSync(ctx.hub, source.id, version, ctx.now());
  });
  tx();
  stat.sessions++;
}

/** `workspace_dirs` is a JSON array of paths, and is usually empty. */
function parseWorkspaceDirs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string" && p.length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * The main chain, oldest first.
 *
 * Walking up from the leaf and reversing is the whole algorithm; a node whose
 * parent is missing ends the walk rather than throwing, because a pruned
 * ancestor is a damaged store, not a crash. The visited set guards against a
 * cycle: this is a foreign store, and a loop here would hang the sync.
 */
function mainChain(nodes: ReadonlyArray<NodeRow>, leaf: number | null): NodeRow[] {
  const byId = new Map(nodes.map((n) => [n.node_id, n]));
  const chain: NodeRow[] = [];
  const seen = new Set<number>();
  let cur = leaf;
  while (cur !== null && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const node = byId.get(cur)!;
    chain.unshift(node);
    cur = node.parent_node_id;
  }
  return chain;
}

/**
 * Turn the main chain into turns.
 *
 * Only `user` and `assistant` are speech. A `system` record is the injected
 * environment — the working-directory dump, and the always-on rules block that
 * carries the contents of the user's own instruction files — and a `tool`
 * record is a tool result. Neither was said by anyone, and the rules block in
 * particular would put the same instructions into the index once per session.
 */
function buildTurns(dbPath: string, row: SessionRow, nodes: ReadonlyArray<NodeRow>): TurnInput[] {
  const out: TurnInput[] = [];
  let seq = 0;

  for (const node of mainChain(nodes, row.main_chain_id)) {
    let msg: { role?: unknown; content?: unknown };
    try {
      msg = JSON.parse(node.chat_message) as { role?: unknown; content?: unknown };
    } catch {
      continue; // one damaged row must not cost the whole conversation
    }
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = msg.content;
    // An assistant node can hold an empty string while a tool call runs.
    if (typeof text !== "string" || text.trim().length === 0) continue;

    out.push({
      seq: seq++,
      role: msg.role === "user" ? "user" : "assistant",
      tsMs: secondsToMs(node.created_at),
      text,
      locator: {
        kind: "sqlite_row",
        path: dbPath,
        table: "message_nodes",
        column: "chat_message",
        key: `${row.id}${KEY_SEP}${node.node_id}`,
        field: "content",
      },
    });
  }
  return out;
}
