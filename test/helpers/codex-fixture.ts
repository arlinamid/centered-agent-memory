import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ResolvedRoots } from "../../src/paths.js";
import { jline } from "./fixtures.js";

export interface ThreadFixture {
  id: string;
  cwd: string;
  title?: string | null;
  /** Literal ("exec", "vscode") or a raw JSON subagent descriptor. */
  source?: string;
  createdSec?: number;
  updatedSec?: number;
  rolloutPath?: string;
}

/**
 * Build a `state_5.sqlite` with the real DDL shape. Written at runtime rather
 * than committed so the fixture cannot drift from the code that reads it.
 */
export function writeCodexState(
  roots: ResolvedRoots,
  threads: ThreadFixture[],
  edges: Array<[parent: string, child: string]> = [],
): void {
  fs.mkdirSync(path.dirname(roots.codexStateDb), { recursive: true });
  fs.rmSync(roots.codexStateDb, { force: true });
  const db = new Database(roots.codexStateDb);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER,
      source TEXT, model_provider TEXT, cwd TEXT, title TEXT,
      sandbox_policy TEXT, approval_mode TEXT
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT, child_thread_id TEXT, status TEXT
    );
  `);
  const ins = db.prepare(
    "insert into threads(id, rollout_path, created_at, updated_at, source, cwd, title) values (?,?,?,?,?,?,?)",
  );
  for (const t of threads) {
    ins.run(
      t.id,
      t.rolloutPath ?? null,
      t.createdSec ?? 1_773_854_260,
      t.updatedSec ?? 1_773_859_265,
      t.source ?? "exec",
      t.cwd,
      t.title ?? null,
    );
  }
  const e = db.prepare("insert into thread_spawn_edges(parent_thread_id, child_thread_id, status) values (?,?,'done')");
  for (const [p, c] of edges) e.run(p, c);
  db.close();
}

/** A rollout file in the shape Codex actually writes. */
export function writeRollout(
  dir: string,
  name: string,
  opts: {
    id: string;
    /** Present and different from `id` for subagents — the parent's id. */
    sessionId?: string;
    cwd: string;
    parentThreadId?: string;
    turns: Array<{ role: "user" | "agent"; text: string; ts?: string }>;
    /** Extra noise that must never be indexed. */
    withResponseItems?: boolean;
  },
): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const records: unknown[] = [
    {
      timestamp: "2026-08-01T06:00:00.000Z",
      type: "session_meta",
      payload: {
        id: opts.id,
        session_id: opts.sessionId ?? opts.id,
        ...(opts.parentThreadId ? { parent_thread_id: opts.parentThreadId } : {}),
        timestamp: "2026-08-01T06:00:00.000Z",
        cwd: opts.cwd,
        originator: "Codex Desktop",
        cli_version: "0.118.0",
      },
    },
    { timestamp: "2026-08-01T06:00:01.000Z", type: "turn_context", payload: { cwd: opts.cwd, turn_id: "t1" } },
  ];

  let i = 0;
  for (const t of opts.turns) {
    const ts = t.ts ?? `2026-08-01T06:0${Math.min(9, ++i)}:00.000Z`;
    records.push({
      timestamp: ts,
      type: "event_msg",
      payload: { type: t.role === "user" ? "user_message" : "agent_message", message: t.text },
    });
    if (opts.withResponseItems) {
      records.push({
        timestamp: ts,
        type: "response_item",
        payload: { type: "message", role: "developer", content: [{ type: "input_text", text: t.text }] },
      });
    }
  }

  fs.writeFileSync(file, records.map(jline).join(""), "utf8");
  return file;
}
