import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ResolvedRoots } from "../../src/paths.js";

/**
 * The real DDL, copied from a live store. Built at runtime rather than
 * committed as a binary so the fixture cannot drift away from the reader.
 *
 * The store runs in WAL mode on the reference machine — with the WAL far larger
 * than the database file — so the fixture uses it too: a reader that cannot see
 * uncheckpointed content would pass every test here and find nothing in real
 * life.
 */
const DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  working_directory TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  title TEXT,
  main_chain_id INTEGER,
  shell_last_seen_index INTEGER DEFAULT 0,
  cogs_json TEXT,
  workspace_dirs TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  metadata TEXT
);
CREATE TABLE prompt_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  is_shell INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  parent_node_id INTEGER,
  chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, node_id)
);
CREATE INDEX idx_message_nodes_session ON message_nodes(session_id);
`;

export interface DevinSession {
  id: string;
  working_directory: string;
  title?: string | null;
  main_chain_id: number | null;
  created_at: number;
  last_activity_at: number;
  workspace_dirs?: string | null;
}

export interface DevinNode {
  node_id: number;
  parent_node_id: number | null;
  created_at: number;
  role: string;
  content: string;
  /** Written verbatim instead of the JSON envelope, to model a damaged row. */
  rawChatMessage?: string;
}

export function writeDevinStore(
  roots: ResolvedRoots,
  sessions: ReadonlyArray<DevinSession>,
  nodes: Readonly<Record<string, ReadonlyArray<DevinNode>>>,
): string {
  const file = path.join(roots.devinCliHome, "sessions.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });

  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(DDL);

  const insSession = db.prepare(
    `insert into sessions
       (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at,
        title, main_chain_id, workspace_dirs)
     values (?,?,'local','swe-1-6-slow','normal',?,?,?,?,?)`,
  );
  const insNode = db.prepare(
    "insert into message_nodes(session_id, node_id, parent_node_id, chat_message, created_at) values (?,?,?,?,?)",
  );

  for (const s of sessions) {
    insSession.run(
      s.id,
      s.working_directory,
      s.created_at,
      s.last_activity_at,
      s.title ?? null,
      s.main_chain_id,
      s.workspace_dirs ?? null,
    );
    for (const n of nodes[s.id] ?? []) {
      const message =
        n.rawChatMessage ??
        JSON.stringify({
          message_id: `${s.id}-${n.node_id}`,
          role: n.role,
          content: n.content,
          metadata: { is_user_input: n.role === "user" ? true : null },
        });
      insNode.run(s.id, n.node_id, n.parent_node_id, message, n.created_at);
    }
  }
  // Leave the WAL uncheckpointed: the reader has to cope with it.
  db.close();
  return file;
}

/**
 * A session whose main chain is one question and one answer, alongside an
 * abandoned branch holding a second copy of the same question — the shape that
 * makes reading the whole table wrong.
 */
export function branchedSession(id: string, cwd: string): { session: DevinSession; nodes: DevinNode[] } {
  const t = 1_788_087_400;
  return {
    session: {
      id,
      working_directory: cwd,
      title: "Miről szól ez a demo?",
      main_chain_id: 5,
      created_at: t - 30,
      last_activity_at: t + 20,
      workspace_dirs: "[]",
    },
    nodes: [
      { node_id: 0, parent_node_id: null, created_at: t, role: "system", content: "<system_info>cwd dump</system_info>" },
      { node_id: 1, parent_node_id: 0, created_at: t, role: "system", content: "<rules>a felhasználó szabályai</rules>" },
      { node_id: 2, parent_node_id: 1, created_at: t, role: "user", content: "Miről szól ez a demo?" },
      { node_id: 3, parent_node_id: 2, created_at: t + 5, role: "assistant", content: "" },
      { node_id: 4, parent_node_id: 3, created_at: t + 8, role: "tool", content: "{ files: 42 }" },
      { node_id: 5, parent_node_id: 4, created_at: t + 20, role: "assistant", content: "Ez egy árvíztűrő demo projekt." },
      // The abandoned branch: the same question asked again, then dropped.
      { node_id: 6, parent_node_id: 1, created_at: t + 1, role: "user", content: "Miről szól ez a demo?" },
      { node_id: 7, parent_node_id: 6, created_at: t + 2, role: "assistant", content: "Elvetett válasz." },
    ],
  };
}
